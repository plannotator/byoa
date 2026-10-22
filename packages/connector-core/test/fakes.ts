// Test doubles: an in-memory FilePort, a fake network of fake apps (the BYOA
// doors per SPEC plus an MCP server), a fake host with scripted busy/idle and
// turn events, and a scripted clock. No real sleeps and no sockets: a held
// poll is a promise the fake app resolves when a command arrives, a newer
// poll supersedes it, or the test releases it.
import { Connector } from "../src/connector.ts";
import type { Display, HostAdapter, HostSession, SessionHandle } from "../src/host.ts";
import type { FilePort, HttpPort, HttpRequest, HttpResponse } from "../src/ports.ts";
import type { Command, MessageCommand, MessageEvent, PollRequest, RegisterRequest, SessionSetting, Workspace } from "../src/protocol.ts";

export const HOME = "/home/dana";

// ── files ───────────────────────────────────────────────────────────────────

export class MemoryFiles implements FilePort {
	readonly files = new Map<string, { text: string; mode: number }>();
	readonly dirs = new Map<string, number>();

	async read(path: string) {
		const f = this.files.get(path);
		return f === undefined ? null : { ...f };
	}
	async writePrivate(path: string, text: string) {
		let dir = path.slice(0, path.lastIndexOf("/"));
		while (dir !== "" && !this.dirs.has(dir)) {
			this.dirs.set(dir, 0o700);
			dir = dir.slice(0, dir.lastIndexOf("/"));
		}
		this.dirs.set(path.slice(0, path.lastIndexOf("/")), 0o700);
		this.files.set(path, { text, mode: 0o600 });
	}
	async remove(path: string) {
		this.files.delete(path);
	}
	async list(dir: string) {
		const names = new Set<string>();
		for (const p of [...this.files.keys(), ...this.dirs.keys()])
			if (p.startsWith(`${dir}/`)) names.add(p.slice(dir.length + 1).split("/")[0] as string);
		return [...names];
	}
	/** As a person would write it with an editor. */
	put(path: string, text: string, mode = 0o644) {
		this.files.set(path, { text, mode });
	}
	chmod(path: string, mode: number) {
		const f = this.files.get(path);
		if (f) f.mode = mode;
	}
}

// ── network ─────────────────────────────────────────────────────────────────

export interface Sent {
	url: string;
	method: string;
	auth: string | null;
	body: unknown;
}

export class FakeNet {
	readonly apps = new Map<string, FakeApp>();
	readonly sent: Sent[] = [];
	readonly http: HttpPort = async (req: HttpRequest): Promise<HttpResponse> => {
		const url = new URL(req.url);
		this.sent.push({ url: req.url, method: req.method, auth: req.headers.authorization ?? null, body: req.body ? JSON.parse(req.body) : null });
		const app = this.apps.get(url.origin);
		if (app === undefined || app.down) throw new Error("connect ECONNREFUSED");
		return app.handle(req, url);
	};
	add(app: FakeApp): FakeApp {
		this.apps.set(app.origin, app);
		return app;
	}
	/** Requests to `origin` (optionally only paths ending with `suffix`). */
	to(origin: string, suffix = ""): Sent[] {
		return this.sent.filter((s) => s.url.startsWith(origin) && new URL(s.url).pathname.endsWith(suffix));
	}
}

interface FakeSession {
	id: string;
	token: string;
	register: RegisterRequest;
	queue: Command[];
	held: ((r: HttpResponse) => void) | null;
	polls: PollRequest[];
	events: MessageEvent[];
	nextSeq: Map<string, number>;
}

export interface FakeAppOptions {
	id: string;
	name?: string;
	origin: string;
	pollHold?: number;
	pollInterval?: number;
	requires?: string[];
	mcp?: boolean;
	/** The app approves the pairing before the first pair_poll (a local app). */
	approveAtOnce?: boolean;
	displayName?: string;
	/** MCP needs initialize first and answers with SSE bodies. */
	mcpSession?: boolean;
	tools?: { name: string; description: string; inputSchema: Record<string, unknown> }[];
	/** Discovery overrides, to break it on purpose. */
	discovery?: (doc: Record<string, unknown>) => Record<string, unknown>;
}

export class FakeApp {
	readonly o: FakeAppOptions;
	readonly origin: string;
	down = false;
	readonly sessions = new Map<string, FakeSession>();
	readonly tokens = new Set<string>();
	readonly revoked = new Set<string>();
	/** pair_poll answers to give before the pairing's own state. */
	readonly pollScript: { status: number; body: unknown }[] = [];
	readonly pairings = new Map<string, { userCode: string; state: "pending" | "approved" | "denied" | "collected" }>();
	readonly toolCalls: { name: string; arguments: unknown; meta: unknown; auth: string | null }[] = [];
	mcpSessionId: string | null = null;
	startLink: ((link: string) => string) | null = null;
	#n = 0;

	constructor(o: FakeAppOptions) {
		this.o = o;
		this.origin = o.origin;
	}

	get name(): string {
		return this.o.name ?? this.o.id;
	}

	/** The one live session (tests with one), or by host session id. */
	session(hostSessionId?: string): FakeSession {
		const all = [...this.sessions.values()].filter((s) => hostSessionId === undefined || s.register.host_session_id === hostSessionId);
		const s = all[all.length - 1];
		if (s === undefined) throw new Error(`${this.o.id}: no session`);
		return s;
	}

	send(command: Partial<MessageCommand> & { message_id: string }, hostSessionId?: string): void {
		const msg: MessageCommand = { type: "message", kind: "chat", from: { display_name: "Dana" }, text: "hello", interrupt_first: false, stream: true, ...command };
		this.#offer(this.session(hostSessionId), msg);
	}

	interrupt(messageId: string, hostSessionId?: string): void {
		this.#offer(this.session(hostSessionId), { type: "interrupt", message_id: messageId });
	}

	/** A restart forgets every session; held polls answer 404. */
	restart(): void {
		const old = [...this.sessions.values()];
		this.sessions.clear();
		for (const s of old) s.held?.(json(404, { error: "session_not_found" }));
	}

	revokeAll(): void {
		for (const t of this.tokens) this.revoked.add(t);
		for (const s of this.sessions.values()) {
			s.held?.(json(401, { error: "unauthorized" }));
			s.held = null;
		}
	}

	approve(): void {
		for (const p of this.pairings.values()) if (p.state === "pending") p.state = "approved";
	}

	deny(): void {
		for (const p of this.pairings.values()) if (p.state === "pending") p.state = "denied";
	}

	/** The app's own record of a message's events, as types. */
	eventsOf(messageId: string, hostSessionId?: string): string[] {
		return this.session(hostSessionId)
			.events.filter((e) => e.message_id === messageId)
			.map((e) => (e.type === "delta" ? `delta:${e.text}` : e.type === "tool" ? `tool:${e.name}` : "reason" in e && e.reason ? `${e.type}:${e.reason}` : e.type));
	}

	#offer(s: FakeSession, command: Command): void {
		s.queue.push(command);
		if (s.held) {
			const release = s.held;
			s.held = null;
			release(json(200, { commands: s.queue.splice(0) }));
		}
	}

	discoveryDoc(): Record<string, unknown> {
		const doc: Record<string, unknown> = {
			byoa: "0.1",
			app: { id: this.o.id, name: this.name, origin: this.origin },
			endpoints: {
				pair_start: "/byoa/pair/start",
				pair_poll: "/byoa/pair/poll",
				verification_uri: "/byoa/connect",
				revoke: "/byoa/revoke",
				sessions: "/byoa/sessions",
				...(this.o.mcp ? { mcp: "/mcp" } : {}),
			},
			poll_hold_seconds: this.o.pollHold ?? 20,
			...(this.o.pollInterval !== undefined ? { poll_interval_seconds: this.o.pollInterval } : {}),
			accepts: { interrupt: true, stream: true, settings: ["model"] },
			...(this.o.requires ? { requires: { workspace: this.o.requires } } : {}),
		};
		return this.o.discovery ? this.o.discovery(doc) : doc;
	}

	async handle(req: HttpRequest, url: URL): Promise<HttpResponse> {
		const path = url.pathname;
		const body = req.body ? JSON.parse(req.body) : {};
		if (path === "/.well-known/byoa") return json(200, this.discoveryDoc());
		if (path === "/byoa/pair/start") {
			const code = `dc_${++this.#n}`;
			const userCode = "BCDF-GHJK";
			this.pairings.set(code, { userCode, state: this.o.approveAtOnce ? "approved" : "pending" });
			const link = `${this.origin}/byoa/connect?code=${userCode}`;
			return json(200, {
				device_code: code,
				user_code: userCode,
				verification_uri: `${this.origin}/byoa/connect`,
				verification_uri_complete: this.startLink ? this.startLink(link) : link,
				expires_in: 600,
				interval: 2,
			});
		}
		if (path === "/byoa/pair/poll") {
			const scripted = this.pollScript.shift();
			if (scripted) return json(scripted.status, scripted.body);
			const p = this.pairings.get(body.device_code);
			if (!p) return json(400, { error: "expired_token" });
			if (p.state === "pending") return json(400, { error: "authorization_pending" });
			if (p.state === "denied") return json(400, { error: "access_denied" });
			if (p.state === "collected") return json(400, { error: "expired_token" });
			p.state = "collected";
			const token = `tok_${this.o.id}_${++this.#n}`;
			this.tokens.add(token);
			return json(200, { access_token: token, token_type: "bearer", connection_id: `conn_${this.#n}`, account: { display_name: this.o.displayName ?? "Dana" } });
		}
		const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
		if (!this.tokens.has(token) || this.revoked.has(token)) return json(401, { error: "unauthorized" });
		if (path === "/byoa/revoke") {
			this.revokeAll();
			return json(204);
		}
		if (path === "/mcp") return this.#mcp(req, body);
		if (path === "/byoa/sessions") {
			const id = `ses_${token}_${body.host_session_id}`;
			const existing = this.sessions.get(id);
			if (existing) existing.register = body;
			else this.sessions.set(id, { id, token, register: body, queue: [], held: null, polls: [], events: [], nextSeq: new Map() });
			return json(200, { session: { id }, poll_hold_seconds: this.o.pollHold ?? 20, minimum_connector_version: "0.1.0" });
		}
		const m = /^\/byoa\/sessions\/([^/]+)\/(poll|events)$/.exec(path);
		const s = m ? this.sessions.get(decodeURIComponent(m[1] as string)) : undefined;
		if (!m || !s) return json(404, { error: "session_not_found" });
		if (m[2] === "poll") {
			s.polls.push(body);
			// One held poll per session: the newer answers the older with [].
			const older = s.held;
			s.held = null;
			older?.(json(200, { commands: [] }));
			if (s.queue.length > 0 || (this.o.pollHold ?? 20) === 0) return json(200, { commands: s.queue.splice(0) });
			return new Promise((resolve) => (s.held = resolve));
		}
		for (const e of body.events as MessageEvent[]) {
			const next = s.nextSeq.get(e.message_id) ?? 0;
			if (e.seq < next) continue;
			if (e.seq > next) return json(422, { error: "seq_gap", message_id: e.message_id, expected: next });
			s.nextSeq.set(e.message_id, next + 1);
			s.events.push(e);
		}
		return json(204);
	}

	/** Pretend the app lost a message's events from `seq` on. */
	forgetFrom(messageId: string, seq: number): void {
		const s = this.session();
		s.nextSeq.set(messageId, seq);
		s.events = s.events.filter((e) => e.message_id !== messageId || e.seq < seq);
	}

	#mcp(req: HttpRequest, body: Record<string, unknown>): HttpResponse {
		const reply = (result: unknown, headers: Record<string, string> = {}) => {
			const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
			return this.o.mcpSession
				? { status: 200, text: `event: message\ndata: ${msg}\n\n`, headers: { "content-type": "text/event-stream", ...headers } }
				: { status: 200, text: msg, headers: { "content-type": "application/json", ...headers } };
		};
		if (body.method === "initialize") {
			this.mcpSessionId = "mcp-s-1";
			return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: this.o.id } }, { "mcp-session-id": "mcp-s-1" });
		}
		if (body.method === "notifications/initialized") return { status: 202, text: "", headers: {} };
		if (this.o.mcpSession && req.headers["mcp-session-id"] !== this.mcpSessionId)
			return json(400, { jsonrpc: "2.0", id: body.id ?? null, error: { code: -32000, message: "Bad Request: Server not initialized" } });
		if (body.method === "tools/list") return reply({ tools: this.o.tools ?? [] });
		if (body.method === "tools/call") {
			const params = body.params as { name: string; arguments: unknown; _meta: unknown };
			this.toolCalls.push({ name: params.name, arguments: params.arguments, meta: params._meta, auth: req.headers.authorization ?? null });
			return reply({ content: [{ type: "text", text: `${this.o.id} did ${params.name}` }] });
		}
		return json(400, { error: "unknown" });
	}
}

export function json(status: number, body?: unknown): HttpResponse {
	return { status, text: body === undefined ? "" : JSON.stringify(body), headers: { "content-type": "application/json" } };
}

// ── host ────────────────────────────────────────────────────────────────────

export class FakeHost implements HostAdapter {
	readonly host: string;
	constructor(host = "claude-code") {
		this.host = host;
	}
	readonly hostVersion = "2.1.306";
	readonly machineName = "dana-mbp";
	interactive = true;
	readonly displays: Display[] = [];
	isInteractive() {
		return this.interactive;
	}
	display(d: Display) {
		this.displays.push(d);
	}
	get toasts(): string[] {
		return this.displays.flatMap((d) => (d.toast ? [d.toast.text] : []));
	}
}

export class FakeSessionHost implements HostSession {
	id: string | null = "host-session-1";
	isBusy = false;
	isBlocked = false;
	readonly submitted: string[] = [];
	readonly applied: string[] = [];
	readonly order: string[] = [];
	aborts = 0;
	settingsList: SessionSetting[] = [{ id: "model", name: "Model", value: null, choices: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] }];
	ws: Workspace = { folder_name: "northstar", path: "/home/dana/code/northstar", git_remote: "github.com/acme/northstar", branch: "main" };
	failSubmit = false;
	hostSessionId() {
		return this.id;
	}
	workspace() {
		return this.ws;
	}
	busy() {
		return this.isBusy;
	}
	blocked() {
		return this.isBlocked;
	}
	async submit(text: string) {
		if (this.failSubmit) throw new Error("the host refused");
		this.submitted.push(text);
		this.order.push(`submit:${text.split("\n")[0]}`);
	}
	async abort() {
		this.aborts += 1;
	}
	settings() {
		return this.settingsList;
	}
	async applySetting(id: string, value: string) {
		this.applied.push(`${id}=${value}`);
		this.order.push(`set:${id}=${value}`);
	}
}

// ── a world ─────────────────────────────────────────────────────────────────

export const flush = async (rounds = 30) => {
	for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

export interface World {
	clock: { t: number };
	files: MemoryFiles;
	net: FakeNet;
	host: FakeHost;
	connector: Connector;
	session: FakeSessionHost;
	handle: SessionHandle;
	tick: (n?: number) => Promise<void>;
	advance: (ms: number) => void;
}

/** A started connector with one attached session; `apps` are on the
 * network and, unless `pair: false`, already connected. */
export async function world(apps: FakeAppOptions[] = [], opts: { pair?: boolean; net?: FakeNet; files?: MemoryFiles; clock?: { t: number }; attach?: boolean; host?: string } = {}): Promise<World> {
	const clock = opts.clock ?? { t: Date.parse("2026-10-21T14:00:00Z") };
	const files = opts.files ?? new MemoryFiles();
	const net = opts.net ?? new FakeNet();
	for (const a of apps) if (!net.apps.has(a.origin)) net.add(new FakeApp(a));
	const host = new FakeHost(opts.host);
	const connector = new Connector({ host, http: net.http, files, now: () => clock.t, home: HOME, random: () => 0.5 });
	if (opts.pair !== false) {
		// Pair through the real flow, with apps that approve at once.
		// Credentials are per host, so pair as the host the test runs.
		const setup = new Connector({ host: new FakeHost(opts.host), http: net.http, files, now: () => clock.t, home: HOME, random: () => 0.5 });
		await setup.start();
		for (const a of apps) {
			const app = net.apps.get(a.origin) as FakeApp;
			if (app.tokens.size > 0) continue;
			const was = app.o.approveAtOnce;
			app.o.approveAtOnce = true;
			await setup.connect(a.origin);
			app.o.approveAtOnce = was;
		}
	}
	await connector.start();
	const session = new FakeSessionHost();
	const handle = opts.attach === false ? (null as unknown as SessionHandle) : connector.attach(session);
	const w: World = {
		clock,
		files,
		net,
		host,
		connector,
		session,
		handle,
		advance: (ms) => (clock.t += ms),
		tick: async (n = 1) => {
			for (let i = 0; i < n; i++) {
				clock.t += 1000;
				await connector.tick();
				await flush();
			}
		},
	};
	await flush();
	return w;
}

export function app(net: FakeNet, origin: string): FakeApp {
	return net.apps.get(origin) as FakeApp;
}

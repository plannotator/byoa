// What a test needs to run the real connector against a real app with no
// agent: a fake host and session, an in-memory FilePort, an HttpPort over
// any fetch-like function (a Worker's SELF.fetch, or an app's handler
// wrapped as one), a scripted or real clock, and a helper that pairs through
// the approval page. Published as @plannotator/byoa-connector-core/testing.
// It keeps the core's rules (no Node, no timers, no globals beyond the
// language, URL and JSON), so it runs in workerd too. The Claude Code mod
// does not copy it (connectors/claude-code/scripts/sync-core.mjs).

import type { Connector } from "./connector.ts";
import type { Display, HostAdapter, HostSession, SessionHandle } from "./host.ts";
import type { Clock, FilePort, HttpPort, HttpRequest, HttpResponse } from "./ports.ts";
import type { HostId, SessionSetting, Workspace } from "./protocol.ts";

/** The fake person's home folder. */
export const HOME = "/home/dana";

// ── files ───────────────────────────────────────────────────────────────────

/** A FilePort in memory. It keeps each file's and folder's permission bits,
 * so a test can check that credentials are written 0600 in a 0700 folder. */
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

/** The part of a fetch Response the port reads. */
export interface FetchLikeResponse {
	status: number;
	url?: string;
	headers: { forEach(fn: (value: string, name: string) => void): void };
	text(): Promise<string>;
}

/** The part of fetch the port calls. A Worker's `SELF.fetch` fits, and so
 * does an app's handler wrapped as
 * `(url, init) => byoa.handle(new Request(url, init)).then((r) => r ?? new Response(null, { status: 404 }))`. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: "manual" }) => Promise<FetchLikeResponse>;

/** An HttpPort over a fetch-like function. It never follows a redirect,
 * as the port contract requires, and passes any status through. */
export function fetchHttp(send: FetchLike): HttpPort {
	return async (req: HttpRequest): Promise<HttpResponse> => {
		const res = await send(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}), redirect: "manual" });
		const headers: Record<string, string> = {};
		res.headers.forEach((value, name) => {
			headers[name.toLowerCase()] = value;
		});
		return { status: res.status, text: await res.text(), headers, ...(res.url ? { url: res.url } : {}) };
	};
}

// ── clocks ──────────────────────────────────────────────────────────────────

/** Time that moves only when the test says so. Pass `clock.now` as the
 * connector's `now`. */
export class ScriptedClock {
	t: number;
	constructor(start = Date.parse("2026-10-21T14:00:00Z")) {
		this.t = start;
	}
	readonly now: Clock = () => this.t;
	advance(ms: number): void {
		this.t += ms;
	}
}

/** Wall-clock time, for a test that runs on real time. */
export const realClock: Clock = () => Date.now();

// ── host ────────────────────────────────────────────────────────────────────

/** One fake host process. Everything it is asked to draw lands in `displays`. */
export class FakeHost implements HostAdapter {
	readonly host: HostId;
	constructor(host: HostId = "claude-code") {
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

/**
 * One fake host conversation. Set `isBusy` and `isBlocked` to report its
 * state; `submitted` collects every prompt the connector starts. After
 * `attachTo(connector)` it can also play the host's side of a turn:
 * `startTurn()` the last prompt, then `text()`, `tool()`, and `end()`, or
 * `takeOver()` for a prompt the person typed into it. `aborts` counts the
 * connector's Stops; the host still ends the turn itself with
 * `end("interrupted")`.
 */
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
	/** Set by `attachTo`. */
	handle: SessionHandle | null = null;

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

	/** Attach to the connector and keep the handle for the turn helpers. */
	attachTo(connector: Pick<Connector, "attach">): SessionHandle {
		this.handle = connector.attach(this);
		return this.handle;
	}
	/** A turn begins with `prompt` (default: the last one the connector
	 * submitted) and the session turns busy. True when it is the connector's. */
	startTurn(prompt = this.submitted[this.submitted.length - 1] ?? ""): boolean {
		this.isBusy = true;
		return this.#handle().turnStarted(prompt);
	}
	/** Answer text of the running turn. */
	text(text: string): void {
		this.#handle().delta(text);
	}
	/** A tool step of the running turn. */
	tool(name: string, title?: string): void {
		this.#handle().tool(name, title);
	}
	/** The running turn ends and the session turns idle. */
	end(outcome: "done" | "error" | "interrupted" = "done", reason?: string): void {
		this.isBusy = false;
		this.#handle().turnEnded(outcome, reason);
	}
	/** The person types `prompt` into the running turn: it is taken over. */
	takeOver(prompt = "a prompt the person typed"): void {
		this.#handle().foreignPrompt(prompt);
		this.#handle().takenOver();
	}
	#handle(): SessionHandle {
		if (this.handle === null) throw new Error("FakeSessionHost: call attachTo(connector) first");
		return this.handle;
	}
}

// ── pairing ─────────────────────────────────────────────────────────────────

export interface PairByPageOptions {
	connector: Connector;
	/** The app's origin. */
	origin: string;
	/** Reaches the app, as the person's browser would. */
	request: FetchLike;
	/** What makes the app see a signed-in person, such as `{ cookie: "session=..." }`.
	 * `origin` is added to the POST. */
	headers: Record<string, string>;
	/** Moves the world one tick: advance the clock, `connector.tick()`, and
	 * let requests in flight finish. */
	step: () => Promise<void>;
	/** Default 30. */
	maxSteps?: number;
}

/** Pairs the connector with the app through the real approval page:
 * `connect`, open the page with the code it shows, press Connect with the
 * page's CSRF token, then step until the connector says it is connected.
 * Returns the connector's final status text. */
export async function pairByPage(o: PairByPageOptions): Promise<string> {
	const said = await o.connector.connect(o.origin);
	const code = /[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}/.exec(said)?.[0];
	if (code === undefined) throw new Error(`pairByPage: the connector showed no code: ${said}`);
	const page = await o.request(`${o.origin}/byoa/connect?code=${code}`, { method: "GET", headers: { ...o.headers }, redirect: "manual" });
	const html = await page.text();
	const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
	if (page.status !== 200 || csrf === undefined) throw new Error(`pairByPage: no consent page (HTTP ${page.status})`);
	const form = `code=${encodeURIComponent(code)}&csrf=${encodeURIComponent(csrf)}&decision=connect`;
	const decided = await o.request(`${o.origin}/byoa/connect`, {
		method: "POST",
		headers: { ...o.headers, origin: o.origin, "content-type": "application/x-www-form-urlencoded" },
		body: form,
		redirect: "manual",
	});
	if (decided.status !== 200) throw new Error(`pairByPage: Connect answered HTTP ${decided.status}`);
	const max = o.maxSteps ?? 30;
	for (let i = 0; i < max; i++) {
		const status = await o.connector.status();
		if (status.includes(`(${o.origin}) · connected as `)) return status;
		await o.step();
		await o.connector.settled();
	}
	throw new Error(`pairByPage: not connected after ${max} steps: ${await o.connector.status()}`);
}

// One attached host session: its turn scheduler (turns.ts), one door client
// per connected app (link.ts), and its proxied tools (tools.ts), wired
// together. It is what `connector.attach()` returns to the adapter.
//   - The host session id is re-read every tick. A change (`/clear`, resume)
//     retires everything: messages end (turns.ts), the old links post what
//     they owe and stop, and every app gets a new registration.
//   - Each app is registered only with the workspace fields the person
//     shares with it. An app that requires a withheld field is not
//     registered, and status says so.
//   - The poll body carries the state the scheduler sees, `idle_since`, and
//     the settings when they differ from those registered.

import { shown } from "./clean.ts";
import type { AppDiscovery } from "./discovery.ts";
import type { HostAdapter, HostSession, ProxiedTool, SessionHandle } from "./host.ts";
import { Link, type LinkState } from "./link.ts";
import { McpClient, type McpTool } from "./mcp.ts";
import type { Clock, HttpPort } from "./ports.ts";
import { META, type Command, type PollRequest, type RegisterRequest, type SessionSetting } from "./protocol.ts";
import { sharedWorkspace, withheld, type Sharing } from "./sharing.ts";
import { text } from "./status.ts";
import { buildToolDefinition, toolCall } from "./tools.ts";
import { Turns } from "./turns.ts";
import { CONNECTOR_VERSION } from "./version.ts";

/** A connected app as a session sees it. */
export interface ConnectedApp {
	id: string;
	name: string;
	origin: string;
	token: string;
	discovery: AppDiscovery;
}

export interface SessionContext {
	host: HostAdapter;
	http: HttpPort;
	now: Clock;
	random: () => number;
	/** The apps a session may use now (connected, not revoked). */
	apps: () => readonly ConnectedApp[];
	sharing: () => Sharing;
	onRevoked: (appId: string) => void;
	warn: (message: string) => void;
}

export class AttachedSession implements SessionHandle {
	readonly #c: SessionContext;
	readonly #host: HostSession;
	#id: string | null = null;
	#startedAt = "";
	#turns: Turns;
	readonly #links = new Map<string, Link>();
	/** Why an app is not registered with this session. */
	readonly #notes = new Map<string, string>();
	/** The settings as registered with each app (JSON), for the poll body. */
	readonly #registeredSettings = new Map<string, string>();
	readonly #retiring = new Set<Link>();
	#lastState = "";
	#idleSince = "";
	#tools: Promise<ProxiedTool[]> | null = null;
	#detached = false;

	constructor(context: SessionContext, host: HostSession) {
		this.#c = context;
		this.#host = host;
		this.#turns = this.#newTurns();
	}

	get detached(): boolean {
		return this.#detached && this.#retiring.size === 0;
	}

	/** From the connector's tick. */
	tick(): void {
		if (!this.#detached) {
			const id = this.#host.hostSessionId();
			if (id !== this.#id) {
				this.#retireAll();
				this.#id = id;
				this.#startedAt = new Date(this.#c.now()).toISOString();
				this.#turns = this.#newTurns();
			}
			if (this.#id !== null) {
				const state = this.#turns.state;
				if (state !== this.#lastState) {
					if (state === "ready") this.#idleSince = new Date(this.#c.now()).toISOString();
					this.#lastState = state;
				}
				this.#turns.tick();
				this.#syncLinks();
				for (const link of this.#links.values()) link.tick();
			}
		}
		for (const link of this.#retiring) {
			link.tick();
			if (link.done) this.#retiring.delete(link);
		}
	}

	/** One line for status, per app id. */
	describe(appId: string): string | null {
		const note = this.#notes.get(appId);
		if (note !== undefined) return text.sessionLine(`not registered (${note})`);
		const link = this.#links.get(appId);
		if (link === undefined) return null;
		const s = link.state;
		if (s.kind === "live")
			return text.sessionLine(
				`registered${link.contended ? "; its polls are answered at once, as when the same session is open in another terminal too, so it polls less often" : ""}${s.updateNeeded ? "; the app asks for a newer connector" : ""}`,
			);
		if (s.kind === "registering") return text.sessionLine("registering");
		if (s.kind === "retrying") return text.sessionLine(`cannot reach the app (${shown(s.message)}), retrying`);
		if (s.kind === "refused") return text.sessionLine(`refused by the app (${shown(s.message)})`);
		return null;
	}

	/** The app was disconnected or revoked: stop its link now, forget its
	 * messages, post nothing more with its token. */
	dropApp(appId: string): void {
		this.#links.get(appId)?.stop();
		this.#links.delete(appId);
		this.#turns.forgetApp(appId);
	}

	// ── SessionHandle ──────────────────────────────────────────────────────

	turnStarted(prompt: string): boolean {
		return this.#turns.turnStarted(prompt);
	}
	delta(t: string): void {
		this.#turns.delta(t);
	}
	tool(name: string, title?: string): void {
		this.#turns.tool(name, title);
	}
	turnEnded(outcome: "done" | "error" | "interrupted", reason?: string): void {
		this.#turns.turnEnded(outcome, reason);
	}
	foreignPrompt(prompt?: string): boolean {
		return this.#turns.foreignPrompt(prompt);
	}
	takenOver(): void {
		this.#turns.takenOver();
	}
	isOurs(prompt: string): boolean {
		return this.#turns.isOurs(prompt);
	}
	detach(): void {
		if (this.#detached) return;
		this.#retireAll();
		this.#detached = true;
	}
	tools(): Promise<ProxiedTool[]> {
		this.#tools ??= this.#buildTools();
		return this.#tools;
	}

	// ── inside ─────────────────────────────────────────────────────────────

	#newTurns(): Turns {
		return new Turns({
			host: this.#host,
			now: this.#c.now,
			app: (appId) => this.#c.apps().find((a) => a.id === appId) ?? null,
			emit: (appId, messageId, event) => this.#links.get(appId)?.emit(messageId, event),
			warn: this.#c.warn,
		});
	}

	#retireAll(): void {
		this.#turns.retire();
		for (const link of this.#links.values()) {
			link.retire();
			if (!link.done) this.#retiring.add(link);
		}
		this.#links.clear();
		this.#notes.clear();
		this.#registeredSettings.clear();
	}

	#syncLinks(): void {
		const apps = this.#c.apps();
		for (const appId of [...this.#links.keys()]) if (!apps.some((a) => a.id === appId)) this.dropApp(appId);
		const sharing = this.#c.sharing();
		for (const app of apps) {
			if (this.#links.has(app.id)) continue;
			const fields = sharing.ok ? sharing.fieldsFor(app.id) : [];
			const missing = withheld(app.discovery.requires, fields);
			if (missing.length > 0) {
				this.#notes.set(app.id, text.requiresWithheld(app.name, missing));
				continue;
			}
			if (this.#notes.get(app.id)?.startsWith("refused") === true) continue;
			this.#notes.delete(app.id);
			this.#links.set(app.id, this.#newLink(app, fields));
		}
	}

	#newLink(app: ConnectedApp, fields: ReturnType<Extract<Sharing, { ok: true }>["fieldsFor"]>): Link {
		const hostSessionId = this.#id as string;
		const link: Link = new Link({
			origin: app.origin,
			sessions: app.discovery.endpoints.sessions,
			pollHoldSeconds: app.discovery.pollHoldSeconds,
			pollIntervalSeconds: app.discovery.pollIntervalSeconds,
			token: app.token,
			http: this.#c.http,
			now: this.#c.now,
			random: this.#c.random,
			declaration: () => this.#declaration(app.id, hostSessionId, fields),
			pollBody: () => this.#pollBody(app.id),
			onCommands: (commands) => this.#commands(app.id, link, commands),
			onState: (state) => this.#linkState(app, state),
		});
		return link;
	}

	/** The settings an app may set: none when the host cannot apply them. */
	#settings(): SessionSetting[] {
		return this.#host.applySetting === undefined ? [] : (this.#host.settings?.() ?? []);
	}

	async #declaration(appId: string, hostSessionId: string, fields: Parameters<typeof sharedWorkspace>[1]): Promise<RegisterRequest> {
		const settings = this.#settings();
		this.#registeredSettings.set(appId, JSON.stringify(settings));
		const h = this.#c.host;
		return {
			host_session_id: hostSessionId,
			host: h.host,
			...(h.hostVersion !== undefined ? { host_version: h.hostVersion } : {}),
			connector_version: CONNECTOR_VERSION,
			workspace: sharedWorkspace(await this.#host.workspace(), fields),
			started_at: this.#startedAt,
			capabilities: { interrupt: this.#host.abort !== undefined, stream: true, settings },
		};
	}

	#pollBody(appId: string): PollRequest {
		const state = this.#turns.state;
		const body: PollRequest = { state };
		if (state === "blocked") body.cause = "permission";
		if (state === "ready" && this.#idleSince !== "") body.idle_since = this.#idleSince;
		const settings = this.#settings();
		if (this.#registeredSettings.has(appId) && JSON.stringify(settings) !== this.#registeredSettings.get(appId)) body.settings = settings;
		return body;
	}

	#commands(appId: string, link: Link, commands: Command[]): void {
		for (const command of commands) {
			if (this.#links.get(appId) !== link) {
				// A last answer to a link whose host session is gone: what it
				// hands out never reaches the host.
				if (command.type === "message") link.emit(command.message_id, { type: "withdrawn", reason: "session_ended" });
			} else if (command.type === "message") this.#turns.message(appId, command);
			else this.#turns.interrupt(appId, command.message_id);
		}
	}

	#linkState(app: ConnectedApp, state: LinkState): void {
		if (state.kind === "revoked") this.#c.onRevoked(app.id);
		else if (state.kind === "refused" && this.#links.has(app.id)) {
			this.#notes.set(app.id, `refused: ${shown(state.message)}`);
			this.#links.delete(app.id);
			this.#turns.forgetApp(app.id);
		}
	}

	async #buildTools(): Promise<ProxiedTool[]> {
		const apps = this.#c.apps().filter((a) => a.discovery.endpoints.mcp !== null);
		const listed = await Promise.all(
			apps.map(async (app) => {
				const client = new McpClient({ http: this.#c.http, origin: app.origin, url: app.discovery.endpoints.mcp as string, token: app.token });
				try {
					return { app, client, tools: await client.listTools() };
				} catch (error) {
					this.#c.warn(text.toolsFailed(app.name, error instanceof Error ? error.message : String(error)));
					return null;
				}
			}),
		);
		const out: ProxiedTool[] = [];
		const names = new Set<string>();
		for (const entry of listed) {
			if (entry === null) continue;
			const def = buildToolDefinition(entry.app, entry.tools);
			if (def === null || names.has(def.name)) continue;
			names.add(def.name);
			out.push({ ...def, call: (input) => this.#callTool(entry.app, entry.client, entry.tools, def.name, input) });
		}
		return out;
	}

	async #callTool(app: ConnectedApp, client: McpClient, tools: McpTool[], name: string, input: unknown): Promise<{ text: string; isError: boolean }> {
		if (!this.#c.apps().some((a) => a.id === app.id && a.token === app.token))
			return { text: `${shown(app.name, 80)} is no longer connected to this agent.`, isError: true };
		const call = toolCall(input, tools);
		if ("error" in call) return { text: `Invalid ${name} call: ${call.error}`, isError: true };
		const sessionId = this.#links.get(app.id)?.sessionId ?? null;
		const messageId = this.#turns.runningMessage(app.id);
		const meta: Record<string, unknown> = {};
		if (sessionId !== null) {
			meta[META.session] = sessionId;
			meta[META.wakes] = true;
		}
		if (messageId !== null) meta[META.message] = messageId;
		return client.callTool(call.name, call.arguments, meta);
	}
}

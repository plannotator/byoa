// @plannotator/byoa-opencode, the server half: the BYOA connector as an OpenCode 2
// server plugin. One connector per plugin instance, and OpenCode runs one
// instance per project folder. Everything host-free is in
// @plannotator/byoa-connector-core; this file wires OpenCode to it.
// Host rules:
//   - Interactive only: a server plugin cannot tell whether a person is
//     there, so the `./tui` half says hello over the plugin RPC (rpc.ts) with
//     the sessions it shows. Only those sessions register, and only while
//     hellos come; `opencode run` and a bare `opencode serve` register
//     nothing. Subagent sessions (with a `parentID`) never register.
//   - Busy, submit, abort and the turn events: session.ts.
//   - The proxied tools (one per app with MCP) are added through
//     `ctx.tool.transform` once, when the first TUI says hello, and never
//     change after. A call runs as the session it came from (a subagent's as
//     its root session); a session no TUI shows gets a plain refusal.
//   - The connector draws nothing itself: its band and toasts go to the TUI
//     as an RPC event.

import { homedir, hostname } from "node:os";
import { Connector, type HostAdapter, type HostSession, type ProxiedTool } from "@plannotator/byoa-connector-core";
import type { SettingChoice } from "@plannotator/byoa-protocol";
import { nodeFiles, nodeHttp, nodeWorkspace } from "./node-ports.ts";
import type { OcEvent, OcServerContext, OcSessionInfo, RpcRegistration } from "./opencode.ts";
import { PRESENCE_MS, RPC, type DisplayEvent } from "./rpc.ts";
import { OcSession } from "./session.ts";

export const TICK_MS = 1_000;
const MODELS_EVERY_MS = 30_000;
const MAX_MODELS = 40;

export interface ServerOptions {
	home?: string;
	now?: () => number;
	tickMs?: number;
	connector?: (host: HostAdapter) => Connector;
}

export interface Running {
	connector: Connector;
	sessions: Map<string, OcSession>;
	hello(sessionIDs: string[]): Promise<void>;
	command(args: string, sessionID?: string): Promise<string>;
	event(e: OcEvent): void;
	tick(): Promise<void>;
	stop(): void;
}

/** The plugin's setup, apart from OpenCode's loader (tests call it). */
export async function serve(ctx: OcServerContext, o: ServerOptions = {}): Promise<Running> {
	const now = o.now ?? Date.now;
	let tuiSeenAt = Number.NEGATIVE_INFINITY;
	const alive = () => now() - tuiSeenAt < PRESENCE_MS;
	let rpc: RpcRegistration | null = null;
	const host: HostAdapter = {
		host: "opencode",
		hostVersion: ctx.app.version,
		machineName: hostname(),
		isInteractive: alive,
		display: (d) => {
			const event: DisplayEvent = d.toast ? { band: d.band, toast: d.toast } : { band: d.band };
			void rpc?.events.emit("display", { ...event }).catch(() => undefined);
		},
	};
	const connector = o.connector?.(host) ?? new Connector({ host, http: nodeHttp, files: nodeFiles, now, home: o.home ?? homedir() });
	await connector.start();

	let models: { at: number; list: SettingChoice[] } = { at: Number.NEGATIVE_INFINITY, list: [] };
	const refreshModels = () => {
		if (now() - models.at < MODELS_EVERY_MS) return;
		models = { ...models, at: now() };
		ctx.model.list().then(
			(r) => {
				const seen = new Map<string, SettingChoice>();
				for (const m of r.data) seen.set(`${m.providerID}/${m.id}`, { value: `${m.providerID}/${m.id}`, name: m.name ?? m.id });
				models = { at: now(), list: [...seen.values()].slice(0, MAX_MODELS) };
			},
			() => undefined,
		);
	};

	const infos = new Map<string, Promise<OcSessionInfo | null>>();
	const info = (sessionID: string) => {
		let p = infos.get(sessionID);
		if (p === undefined) {
			p = ctx.session.get({ sessionID }).catch(() => null);
			infos.set(sessionID, p);
		}
		return p;
	};
	/** The session a call or a hello stands for: a subagent's root. */
	const rootOf = async (sessionID: string): Promise<string> => {
		let id = sessionID;
		for (let i = 0; i < 8; i++) {
			const parent = (await info(id))?.parentID;
			if (parent === undefined) return id;
			id = parent;
		}
		return id;
	};

	const sessions = new Map<string, OcSession>();
	const attach = async (sessionID: string): Promise<void> => {
		if (sessions.has(sessionID)) return;
		const got = await info(sessionID);
		if (got === null || got.parentID !== undefined || sessions.has(sessionID) || !alive()) return;
		const folder = got.location?.directory ?? ctx.location.directory;
		const session = new OcSession({ sessionID, session: ctx.session, alive, workspace: () => nodeWorkspace(folder), models: () => (refreshModels(), models.list), now });
		sessions.set(sessionID, session);
		session.attach(connector.attach(session), got.model);
	};

	let toolsAdded = false;
	const addTools = async () => {
		if (toolsAdded) return;
		toolsAdded = true;
		// A handle that never registers: it only builds the tool list.
		const lister: HostSession = { hostSessionId: () => null, workspace: () => ({}), busy: () => false, blocked: () => false, submit: async () => undefined };
		const tools = await connector.attach(lister).tools();
		if (tools.length === 0) return;
		await ctx.tool.transform((editor) => {
			for (const tool of tools) {
				editor.add({
					name: tool.name,
					description: tool.description,
					input: tool.inputSchema,
					options: { codemode: false },
					execute: async (input, toolContext) => ({ content: await callAs(tool, input, toolContext.sessionID) }),
				});
			}
		});
		await ctx.tool.reload();
	};
	const callAs = async (tool: ProxiedTool, input: unknown, sessionID: string): Promise<string> => {
		const own = sessions.get(await rootOf(sessionID))?.handle;
		const mine = own === undefined || own === null ? undefined : (await own.tools()).find((t) => t.name === tool.name);
		if (mine === undefined) return `BYOA: ${tool.name} works only in an OpenCode session open in a terminal, and this one is not.`;
		const result = await mine.call(input);
		return result.isError ? `Error: ${result.text}` : result.text;
	};

	const stop = new AbortController();
	const running: Running = {
		connector,
		sessions,
		async hello(sessionIDs) {
			tuiSeenAt = now();
			void addTools().catch(() => undefined);
			for (const id of sessionIDs) await attach(await rootOf(id));
		},
		async command(args, sessionID) {
			tuiSeenAt = now();
			if (sessionID !== undefined) await attach(await rootOf(sessionID));
			return connector.command(args);
		},
		event(e) {
			const id = typeof e.data?.sessionID === "string" ? e.data.sessionID : null;
			if (id === null) return;
			if (e.type === "session.deleted") {
				sessions.get(id)?.handle?.detach();
				sessions.delete(id);
				return;
			}
			sessions.get(id)?.event(e);
		},
		async tick() {
			for (const s of sessions.values()) s.crossCheck();
			await connector.tick();
		},
		stop() {
			stop.abort();
			for (const s of sessions.values()) s.handle?.detach();
		},
	};

	rpc = await ctx.rpc.register(RPC, {
		hello: async (input: { sessions: string[] }) => {
			await running.hello(input.sessions);
			return { ok: true };
		},
		command: async (input: { args: string; sessionID?: string }) => ({ text: await running.command(input.args, input.sessionID) }),
	});
	void (async () => {
		try {
			for await (const e of ctx.event.subscribe({ signal: stop.signal })) {
				try {
					running.event(e);
				} catch {
					// One bad event never ends the stream.
				}
			}
		} catch {
			// The stream ends with the plugin.
		}
	})();
	return running;
}

/** OpenCode 2's plugin: `setup` returns its cleanup. */
export default {
	id: "byoa",
	async setup(ctx: OcServerContext) {
		const running = await serve(ctx);
		const timer = setInterval(() => void running.tick().catch(() => undefined), TICK_MS);
		return async () => {
			clearInterval(timer);
			running.stop();
			// The links post their last events (session_ended) while the
			// process still runs.
			for (let i = 0; i < 5; i++) {
				await running.connector.tick().catch(() => undefined);
				await new Promise((r) => setTimeout(r, 200));
			}
		};
	},
};

// @plannotator/byoa-pi: the BYOA connector as a Pi extension. One connector serves every
// app the person paired (`/byoa connect <url>`); everything host-free is in
// @plannotator/byoa-connector-core, and this file only wires Pi to it.
// Host rules (each from an earlier Pi connector's review):
//   - Interactive only: nothing starts unless `ctx.mode === "tui"`. Print,
//     JSON and RPC runs never pair, register or poll.
//   - The connector starts in `session_start` and stops in
//     `session_shutdown`. Pi rebuilds the extension runtime on /new,
//     /resume, /fork and /reload, so each runtime has its own connector, and
//     the old one's messages end (`session_ended`) as its session detaches.
//   - Nothing throws into Pi: a replaced runtime's objects throw on any use,
//     so timer work and drawing are guarded, and drawing runs on a microtask.
//   - The proxied tools (one per app with MCP) are registered once per
//     runtime, when their list arrives, and never change after.
//   - It never answers a permission prompt and never steers.

import { homedir, hostname } from "node:os";
import { Connector, type Display, type HostAdapter, type SessionHandle } from "@plannotator/byoa-connector-core";
import { piHostSession } from "./host.ts";
import { nodeFiles, nodeHttp, nodeWorkspace } from "./node-ports.ts";
import type { PiApi, PiContext, PiEvents } from "./pi.ts";
import { PiTurns } from "./turns.ts";

export const TICK_MS = 1_000;
/** After a session ends, how long its links get to post their last events. */
const DRAIN_MS = 10_000;
const WIDGET = "byoa";
const SUBCOMMANDS = ["connect", "disconnect", "status"];

interface Run {
	connector: Connector;
	turns: PiTurns;
	stop(): void;
}

/** Pi's own version, from the module Pi gives extensions; absent in tests. */
async function piVersion(): Promise<string | undefined> {
	const name = "@earendil-works/pi-coding-agent";
	try {
		const mod = (await import(name)) as { VERSION?: unknown };
		return typeof mod.VERSION === "string" ? mod.VERSION : undefined;
	} catch {
		return undefined;
	}
}

const quietly = (fn: () => void) => {
	try {
		fn();
	} catch {
		// A replaced runtime: nothing to draw on, nothing to tell.
	}
};

export interface StartOptions {
	home?: string;
	version?: string;
	tickMs?: number;
	connector?: (host: HostAdapter) => Connector;
}

/** One runtime's connector: started at `session_start` with its context. */
export function startRun(pi: PiApi, first: PiContext, o: StartOptions = {}): Run {
	let ctx: PiContext | null = first;
	const host: HostAdapter = {
		host: "pi",
		...(o.version !== undefined ? { hostVersion: o.version } : {}),
		machineName: hostname(),
		isInteractive: () => true,
		display: (d: Display) =>
			queueMicrotask(() =>
				quietly(() => {
					ctx?.ui.setWidget(WIDGET, d.band === null ? undefined : [d.band]);
					if (d.toast) ctx?.ui.notify(d.toast.text, d.toast.level === "success" ? "info" : d.toast.level);
				}),
			),
	};
	const connector = o.connector?.(host) ?? new Connector({ host, http: nodeHttp, files: nodeFiles, now: Date.now, home: o.home ?? homedir() });
	const cwd = first.cwd;
	const turns = new PiTurns();
	let handle: SessionHandle | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let stopped = false;
	const run: Run = {
		connector,
		turns,
		stop() {
			if (stopped) return;
			stopped = true;
			ctx = null;
			if (timer !== null) clearInterval(timer);
			handle?.detach();
			// The old links post what they owe on a timer that never touches Pi.
			const drain = setInterval(() => void connector.tick().catch(() => undefined), o.tickMs ?? TICK_MS);
			drain.unref?.();
			setTimeout(() => clearInterval(drain), DRAIN_MS).unref?.();
		},
	};
	void (async () => {
		await connector.start();
		if (stopped) return;
		handle = connector.attach(piHostSession({ pi, ctx: () => ctx, turns, workspace: () => nodeWorkspace(cwd), now: Date.now }));
		turns.attach(handle);
		timer = setInterval(() => void connector.tick().catch(() => undefined), o.tickMs ?? TICK_MS);
		timer.unref?.();
		for (const tool of await handle.tools()) {
			if (stopped) return;
			pi.registerTool({
				name: tool.name,
				label: `BYOA ${tool.name}`,
				description: tool.description,
				parameters: tool.inputSchema,
				async execute(_id, params) {
					const result = await tool.call(params);
					if (result.isError) throw new Error(result.text);
					return { content: [{ type: "text", text: result.text }], details: {} };
				},
			});
		}
	})().catch((error: unknown) => quietly(() => ctx?.ui.notify(`BYOA: could not start (${error instanceof Error ? error.message : String(error)}).`, "error")));
	return run;
}

/** The extension factory; options are for tests (fake ports, no timer). */
export function byoaExtension(o: StartOptions = {}): (pi: PiApi) => Promise<void> {
	return async (pi) => {
		const version = o.version ?? (await piVersion());
		wire(pi, { ...o, ...(version !== undefined ? { version } : {}) });
	};
}

export default byoaExtension();

function wire(pi: PiApi, o: StartOptions): void {
	let run: Run | null = null;
	/** Feeds a Pi event to this runtime's turns; nothing it throws reaches Pi. */
	const feed = <E extends keyof PiEvents>(event: E, fn: (turns: PiTurns, e: PiEvents[E]) => void) =>
		pi.on(event, (e) => {
			const turns = run?.turns;
			if (turns !== undefined) quietly(() => fn(turns, e));
			return undefined;
		});

	pi.registerCommand("byoa", {
		description: "BYOA: connect <address> | disconnect <app> | status",
		getArgumentCompletions: (prefix) => SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
		handler: async (args, ctx) => {
			if (run === null) return ctx.ui.notify("BYOA works in an interactive Pi session only (pi in a terminal).", "info");
			try {
				ctx.ui.notify(await run.connector.command(args), "info");
			} catch (error) {
				ctx.ui.notify(`BYOA: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (_e, ctx) => {
		if (ctx.mode !== "tui") return;
		run?.stop();
		run = startRun(pi, ctx, o);
	});
	pi.on("session_shutdown", () => {
		run?.stop();
		run = null;
	});
	feed("agent_start", (t) => t.agentStart());
	feed("message_start", (t, e) => t.messageStart(e));
	feed("context", (t, e) => t.context(e));
	feed("input", (t, e) => t.input(e));
	feed("message_update", (t, e) => t.messageUpdate(e));
	feed("tool_execution_start", (t, e) => t.toolStart(e));
	feed("agent_end", (t, e) => t.agentEnd(e));
	feed("agent_settled", (t) => t.agentSettled());
	feed("ui_prompt_start", (t) => t.uiPrompt(true));
	feed("ui_prompt_end", (t) => t.uiPrompt(false));
}

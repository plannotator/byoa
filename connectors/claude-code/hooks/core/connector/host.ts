// GENERATED from packages/connector-core/src/host.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// The host adapter interface: what a Claude Code mod, a Pi extension or an
// OpenCode plugin implements, and what it gets back. The core decides; the
// adapter only reports what its host did and does what it is told.
//
// Rules the adapter keeps (each came from a review of an earlier connector):
//   - Interactive sessions only. `-p`, RPC and SDK runs answer
//     `isInteractive() === false`, and the connector then registers nothing.
//   - Never a subagent session, and `busy()` never counts subagent turns
//     (Claude Code: turns with an `agentId`; OpenCode: sessions with a
//     `parentID`). Subagents made "busy forever" in two connectors.
//   - `hostSessionId()` is re-read every tick: Claude Code's `/clear` and
//     resume change it with no event. A change retires the old session.
//   - Report turn events only for the host's main loop. The core decides
//     which turn is ours (by the exact text it submitted) and drops the rest.
//   - `tool(name, title)`: `title` is a fixed label for the tool, never built
//     from its input (a path or a command is input).

import type { HostId, SessionSetting, Workspace } from "./protocol.ts";

/** What the host draws. `band` is the standing line (Claude Code's band,
 * Pi's widget, an OpenCode toast when it changes); null clears it. `toast`
 * is a one-off notice. */
export interface Display {
	band: string | null;
	toast?: { text: string; level: "info" | "success" | "warning" | "error" };
}

/** One host process. */
export interface HostAdapter {
	readonly host: HostId;
	readonly hostVersion?: string;
	/** As the person's machine calls itself; shown on the approval page as
	 * declared, unverified. */
	readonly machineName?: string;
	/** False for print, RPC and SDK runs. */
	isInteractive(): boolean;
	display(display: Display): void;
}

/** One live host conversation in that process: one for Claude Code and Pi,
 * one per session the TUI sees for OpenCode. */
export interface HostSession {
	/** The host's own session id, or null while there is none. */
	hostSessionId(): string | null;
	/** Everything the host knows; the person's sharing setting filters it per
	 * app before anything is sent. `path` is absolute. */
	workspace(): Workspace | Promise<Workspace>;
	/** A main-loop turn runs, or a prompt waits in the host's own queue. */
	busy(): boolean;
	/** A permission prompt waits for the person. */
	blocked(): boolean;
	/** Start a turn with exactly `text`. Called only after the host has been
	 * idle for KNOBS.idleTicks ticks. Resolves when the host took it. */
	submit(text: string): Promise<void>;
	/** Abort the running turn. Called only for a turn the core knows is its
	 * own. Absent: the session declares `interrupt: false`. */
	abort?(): Promise<void>;
	/** The settings an app may set before a turn, with the value in force
	 * (null when the host cannot tell). Re-read every tick. */
	settings?(): SessionSetting[];
	/** Apply one setting before a turn. Resolves when it is in force. */
	applySetting?(id: string, value: string): Promise<void>;
}

/** What `connector.attach(session)` returns: the adapter feeds its host's
 * turn events in here. */
export interface SessionHandle {
	/** A main-loop turn began with this prompt (as the host shows it, which
	 * may wrap our text in its own frame). True when it is ours. */
	turnStarted(prompt: string): boolean;
	/** Visible answer text of the running turn. Dropped unless the turn is ours. */
	delta(text: string): void;
	/** A tool step began in the running turn. Dropped unless the turn is ours. */
	tool(name: string, title?: string): void;
	/** The running main-loop turn ended. */
	turnEnded(outcome: "done" | "error" | "interrupted", reason?: string): void;
	/** A prompt was announced (Claude Code fires at Enter, before it joins
	 * the turn). Pass its text when known: our own is recognised and ignored.
	 * Otherwise nothing more of our running turn streams from now on, and the
	 * idle count starts over. True when it was not ours. */
	foreignPrompt(prompt?: string): boolean;
	/** A prompt we did not submit joined our running turn: the message ends
	 * `interrupted`, reason `taken_over`. Hosts that cannot tell the moment
	 * may call it right after `foreignPrompt`. */
	takenOver(): void;
	/** True when `prompt` is (or wraps) a text this session submitted. */
	isOurs(prompt: string): boolean;
	/** The proxied tools, one per connected app with an MCP endpoint. Built
	 * once, at the first call; fixed for the life of this handle. */
	tools(): Promise<ProxiedTool[]>;
	/** The host session ended for good (the process exits, the OpenCode
	 * session closed): end its messages and stop polling. */
	detach(): void;
}

/** One app's tools as one host tool. The adapter registers `name`,
 * `description` and `inputSchema` with its host and routes calls to `call`. */
export interface ProxiedTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	call(input: unknown): Promise<{ text: string; isError: boolean }>;
}

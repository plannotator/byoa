// GENERATED from packages/protocol/src/wire.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// The BYOA wire, draft 0.1: every shape that crosses between an app and a
// connector, in one file (docs/SPEC.md is the prose). Pure TypeScript, no
// imports and no runtime APIs beyond the language, because a Claude Code mod
// can import only its own folder and copies this file in.

// 0.1 simplified (2026-10-21): steer, upgrade, the loopback grant, the state
// event, DELETE sessions and tool phases were cut after the implementers' review.
export const BYOA_VERSION = "0.1";

/** The discovery document's path on an app's origin (SPEC 3). */
export const WELL_KNOWN_PATH = "/.well-known/byoa";

// ── knobs every party agrees on (SPEC 2, 5) ───────────────────────────────

export const KNOBS = {
	/** The longest an app holds a poll. Claude Code's fetch aborts at 30 s. An
	 * app MAY hold 0 (answer at once); it then advertises a poll interval. */
	pollHoldSeconds: 20,
	/** How often a connector polls an app that holds 0. */
	pollIntervalSeconds: 5,
	/** An app answers a poll within this, whatever it holds. */
	pollAnswerSeconds: 25,
	/** No poll for this long: the app shows the session `gone`. */
	goneAfterSeconds: 60,
	/** An app offers an unanswered message again after this. */
	redeliverAfterSeconds: 30,
	/** Idle ticks before a held `when_idle` message starts its turn. */
	idleTicks: 2,
	/** UI stream keep-alive. */
	keepAliveSeconds: 15,
	/** Device grant lifetime and poll interval (SPEC 4.1). */
	pairingLifetimeSeconds: 600,
	pairingIntervalSeconds: 2,
} as const;

// ── discovery (SPEC 3) ──────────────────────────────────────────────────────

export type WorkspaceField = "folder_name" | "path" | "git_remote" | "branch";

export interface Discovery {
	byoa: string;
	app: { id: string; name: string; icon?: string; origin: string };
	endpoints: {
		pair_start: string;
		pair_poll: string;
		verification_uri: string;
		revoke: string;
		sessions: string;
		mcp?: string;
	};
	poll_hold_seconds: number;
	/** Present when `poll_hold_seconds` is 0. */
	poll_interval_seconds?: number;
	accepts: { interrupt: boolean; stream: boolean; settings: string[] };
	requires?: { workspace?: WorkspaceField[] };
}

// ── pairing (SPEC 4) ────────────────────────────────────────────────────────

export type HostId = "claude-code" | "pi" | "opencode" | "amp" | (string & {});

export interface ClientInfo {
	host: HostId;
	host_version?: string;
	connector: string;
	connector_version: string;
	machine_name?: string;
}

export interface PairStartRequest {
	client: ClientInfo;
}

export interface PairStartResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}

export interface PairPollRequest {
	device_code: string;
}

export interface PairPollApproved {
	access_token: string;
	token_type: "bearer";
	connection_id: string;
	account: { display_name: string | null };
}

export type PairPollErrorCode = "authorization_pending" | "slow_down" | "access_denied" | "expired_token" | "invalid_request";

// ── sessions (SPEC 5) ───────────────────────────────────────────────────────

export interface Workspace {
	folder_name?: string;
	path?: string;
	git_remote?: string;
	branch?: string;
}

/** A choice as the host shows it: `value` is what `set` sends, `name` what
 * a picker shows (Pi and OpenCode model ids are not names; Machine review). */
export interface SettingChoice {
	value: string;
	name: string;
}

export interface SessionSetting {
	id: string;
	name: string;
	value: string | null;
	choices: SettingChoice[];
}

export interface SessionCapabilities {
	interrupt: boolean;
	stream: boolean;
	settings: SessionSetting[];
}

export interface RegisterRequest {
	host_session_id: string;
	host: HostId;
	host_version?: string;
	connector_version: string;
	workspace: Workspace;
	started_at: string;
	capabilities: SessionCapabilities;
}

export type SessionState = "ready" | "busy" | "blocked";
export type SessionView = SessionState | "gone";

export interface SessionInfo {
	id: string;
	connection_id: string;
	host: HostId;
	workspace: Workspace;
	state: SessionView;
	cause?: "permission";
	idle_since?: string;
	started_at: string;
	last_seen_at: string;
	capabilities: SessionCapabilities;
}

export interface RegisterResponse {
	session: SessionInfo;
	poll_hold_seconds: number;
	minimum_connector_version: string;
}

/** The poll body is the only presence input: a connector polls again at
 * once when its state or a setting changes, and the newer poll answers the
 * held one with no commands. */
export interface PollRequest {
	state: SessionState;
	cause?: "permission";
	idle_since?: string;
	/** Sent when a setting's value changed since register. */
	settings?: SessionSetting[];
}

export type MessageKind = "chat" | "task" | "reply" | "notice";

export interface MessageCommand {
	type: "message";
	message_id: string;
	kind: MessageKind;
	from: { display_name: string };
	text: string;
	interrupt_first: boolean;
	stream: boolean;
	set?: Record<string, string>;
}

export interface InterruptCommand {
	type: "interrupt";
	message_id: string;
}

export type Command = MessageCommand | InterruptCommand;

export interface PollResponse {
	commands: Command[];
}

// ── events (SPEC 5.4) ───────────────────────────────────────────────────────

export type InterruptedReason = "stopped" | "taken_over" | "session_ended";

export type MessageEventBody =
	| { type: "queued" }
	| { type: "started" }
	| { type: "delta"; text: string }
	| { type: "tool"; name: string; title: string }
	| { type: "done" }
	| { type: "error"; reason: string }
	| { type: "interrupted"; reason: InterruptedReason }
	| { type: "withdrawn"; reason?: string };

export type MessageEventType = MessageEventBody["type"];

export type MessageEvent = MessageEventBody & { message_id: string; seq: number };

export interface EventsRequest {
	events: MessageEvent[];
}

/** The event types that end a message: exactly one of them, once. */
export const END_EVENTS: ReadonlySet<MessageEventType> = new Set(["done", "error", "interrupted", "withdrawn"]);

// ── tools (SPEC 7) ──────────────────────────────────────────────────────────

export const META = {
	session: "dev.byoa/session",
	message: "dev.byoa/message",
	wakes: "dev.byoa/wakes",
} as const;

// ── errors (SPEC 2) ─────────────────────────────────────────────────────────

export interface WireError {
	error: string;
	error_description?: string;
	/** On `422 seq_gap`: the message and the seq to resend from. */
	message_id?: string;
	expected?: number;
}

/** Fixed `reason` phrases on `error` and `withdrawn` events (SPEC 5.4, 6). */
export const EVENT_REASONS = [
	"refused_slash_command",
	"setting_not_declared",
	"setting_failed",
	"submit_failed",
	"not_started",
	"too_many_waiting",
	"turn_failed",
	"session_ended",
	"stopped",
] as const;

export type WireErrorCode =
	| PairPollErrorCode
	| "unauthorized"
	| "forbidden"
	| "session_not_found"
	| "seq_gap"
	| "too_many_sessions"
	| "validation_error"
	| "session_unavailable"
	| "method_not_allowed"
	| "server_error"
	| "not_found";

// ── the turn's first line (SPEC 6) ──────────────────────────────────────────

/** The line the connector puts above every app turn. The app cannot forge
 * it: `appName` and `origin` come from the connector's own pairing record. */
export function provenanceLine(input: {
	appName: string;
	origin: string;
	kind: MessageKind;
	from: string;
	messageId: string;
}): string {
	const host = hostOf(input.origin);
	const from = oneLine(input.from) || "someone";
	return `[BYOA] ${oneLine(input.appName)} (${host}) · ${input.kind} from ${from} · ${input.messageId}`;
}

function hostOf(origin: string): string {
	const match = /^[a-z]+:\/\/([^/]+)/i.exec(origin);
	return match?.[1] ?? origin;
}

function oneLine(text: string): string {
	return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 120);
}

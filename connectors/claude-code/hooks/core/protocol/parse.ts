// GENERATED from packages/protocol/src/parse.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// Parsing what crossed the wire. Both sides trust the other party's code
// less than their own: an app checks every request body, a connector checks
// every answer. Each parser returns the value or a one-line reason, never
// throws. Pure TypeScript, like wire.ts (copied into the Claude Code mod).

import type {
	Command,
	Discovery,
	EventsRequest,
	MessageEvent,
	PairPollApproved,
	PairStartRequest,
	PairStartResponse,
	PollRequest,
	PollResponse,
	RegisterRequest,
	RegisterResponse,
	SessionCapabilities,
	SessionSetting,
	SessionState,
	Workspace,
	WireError,
} from "./wire.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(reason: string): Parsed<T> => ({ ok: false, reason });

export const LIMITS = {
	name: 255,
	version: 64,
	id: 128,
	path: 4096,
	text: 64 * 1024,
	delta: 16 * 1024,
	eventsPerRequest: 256,
	settings: 16,
	choices: 64,
} as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

// Control characters, plus invisible and text-direction marks that would let
// a declared name read differently on an approval page.
const CONTROL = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

function str(value: unknown, max: number, opts: { control?: boolean; empty?: boolean } = {}): value is string {
	if (typeof value !== "string" || value.length > max) return false;
	if (!opts.empty && value.trim() === "") return false;
	if (!opts.control && CONTROL.test(value)) return false;
	return true;
}

function optStr(value: unknown, max: number): boolean {
	return value === undefined || str(value, max);
}

function isoTime(value: unknown): value is string {
	return typeof value === "string" && value.length <= 40 && !Number.isNaN(Date.parse(value));
}

// ── app side: request bodies ────────────────────────────────────────────────

export function parsePairStart(body: unknown): Parsed<PairStartRequest> {
	if (!isRecord(body) || !isRecord(body.client)) return fail("client: an object");
	const c = body.client;
	if (!str(c.host, LIMITS.id)) return fail("client.host: a short name");
	if (!str(c.connector, LIMITS.name)) return fail("client.connector: a name");
	if (!str(c.connector_version, LIMITS.version)) return fail("client.connector_version: a version");
	if (!optStr(c.host_version, LIMITS.version)) return fail("client.host_version: a version");
	if (!optStr(c.machine_name, LIMITS.name)) return fail("client.machine_name: a name");
	return ok({
		client: {
			host: c.host,
			connector: c.connector,
			connector_version: c.connector_version,
			...(c.host_version !== undefined ? { host_version: c.host_version as string } : {}),
			...(c.machine_name !== undefined ? { machine_name: c.machine_name as string } : {}),
		},
	});
}

function parseWorkspace(value: unknown): Parsed<Workspace> {
	if (value === undefined) return ok({});
	if (!isRecord(value)) return fail("workspace: an object");
	const out: Workspace = {};
	if (value.folder_name !== undefined) {
		if (!str(value.folder_name, LIMITS.name)) return fail("workspace.folder_name");
		out.folder_name = value.folder_name;
	}
	if (value.path !== undefined) {
		if (!str(value.path, LIMITS.path)) return fail("workspace.path");
		out.path = value.path;
	}
	if (value.git_remote !== undefined) {
		if (!str(value.git_remote, LIMITS.path)) return fail("workspace.git_remote");
		out.git_remote = value.git_remote;
	}
	if (value.branch !== undefined) {
		if (!str(value.branch, LIMITS.name)) return fail("workspace.branch");
		out.branch = value.branch;
	}
	return ok(out);
}

function parseSettings(value: unknown): Parsed<SessionSetting[]> {
	if (value === undefined) return ok([]);
	if (!Array.isArray(value) || value.length > LIMITS.settings) return fail("settings: a short list");
	const out: SessionSetting[] = [];
	for (const item of value) {
		if (!isRecord(item)) return fail("settings[]: an object");
		if (!str(item.id, LIMITS.id) || !str(item.name, LIMITS.name)) return fail("settings[]: id and name");
		if (item.value !== null && !str(item.value, LIMITS.name)) return fail("settings[].value: a string or null");
		if (!Array.isArray(item.choices) || item.choices.length > LIMITS.choices) return fail("settings[].choices: a short list");
		const choices: { value: string; name: string }[] = [];
		for (const c of item.choices) {
			if (!isRecord(c) || !str(c.value, LIMITS.name) || !str(c.name, LIMITS.name)) return fail("settings[].choices[]: { value, name }");
			choices.push({ value: c.value, name: c.name });
		}
		out.push({ id: item.id, name: item.name, value: item.value as string | null, choices });
	}
	return ok(out);
}

function parseCapabilities(value: unknown): Parsed<SessionCapabilities> {
	if (!isRecord(value)) return fail("capabilities: an object");
	if (typeof value.interrupt !== "boolean" || typeof value.stream !== "boolean")
		return fail("capabilities: interrupt and stream are booleans");
	const settings = parseSettings(value.settings);
	if (!settings.ok) return settings;
	return ok({ interrupt: value.interrupt, stream: value.stream, settings: settings.value });
}

export function parseRegister(body: unknown): Parsed<RegisterRequest> {
	if (!isRecord(body)) return fail("body: an object");
	if (!str(body.host_session_id, LIMITS.id)) return fail("host_session_id");
	if (!str(body.host, LIMITS.id)) return fail("host");
	if (!str(body.connector_version, LIMITS.version)) return fail("connector_version");
	if (!optStr(body.host_version, LIMITS.version)) return fail("host_version");
	if (!isoTime(body.started_at)) return fail("started_at: an ISO time");
	const workspace = parseWorkspace(body.workspace);
	if (!workspace.ok) return workspace;
	const capabilities = parseCapabilities(body.capabilities);
	if (!capabilities.ok) return capabilities;
	return ok({
		host_session_id: body.host_session_id,
		host: body.host,
		connector_version: body.connector_version,
		...(body.host_version !== undefined ? { host_version: body.host_version as string } : {}),
		workspace: workspace.value,
		started_at: body.started_at,
		capabilities: capabilities.value,
	});
}

export function parsePoll(body: unknown): Parsed<PollRequest> {
	if (!isRecord(body)) return fail("body: an object");
	const state = body.state as SessionState;
	if (state !== "ready" && state !== "busy" && state !== "blocked") return fail("state: ready, busy or blocked");
	if (body.cause !== undefined && body.cause !== "permission") return fail("cause: permission");
	if (body.idle_since !== undefined && !isoTime(body.idle_since)) return fail("idle_since: an ISO time");
	const settings = body.settings === undefined ? undefined : parseSettings(body.settings);
	if (settings && !settings.ok) return settings;
	return ok({
		state,
		...(body.cause === "permission" ? { cause: "permission" as const } : {}),
		...(body.idle_since !== undefined ? { idle_since: body.idle_since as string } : {}),
		...(settings ? { settings: settings.value } : {}),
	});
}

const MESSAGE_EVENT_TYPES = new Set(["queued", "started", "delta", "tool", "done", "error", "interrupted", "withdrawn"]);
const INTERRUPTED_REASONS = new Set(["stopped", "taken_over", "session_ended"]);

function parseEvent(value: unknown): Parsed<MessageEvent> {
	if (!isRecord(value)) return fail("events[]: an object");
	if (typeof value.type !== "string" || !MESSAGE_EVENT_TYPES.has(value.type)) return fail(`events[].type: unknown ${String(value.type)}`);
	if (!str(value.message_id, LIMITS.id)) return fail("events[].message_id");
	if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 0) return fail("events[].seq: an integer from 0");
	const base = { message_id: value.message_id, seq: value.seq };
	switch (value.type) {
		case "delta":
			if (!str(value.text, LIMITS.delta, { control: true, empty: true })) return fail("delta.text");
			return ok({ ...base, type: "delta", text: value.text });
		case "tool":
			if (!str(value.name, LIMITS.name) || !str(value.title, LIMITS.name)) return fail("tool: name and title");
			return ok({ ...base, type: "tool", name: value.name, title: value.title });
		case "error":
			if (!str(value.reason, LIMITS.name)) return fail("error.reason");
			return ok({ ...base, type: "error", reason: value.reason });
		case "interrupted":
			if (typeof value.reason !== "string" || !INTERRUPTED_REASONS.has(value.reason)) return fail("interrupted.reason");
			return ok({ ...base, type: "interrupted", reason: value.reason as "stopped" | "taken_over" | "session_ended" });
		case "withdrawn":
			if (!optStr(value.reason, LIMITS.name)) return fail("withdrawn.reason");
			return ok({ ...base, type: "withdrawn", ...(value.reason !== undefined ? { reason: value.reason as string } : {}) });
		default:
			return ok({ ...base, type: value.type as "queued" | "started" | "done" });
	}
}

export function parseEvents(body: unknown): Parsed<EventsRequest> {
	if (!isRecord(body) || !Array.isArray(body.events)) return fail("events: a list");
	if (body.events.length > LIMITS.eventsPerRequest) return fail(`events: at most ${LIMITS.eventsPerRequest}`);
	const events: MessageEvent[] = [];
	for (const item of body.events) {
		const event = parseEvent(item);
		if (!event.ok) return event;
		events.push(event.value);
	}
	return ok({ events });
}

// ── connector side: answers ─────────────────────────────────────────────────

export function parseWireError(body: unknown): WireError | null {
	if (!isRecord(body) || typeof body.error !== "string") return null;
	return {
		error: body.error,
		...(typeof body.error_description === "string" ? { error_description: body.error_description } : {}),
		...(typeof body.message_id === "string" ? { message_id: body.message_id } : {}),
		...(typeof body.expected === "number" ? { expected: body.expected } : {}),
	};
}

export function parseDiscovery(body: unknown): Parsed<Discovery> {
	if (!isRecord(body)) return fail("discovery: an object");
	if (typeof body.byoa !== "string") return fail("byoa: a version");
	if (!isRecord(body.app) || !str(body.app.id, LIMITS.id) || !str(body.app.name, LIMITS.name) || !str(body.app.origin, LIMITS.path))
		return fail("app: id, name and origin");
	if (!isRecord(body.endpoints)) return fail("endpoints");
	for (const key of ["sessions", "revoke", "pair_start", "pair_poll", "verification_uri"] as const)
		if (!str(body.endpoints[key], LIMITS.path)) return fail(`endpoints.${key}`);
	if (typeof body.poll_hold_seconds !== "number" || body.poll_hold_seconds < 0 || body.poll_hold_seconds > 25) return fail("poll_hold_seconds: 0 to 25");
	if (body.poll_interval_seconds !== undefined && (typeof body.poll_interval_seconds !== "number" || body.poll_interval_seconds < 1))
		return fail("poll_interval_seconds: at least 1");
	if (!isRecord(body.accepts) || typeof body.accepts.interrupt !== "boolean" || typeof body.accepts.stream !== "boolean" || !Array.isArray(body.accepts.settings))
		return fail("accepts: interrupt, stream and settings");
	if (body.endpoints.mcp !== undefined && !str(body.endpoints.mcp, LIMITS.path)) return fail("endpoints.mcp");
	if (body.requires !== undefined) {
		const fields = isRecord(body.requires) ? body.requires.workspace : undefined;
		const known = ["folder_name", "path", "git_remote", "branch"];
		if (fields !== undefined && (!Array.isArray(fields) || !fields.every((f) => known.includes(f as string)))) return fail("requires.workspace");
	}
	return ok(body as unknown as Discovery);
}

export function parsePairStartResponse(body: unknown): Parsed<PairStartResponse> {
	if (!isRecord(body)) return fail("an object");
	for (const key of ["device_code", "user_code", "verification_uri", "verification_uri_complete"] as const)
		if (!str(body[key], LIMITS.path)) return fail(key);
	if (typeof body.expires_in !== "number" || typeof body.interval !== "number") return fail("expires_in and interval");
	return ok(body as unknown as PairStartResponse);
}

export function parsePairApproved(body: unknown): Parsed<PairPollApproved> {
	if (!isRecord(body) || !str(body.access_token, LIMITS.path) || !str(body.connection_id, LIMITS.id)) return fail("access_token and connection_id");
	const account = isRecord(body.account) ? body.account : {};
	return ok({
		access_token: body.access_token,
		token_type: "bearer",
		connection_id: body.connection_id,
		account: { display_name: typeof account.display_name === "string" ? account.display_name : null },
	});
}

export function parseRegisterResponse(body: unknown): Parsed<RegisterResponse> {
	if (!isRecord(body) || !isRecord(body.session) || !str(body.session.id, LIMITS.id)) return fail("session.id");
	if (typeof body.poll_hold_seconds !== "number") return fail("poll_hold_seconds");
	if (typeof body.minimum_connector_version !== "string") return fail("minimum_connector_version");
	return ok(body as unknown as RegisterResponse);
}

export function parseCommand(value: unknown): Parsed<Command> {
	if (!isRecord(value) || !str(value.message_id, LIMITS.id)) return fail("commands[].message_id");
	if (value.type === "interrupt") return ok({ type: "interrupt", message_id: value.message_id });
	if (value.type !== "message") return fail(`commands[].type: unknown ${String(value.type)}`);
	if (!str(value.text, LIMITS.text, { control: true })) return fail("message.text");
	const kind = value.kind;
	if (kind !== "chat" && kind !== "task" && kind !== "reply" && kind !== "notice") return fail("message.kind");
	const from = isRecord(value.from) && typeof value.from.display_name === "string" ? value.from.display_name : "";
	let set: Record<string, string> | undefined;
	if (value.set !== undefined) {
		if (!isRecord(value.set)) return fail("message.set: an object");
		set = {};
		for (const [k, v] of Object.entries(value.set)) {
			if (!str(k, LIMITS.id) || !str(v, LIMITS.name)) return fail("message.set: short strings");
			set[k] = v;
		}
	}
	return ok({
		type: "message",
		message_id: value.message_id,
		kind,
		from: { display_name: from },
		text: value.text,
		interrupt_first: value.interrupt_first === true,
		stream: value.stream !== false,
		...(set ? { set } : {}),
	});
}

/** A malformed command is skipped, never fatal: the app offers an
 * unanswered message again, so failing the whole answer would block the
 * session for good. `skipped` lists the reasons, for the connector's status. */
export function parsePollResponse(body: unknown): Parsed<PollResponse & { skipped: string[] }> {
	if (!isRecord(body) || !Array.isArray(body.commands)) return fail("commands: a list");
	const commands: Command[] = [];
	const skipped: string[] = [];
	for (const item of body.commands) {
		const command = parseCommand(item);
		if (command.ok) commands.push(command.value);
		else skipped.push(command.reason);
	}
	return ok({ commands, skipped });
}

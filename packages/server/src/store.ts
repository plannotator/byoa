// Where BYOA state lives, split by how long it must last. Durable records
// (pairings, connections) belong in the app's database: a restart must not
// disconnect anyone. Everything live (sessions, waiting messages, held polls,
// event buffers, listeners) lives in one hub per person and may be forgotten
// on a restart: the connector's next poll answers 404 and it registers again
// under the same session id. A hub needs a single writer per person, so a
// multi-instance app hosts each person's hub in one place (a Durable Object
// per person, as Workspaces' AgentSessionsDO does). Every hub method takes
// and returns plain data or a callback, so that adapter is a thin wrapper.

import type { ClientInfo, Command, MessageCommand, MessageEvent, PollRequest, RegisterRequest, SessionInfo } from "@plannotator/byoa-protocol";
import type { Awaitable, ByoaLimits, Clock, HubEvent, InterruptOutcome } from "./types.ts";

// ── durable ─────────────────────────────────────────────────────────────────

export interface PairingRecord {
	/** Becomes the connection's id when the token is collected. */
	id: string;
	device_code_hash: string;
	user_code_hash: string;
	client: ClientInfo;
	created_at: number;
	expires_at: number;
	last_poll_at: number | null;
	status: "pending" | "approved" | "denied" | "collected";
	approved_by: { user_id: string; display_name: string } | null;
}

export interface ConnectionRecord {
	id: string;
	user_id: string;
	display_name: string;
	host: string;
	machine_name: string | null;
	token_hash: string;
	created_at: number;
	revoked_at: number | null;
	last_seen_at: number | null;
}

export interface PairingStore {
	/** False when the user code collides with a live pairing's. */
	insert(pairing: PairingRecord): Awaitable<boolean>;
	/** Pending and unexpired only. */
	findByUserCode(userCodeHash: string, now: number): Awaitable<PairingRecord | null>;
	findByDeviceCode(deviceCodeHash: string): Awaitable<PairingRecord | null>;
	/** Records this poll and returns the time of the previous one. */
	notePoll(id: string, now: number): Awaitable<number | null>;
	/** Conditional on pending and unexpired: one decision wins. */
	decide(id: string, decision: "approved" | "denied", approver: { user_id: string; display_name: string } | null, now: number): Awaitable<boolean>;
	/** Conditional on approved and unexpired: marks it collected AND inserts
	 * the connection, atomically, so exactly one poll gets a token. */
	collect(id: string, connection: ConnectionRecord, now: number): Awaitable<boolean>;
}

export interface ConnectionStore {
	byTokenHash(tokenHash: string): Awaitable<ConnectionRecord | null>;
	get(id: string): Awaitable<ConnectionRecord | null>;
	listByUser(userId: string): Awaitable<ConnectionRecord[]>;
	/** Sets revoked_at once; returns the record, or null when unknown. */
	revoke(id: string, now: number): Awaitable<ConnectionRecord | null>;
	touch(id: string, now: number): Awaitable<void>;
}

// ── live, one hub per person ────────────────────────────────────────────────

export interface HubConfig {
	clock: Clock;
	limits: ByoaLimits;
	pollHoldMs: number;
}

export type RegisterOutcome = { kind: "registered"; session: SessionInfo } | { kind: "too_many_sessions"; limit: number };

export type PollOutcome = { kind: "commands"; commands: Command[] } | { kind: "not_found" } | { kind: "revoked" };

export type EventsOutcome = { kind: "accepted" } | { kind: "not_found" } | { kind: "seq_gap"; message_id: string; expected: number };

/** A message the door already shape-checked; the hub checks it against the session. */
export interface SendInput {
	text: string;
	kind: MessageCommand["kind"];
	interrupt_first: boolean;
	stream: boolean;
	set?: Record<string, string>;
	from: { display_name: string };
}

export type SendOutcome =
	| { kind: "sent"; message_id: string }
	| { kind: "refused"; status: 404 | 409 | 422; error: string; description: string };

export interface Hub {
	register(connectionId: string, sessionId: string, request: RegisterRequest): Awaitable<RegisterOutcome>;
	poll(connectionId: string, sessionId: string, request: PollRequest): Promise<PollOutcome>;
	postEvents(connectionId: string, sessionId: string, events: MessageEvent[]): Awaitable<EventsOutcome>;
	send(sessionId: string, input: SendInput): Awaitable<SendOutcome>;
	interrupt(sessionId: string, messageId: string): Awaitable<InterruptOutcome | null>;
	list(): Awaitable<SessionInfo[]>;
	dropConnection(connectionId: string): Awaitable<void>;
	subscribe(listener: (event: HubEvent) => void): Awaitable<() => void>;
}

export interface ByoaStore {
	pairings: PairingStore;
	connections: ConnectionStore;
	/** The person's hub. Every call for one person must reach the same one. */
	hub(userId: string, config: HubConfig): Hub;
}

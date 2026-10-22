// The public shapes of @plannotator/byoa-server: what an app passes to createByoa, the
// object it gets back, and the events its UI receives. The wire shapes live
// in @plannotator/byoa-protocol; these are the SDK profile around them (SPEC 8).

import type { ClientInfo, MessageEventBody, MessageKind, SessionInfo, WorkspaceField } from "@plannotator/byoa-protocol";
import type { ByoaStore } from "./store.ts";

export type Awaitable<T> = T | Promise<T>;

/** The person, as the app's own sign-in knows them. */
export interface ByoaUser {
	userId: string;
	displayName: string;
}

/** Time and timers, injectable so tests never sleep. */
export interface Clock {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface ByoaLimits {
	/** Live sessions one connection may hold (SPEC 9.7). */
	sessionsPerConnection: number;
	/** Events kept per open message for the UI; past it the UI view ends `gone`. */
	bufferedEventsPerMessage: number;
	/** How far ahead of the next expected `seq` an event may arrive. */
	seqLookAhead: number;
}

export interface ByoaOptions {
	app: { id: string; name: string; origin: string; icon?: string };
	/** The app's own human session. Never a bearer token. */
	authenticate(req: Request): Promise<ByoaUser | null>;
	/** Default: a POST or DELETE must carry `Origin` equal to `app.origin`. */
	checkCsrf?(req: Request): boolean;
	store?: ByoaStore;
	/** Advertised in discovery; the app's MCP server checks tokens with `verifyBearer`. */
	mcpPath?: string;
	/** Default "/byoa". */
	basePath?: string;
	/** Default 20. 0 answers every poll at once; discovery then names a poll interval. */
	pollHoldSeconds?: number;
	clock?: Clock;
	limits?: Partial<ByoaLimits>;
	/** Only for a local app with no accounts, on a loopback origin: approve
	 * every pairing at once as this person, with no page, so the connector's
	 * first pair_poll collects the token. Refused on any other origin. */
	autoApprove?: (client: ClientInfo) => ByoaUser | null;
	/** Setting ids the app may `set` before a turn, advertised in discovery. */
	settings?: string[];
	/** Session fields the app cannot work without (AppNotes routes by git_remote). */
	requires?: { workspace?: WorkspaceField[] };
}

export type GoneReason = "stopped_polling" | "disconnected" | "continues_in_terminal";

export interface UiSession extends SessionInfo {
	machine_name: string | null;
}

export interface UiConnection {
	id: string;
	host: string;
	machine_name: string | null;
	created_at: string;
	last_seen_at: string | null;
	sessions: UiSession[];
}

/** A connector event as the UI sees it. `seq` is absent on the one event the
 * server writes itself: `withdrawn` when Stop catches a message no poll took. */
export type UiMessageEvent = MessageEventBody & { seq?: number };

export type UiEvent =
	| { type: "sessions"; connections: UiConnection[] }
	| { type: "accepted"; session_id: string; message_id: string; kind: MessageKind; text: string; from: { display_name: string } }
	| { type: "event"; session_id: string; message_id: string; event: UiMessageEvent }
	| { type: "gone"; session_id: string; message_id: string; reason: GoneReason };

/** What a hub emits: UI events, except that a change to the session list is
 * a signal, and the list itself is built from the durable connections too. */
export type HubEvent = Exclude<UiEvent, { type: "sessions" }> | { type: "sessions_changed" };

export interface SendMessage {
	text: string;
	/** Default "task" from the server (a hand-off), "chat" from the UI door. */
	kind?: MessageKind;
	interruptFirst?: boolean;
	stream?: boolean;
	set?: Record<string, string>;
	/** The display name the connector shows; default the connection's account. */
	from?: string;
}

export type SendResult = { message_id: string } | { error: string; error_description: string };

export type InterruptOutcome = "withdrawn" | "interrupt_sent" | "already_finished";

export interface BearerIdentity {
	userId: string;
	connectionId: string;
	/** Present only when asked for and the session belongs to this connection. */
	sessionId?: string;
}

export interface Byoa {
	/** null when the request is not a BYOA route. Mount on "/.well-known/byoa" and basePath/*. */
	handle(req: Request): Promise<Response | null>;
	/** Server-side enqueue (a hand-off), under the UI send's rules. The app
	 * calls it only from an action of this person (SPEC 9.1). */
	send(userId: string, sessionId: string, message: SendMessage): Promise<SendResult>;
	/** Stop a message from the app's own server (its Stop button), under the
	 * UI door's rules. Null when the person has no such session. */
	interrupt(userId: string, sessionId: string, messageId: string): Promise<InterruptOutcome | null>;
	sessions(userId: string): Promise<UiConnection[]>;
	/** The events the UI stream carries: first the session list and every open
	 * message so far, then live. */
	subscribe(userId: string, listener: (event: UiEvent) => void): () => void;
	/** For the app's own MCP server: accept a BYOA connection token. Pass the
	 * `_meta["dev.byoa/session"]` value to have it checked against the connection. */
	verifyBearer(req: Request, opts?: { sessionId?: string }): Promise<BearerIdentity | null>;
	revoke(connectionId: string): Promise<void>;
}

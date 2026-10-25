// One person's live BYOA state: their registered sessions, the messages
// waiting for each, the one held poll per session, every open message's
// events, and the listeners (their UI streams). Memory only; a restart
// forgets it and connectors register again (store.ts). Shaped on Workspaces'
// per-person session store, whose reviews set most of the rules below.
//
// A message is `waiting` until a poll takes it (Stop withdraws it here),
// `handed` until any event answers it (offered once more after 30 s, the
// cover for a poll answer lost on the network), then `answered`. Its events
// reach listeners in `seq` order, repeats dropped, and exactly one end: the
// connector's done/error/interrupted/withdrawn, or the server's `gone`.

import { END_EVENTS, KNOBS, type Command, type MessageCommand, type MessageEvent, type PollRequest, type RegisterRequest, type SessionInfo, type SessionState } from "@plannotator/byoa-protocol";
import { randomId } from "./crypto.ts";
import type { EventsOutcome, Hub, HubConfig, PollOutcome, RegisterOutcome, SendInput, SendOutcome } from "./store.ts";
import type { GoneReason, HubEvent, InterruptOutcome } from "./types.ts";

const GONE_AFTER_MS = KNOBS.goneAfterSeconds * 1000;
const REDELIVER_AFTER_MS = KNOBS.redeliverAfterSeconds * 1000;
/** A gone session stays listed this long, so the UI can say "not running since". */
const LISTED_FOR_MS = 24 * 60 * 60 * 1000;
/** Memory guards per message (SPEC 9.7): bytes kept for the UI, and bytes
 * held ahead of a `seq` gap. Past the first the UI view ends `gone`; past
 * the second the events door answers `seq_gap`. */
const BUFFERED_BYTES_PER_MESSAGE = 1024 * 1024;
const EARLY_BYTES_PER_MESSAGE = 256 * 1024;

interface Tracked {
	command: MessageCommand;
	phase: "waiting" | "handed" | "answered";
	handedAt: number;
	nextSeq: number;
	early: Map<number, MessageEvent>;
	earlyBytes: number;
	interruptSent: boolean;
	/** What a listener that subscribes now is replayed: `accepted`, then the events so far. */
	log: HubEvent[];
	logBytes: number;
	/** The UI view already ended `gone` (continues_in_terminal). */
	cut: boolean;
}

interface Session {
	id: string;
	connectionId: string;
	request: RegisterRequest;
	state: SessionState;
	cause?: "permission";
	idleSince?: string;
	lastSeen: number;
	held: { resolve: (outcome: PollOutcome) => void; timer: unknown } | null;
	messages: Map<string, Tracked>;
	interrupts: string[];
	/** Its messages were already ended for going quiet. */
	swept: boolean;
	goneTimer: unknown;
	pruneTimer: unknown;
}

const byteSize = (value: unknown): number => JSON.stringify(value).length;

export class SessionHub implements Hub {
	readonly #config: HubConfig;
	readonly #sessions = new Map<string, Session>();
	readonly #listeners = new Set<(event: HubEvent) => void>();

	constructor(config: HubConfig) {
		this.#config = config;
	}

	register(connectionId: string, sessionId: string, request: RegisterRequest): RegisterOutcome {
		const now = this.#now();
		let session = this.#sessions.get(sessionId);
		if (session === undefined || session.connectionId !== connectionId) {
			// Only live sessions count; gone ones of this connection make room.
			const limit = this.#config.limits.sessionsPerConnection;
			let live = 0;
			for (const other of [...this.#sessions.values()]) {
				if (other.connectionId !== connectionId) continue;
				if (this.#isGone(other, now)) this.#forget(other, "stopped_polling");
				else live++;
			}
			if (live >= limit) return { kind: "too_many_sessions", limit };
		}
		if (session !== undefined && session.connectionId === connectionId) {
			// The same host session again: refresh what it declares, keep what it is owed.
			session.request = request;
			session.swept = false;
		} else {
			session = {
				id: sessionId,
				connectionId,
				request,
				state: "ready",
				lastSeen: now,
				held: null,
				messages: new Map(),
				interrupts: [],
				swept: false,
				goneTimer: null,
				pruneTimer: null,
			};
			this.#sessions.set(sessionId, session);
		}
		this.#seen(session, now);
		this.#emit({ type: "sessions_changed" });
		return { kind: "registered", session: this.#view(session, now) };
	}

	poll(connectionId: string, sessionId: string, request: PollRequest): Promise<PollOutcome> {
		const session = this.#owned(connectionId, sessionId);
		if (session === null) return Promise.resolve({ kind: "not_found" });
		const now = this.#now();
		this.#sweepIfGone(session, now);
		const changed =
			session.swept ||
			session.state !== request.state ||
			session.cause !== request.cause ||
			session.idleSince !== request.idle_since ||
			request.settings !== undefined;
		session.swept = false;
		session.state = request.state;
		session.cause = request.state === "blocked" ? request.cause : undefined;
		session.idleSince = request.idle_since;
		if (request.settings !== undefined) session.request = { ...session.request, capabilities: { ...session.request.capabilities, settings: request.settings } };
		// One held poll per session: the newer one takes over.
		this.#answerHeld(session, { kind: "commands", commands: [] });
		this.#seen(session, now);
		if (changed) this.#emit({ type: "sessions_changed" });
		const commands = this.#take(session, now);
		if (commands.length > 0 || this.#config.pollHoldMs === 0) return Promise.resolve({ kind: "commands", commands });
		return new Promise((resolve) => {
			const timer = this.#config.clock.setTimeout(() => {
				if (session.held?.timer === timer) this.#answerHeld(session, { kind: "commands", commands: [] });
			}, this.#config.pollHoldMs);
			session.held = { resolve, timer };
			this.#clearTimer(session, "goneTimer");
		});
	}

	postEvents(connectionId: string, sessionId: string, events: MessageEvent[]): EventsOutcome {
		const session = this.#owned(connectionId, sessionId);
		if (session === null) return { kind: "not_found" };
		for (const event of events) {
			const message = session.messages.get(event.message_id);
			// Unknown, finished, or forgotten in a restart: accepted and dropped.
			if (message === undefined) continue;
			if (!this.#accept(session, message, event)) return { kind: "seq_gap", message_id: event.message_id, expected: message.nextSeq };
		}
		return { kind: "accepted" };
	}

	send(sessionId: string, input: SendInput): SendOutcome {
		const session = this.#sessions.get(sessionId);
		if (session === undefined) return refuse(404, "session_not_found", "No such session.");
		const now = this.#now();
		// A gone session still takes messages: they wait here until it polls
		// again (the id is stable across a restart), so the app need not hold
		// them itself (Machine, AppNotes). The UI sees the session `gone`.
		this.#sweepIfGone(session, now);
		const capabilities = session.request.capabilities;
		if (input.interrupt_first && !capabilities.interrupt) return refuse(422, "validation_error", "interrupt_first: this session cannot interrupt.");
		if (input.set !== undefined) {
			for (const [id, value] of Object.entries(input.set)) {
				const setting = capabilities.settings.find((s) => s.id === id);
				if (setting === undefined) return refuse(422, "validation_error", `set.${id}: this session declared no such setting.`);
				if (setting.choices.length > 0 && !setting.choices.some((c) => c.value === value)) return refuse(422, "validation_error", `set.${id}: not one of its choices.`);
			}
		}
		const command: MessageCommand = {
			type: "message",
			message_id: randomId("msg_"),
			kind: input.kind,
			from: input.from,
			text: input.text,
			interrupt_first: input.interrupt_first,
			stream: input.stream && capabilities.stream,
			...(input.set !== undefined ? { set: input.set } : {}),
		};
		const message: Tracked = { command, phase: "waiting", handedAt: 0, nextSeq: 0, early: new Map(), earlyBytes: 0, interruptSent: false, log: [], logBytes: 0, cut: false };
		session.messages.set(command.message_id, message);
		this.#log(session, message, { type: "accepted", session_id: session.id, message_id: command.message_id, kind: command.kind, text: command.text, from: command.from }, true);
		this.#wake(session);
		return { kind: "sent", message_id: command.message_id };
	}

	interrupt(sessionId: string, messageId: string): InterruptOutcome | null {
		const session = this.#sessions.get(sessionId);
		if (session === undefined) return null;
		this.#sweepIfGone(session, this.#now());
		const message = session.messages.get(messageId);
		if (message === undefined) return "already_finished";
		if (message.phase === "waiting") {
			// No poll took it: it never reaches the session.
			this.#log(session, message, { type: "event", session_id: session.id, message_id: messageId, event: { type: "withdrawn", reason: "stopped" } }, true);
			this.#finish(session, message);
			return "withdrawn";
		}
		if (!message.interruptSent) {
			// Stop handing it out; the connector answers withdrawn or interrupted.
			message.interruptSent = true;
			message.phase = "answered";
			session.interrupts.push(messageId);
			this.#wake(session);
		}
		return "interrupt_sent";
	}

	list(): SessionInfo[] {
		const now = this.#now();
		for (const session of [...this.#sessions.values()]) {
			this.#sweepIfGone(session, now);
			if (this.#isGone(session, now) && now - session.lastSeen > LISTED_FOR_MS) this.#forget(session, "stopped_polling");
		}
		return [...this.#sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen).map((s) => this.#view(s, now));
	}

	dropConnection(connectionId: string): void {
		let dropped = false;
		for (const session of [...this.#sessions.values()]) {
			if (session.connectionId !== connectionId) continue;
			this.#answerHeld(session, { kind: "revoked" });
			this.#forget(session, "disconnected");
			dropped = true;
		}
		if (dropped) this.#emit({ type: "sessions_changed" });
	}

	/** In memory, delivery never fails, so `onEnd` is never called. */
	subscribe(listener: (event: HubEvent) => void, _onEnd?: () => void): () => void {
		this.#listeners.add(listener);
		const replay: HubEvent[] = [{ type: "sessions_changed" }];
		for (const session of this.#sessions.values()) for (const message of session.messages.values()) replay.push(...message.log);
		for (const event of replay) call(listener, event);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	// ── internals ──────────────────────────────────────────────────────────

	#now(): number {
		return this.#config.clock.now();
	}

	#owned(connectionId: string, sessionId: string): Session | null {
		const session = this.#sessions.get(sessionId);
		return session !== undefined && session.connectionId === connectionId ? session : null;
	}

	/** The commands a poll hands out now: messages no poll took yet, and once
	 * more any handed out 30 s ago with no event since; then the Stops. */
	#take(session: Session, now: number): Command[] {
		const commands: Command[] = [];
		for (const message of session.messages.values()) {
			if (message.phase === "answered") continue;
			if (message.phase === "handed" && now - message.handedAt < REDELIVER_AFTER_MS) continue;
			message.phase = "handed";
			message.handedAt = now;
			commands.push(message.command);
		}
		for (const messageId of session.interrupts) commands.push({ type: "interrupt", message_id: messageId });
		session.interrupts = [];
		return commands;
	}

	#wake(session: Session): void {
		if (session.held === null) return;
		const commands = this.#take(session, this.#now());
		if (commands.length > 0) this.#answerHeld(session, { kind: "commands", commands });
	}

	#answerHeld(session: Session, outcome: PollOutcome): void {
		const held = session.held;
		if (held === null) return;
		this.#config.clock.clearTimeout(held.timer);
		session.held = null;
		this.#seen(session, this.#now());
		held.resolve(outcome);
	}

	/** One event from the connector, in `seq` order with repeats dropped. An
	 * end event flushes whatever arrived ahead of a gap and ends the message,
	 * so a lost middle step never holds the end. False when the event is
	 * past the look-ahead guards: nothing is kept for it. */
	#accept(session: Session, message: Tracked, event: MessageEvent): boolean {
		if (event.seq < message.nextSeq || message.early.has(event.seq)) return true;
		const ahead = event.seq > message.nextSeq;
		if (ahead) {
			const size = byteSize(event);
			if (event.seq - message.nextSeq > this.#config.limits.seqLookAhead || message.earlyBytes + size > EARLY_BYTES_PER_MESSAGE) return false;
			message.early.set(event.seq, event);
			message.earlyBytes += size;
		}
		message.phase = "answered";
		if (END_EVENTS.has(event.type)) {
			if (!ahead) message.early.set(event.seq, event);
			for (const seq of [...message.early.keys()].sort((a, b) => a - b)) {
				const next = message.early.get(seq) as MessageEvent;
				this.#deliver(session, message, next);
				if (END_EVENTS.has(next.type)) break;
			}
			this.#finish(session, message);
			return true;
		}
		if (ahead) return true;
		this.#deliver(session, message, event);
		message.nextSeq = event.seq + 1;
		for (let next = message.early.get(message.nextSeq); next !== undefined; next = message.early.get(message.nextSeq)) {
			message.early.delete(message.nextSeq);
			message.earlyBytes -= byteSize(next);
			this.#deliver(session, message, next);
			message.nextSeq++;
		}
		return true;
	}

	#deliver(session: Session, message: Tracked, event: MessageEvent): void {
		const { message_id, ...body } = event;
		this.#log(session, message, { type: "event", session_id: session.id, message_id, event: body });
	}

	/** Keep an event for replay and fan it out. Past the per-message bound the
	 * UI view ends `gone` (continues_in_terminal) and later events are not
	 * kept; the turn itself goes on in the terminal. */
	#log(session: Session, message: Tracked, event: HubEvent, always = false): void {
		if (message.cut) return;
		const size = byteSize(event);
		if (!always && (message.log.length >= this.#config.limits.bufferedEventsPerMessage || message.logBytes + size > BUFFERED_BYTES_PER_MESSAGE)) {
			message.cut = true;
			event = { type: "gone", session_id: session.id, message_id: message.command.message_id, reason: "continues_in_terminal" };
		}
		message.log.push(event);
		message.logBytes += size;
		this.#emit(event);
	}

	#finish(session: Session, message: Tracked): void {
		session.messages.delete(message.command.message_id);
		session.interrupts = session.interrupts.filter((id) => id !== message.command.message_id);
	}

	#endGone(session: Session, message: Tracked, reason: GoneReason): void {
		if (!message.cut) this.#emit({ type: "gone", session_id: session.id, message_id: message.command.message_id, reason });
		this.#finish(session, message);
	}

	#isGone(session: Session, now: number): boolean {
		return session.held === null && now - session.lastSeen >= GONE_AFTER_MS;
	}

	/** A poll or register arrived (or a held poll ended): the gone clock restarts. */
	#seen(session: Session, now: number): void {
		session.lastSeen = now;
		this.#clearTimer(session, "pruneTimer");
		this.#clearTimer(session, "goneTimer");
		if (session.held !== null) return;
		session.goneTimer = this.#config.clock.setTimeout(() => {
			session.goneTimer = null;
			this.#sweepIfGone(session, this.#now());
		}, GONE_AFTER_MS);
	}

	/** A session that stopped polling: its open messages end `gone`, the UI
	 * hears the list changed, and it is forgotten after it stops being listed. */
	#sweepIfGone(session: Session, now: number): void {
		if (session.swept || !this.#isGone(session, now) || this.#sessions.get(session.id) !== session) return;
		session.swept = true;
		// Only what a poll took is lost with the session; a message still
		// waiting goes out when the session polls again.
		for (const message of [...session.messages.values()]) if (message.phase !== "waiting") this.#endGone(session, message, "stopped_polling");
		session.interrupts = [];
		this.#emit({ type: "sessions_changed" });
		session.pruneTimer = this.#config.clock.setTimeout(() => {
			if (this.#isGone(session, this.#now())) this.#forget(session, "stopped_polling");
		}, LISTED_FOR_MS);
	}

	#forget(session: Session, reason: GoneReason): void {
		for (const message of [...session.messages.values()]) this.#endGone(session, message, reason);
		this.#clearTimer(session, "goneTimer");
		this.#clearTimer(session, "pruneTimer");
		this.#sessions.delete(session.id);
	}

	#clearTimer(session: Session, which: "goneTimer" | "pruneTimer"): void {
		if (session[which] !== null) this.#config.clock.clearTimeout(session[which]);
		session[which] = null;
	}

	#emit(event: HubEvent): void {
		for (const listener of [...this.#listeners]) call(listener, event);
	}

	#view(session: Session, now: number): SessionInfo {
		const r = session.request;
		const gone = this.#isGone(session, now);
		return {
			id: session.id,
			connection_id: session.connectionId,
			host: r.host,
			workspace: r.workspace,
			state: gone ? "gone" : session.state,
			...(!gone && session.state === "blocked" && session.cause !== undefined ? { cause: session.cause } : {}),
			...(session.idleSince !== undefined ? { idle_since: session.idleSince } : {}),
			started_at: r.started_at,
			last_seen_at: new Date(session.lastSeen).toISOString(),
			capabilities: r.capabilities,
		};
	}
}

function refuse(status: 404 | 409 | 422, error: string, description: string): SendOutcome {
	return { kind: "refused", status, error, description };
}

function call(listener: (event: HubEvent) => void, event: HubEvent): void {
	try {
		listener(event);
	} catch {
		// A listener's failure is its own; the others still hear the event.
	}
}

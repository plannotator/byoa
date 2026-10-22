// GENERATED from packages/connector-core/src/link.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// The door client for ONE app and ONE host session (forked from Workspaces'
// SessionLink): register, the poll, the events, with that app's token. It
// holds no timer and never waits on the network inside `tick()`; each request
// it starts finishes on its own.
//
//   register ──200──▶ poll ──200──▶ poll again: at once when the app holds
//      ▲                │          polls, after `poll_interval_seconds` when
//      └──── 404 ───────┘          it holds 0 (answers at once)
//
//   404: the app forgot the session (a restart): register again, after a
//       short jittered wait; the app answers the same session id.
//   401 on any door: the token was revoked. Stop; nothing is deleted.
//   403, or 4xx on register: this session cannot be held here. Stop.
//   network errors, 5xx, 429: back off with jitter (backoff.ts) and retry.
//
// Presence: the poll body is the only signal (SPEC 5.2). When the session's
// state or a setting changes, the link polls again at once with the new body;
// the app answers the older poll with an empty list. That answer is ours, so
// it starts nothing and is not counted below.
//
// Two processes on one host session (`claude --continue` twice) poll the
// same session id, and the newest poll answers the other at once with an
// empty list. An empty answer faster than FAST_ANSWER_MS from an app that
// holds polls waits 1 to 2 s with jitter, doubling up to 30 s, so the two
// slow down together instead of spinning, and status says why.
//
// Events go out in batches from the outbox: one POST at a time, resent as
// they were after a failure, rewound on `422 seq_gap`.
//
// Retiring (the host session is gone): no more polls; post what is owed,
// then stop, or stop after RETIRE_FOR_MS anyway (the app ends the messages
// itself when the session reads gone).

import { backoffMs } from "./backoff.ts";
import { door, type Answer } from "./doors.ts";
import { Outbox } from "./outbox.ts";
import type { Clock, HttpPort } from "./ports.ts";
import {
	isRecord,
	parsePollResponse,
	parseRegisterResponse,
	parseWireError,
	type Command,
	type MessageEventBody,
	type PollRequest,
	type RegisterRequest,
} from "./protocol.ts";
import { retryAfter } from "./clean.ts";
import { CONNECTOR_VERSION } from "./version.ts";

/** An empty poll answer faster than this was not held by the app. */
export const FAST_ANSWER_MS = 1_000;
/** After this many fast empty answers in a row, status says the session
 * seems open in another terminal too. */
export const CONTENDED_AFTER = 3;
/** The least time between two events POSTs, so a streaming answer goes out
 * in batches rather than one POST per chunk. */
export const MIN_POST_GAP_MS = 250;
export const RETIRE_FOR_MS = 30_000;

export type LinkState =
	| { kind: "registering" }
	| { kind: "live"; sessionId: string; updateNeeded: boolean }
	| { kind: "retrying"; message: string }
	| { kind: "revoked" }
	| { kind: "refused"; message: string }
	| { kind: "stopped" };

export interface LinkDeps {
	origin: string;
	/** The app's `sessions` endpoint, absolute. */
	sessions: string;
	pollHoldSeconds: number;
	pollIntervalSeconds: number;
	token: string;
	http: HttpPort;
	now: Clock;
	random: () => number;
	declaration: () => Promise<RegisterRequest>;
	/** The poll body now. Compared with the last one sent on every tick. */
	pollBody: () => PollRequest;
	onCommands: (commands: Command[]) => void;
	onState?: (state: LinkState) => void;
}

export class Link {
	readonly outbox = new Outbox();
	readonly #d: LinkDeps;
	#state: LinkState = { kind: "registering" };
	#sessionId: string | null = null;
	#stopped = false;
	#retireBy: number | null = null;
	#registering = false;
	#polling = false;
	#posting = false;
	#registerFailures = 0;
	#pollFailures = 0;
	#postFailures = 0;
	#nextRegisterAt = 0;
	#nextPollAt = 0;
	#nextPostAt = 0;
	#fastEmpties = 0;
	#losses = 0;
	#pollGen = 0;
	#lastBody = "";
	readonly #inflight = new Set<Promise<unknown>>();

	constructor(deps: LinkDeps) {
		this.#d = deps;
	}

	get state(): LinkState {
		return this.#state;
	}

	get sessionId(): string | null {
		return this.#sessionId;
	}

	get contended(): boolean {
		return this.#fastEmpties >= CONTENDED_AFTER;
	}

	get done(): boolean {
		return this.#stopped;
	}

	/** Starts whatever is due. Never waits on the network. */
	tick(): void {
		if (this.#stopped) return;
		const now = this.#d.now();
		if (this.#retireBy !== null) {
			if (now >= this.#retireBy) return this.stop();
			this.#flush();
			return this.#finishRetiring();
		}
		if (this.#sessionId === null) {
			if (!this.#registering && now >= this.#nextRegisterAt) this.#track(this.#register());
			return;
		}
		const changed = JSON.stringify(this.#d.pollBody()) !== this.#lastBody;
		// A new poll at once when the state changed (it supersedes a held one),
		// or when the next one is due.
		if ((changed && this.#pollFailures === 0 && !this.contended) || (!this.#polling && now >= this.#nextPollAt)) this.#track(this.#poll());
		this.#flush();
	}

	/** Queues an event for a message and posts it as soon as it may. */
	emit(messageId: string, event: MessageEventBody): void {
		if (this.#stopped) return;
		this.outbox.add(messageId, event);
		this.#flush();
	}

	/** The host session is gone: no more polls; post what is owed, then stop. */
	retire(): void {
		if (this.#stopped || this.#retireBy !== null) return;
		this.#retireBy = this.#d.now() + RETIRE_FOR_MS;
		this.#pollGen += 1;
		if (this.#sessionId === null) return this.stop();
		this.#flush();
		this.#finishRetiring();
	}

	/** No more requests. In-flight ones finish and are ignored. */
	stop(): void {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#set({ kind: "stopped" });
	}

	/** Resolves when nothing this link started is in flight (tests). */
	async settled(): Promise<void> {
		while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
	}

	// ── register ───────────────────────────────────────────────────────────

	async #register(): Promise<void> {
		this.#registering = true;
		try {
			const res = await this.#request(this.#d.sessions, await this.#d.declaration());
			if (this.#stopped || this.#retireBy !== null) return;
			if (res.kind === "network") return this.#retryRegister(res.message, null);
			if (res.status === 200) {
				const reg = parseRegisterResponse(res.json);
				if (!reg.ok) return this.#retryRegister("its answer to register was not readable", null);
				this.#registerFailures = 0;
				this.#sessionId = reg.value.session.id;
				const minimum = isRecord(res.json) && typeof res.json.minimum_connector_version === "string" ? res.json.minimum_connector_version : "0";
				this.#set({ kind: "live", sessionId: reg.value.session.id, updateNeeded: olderThan(CONNECTOR_VERSION, minimum) });
				this.#lastBody = "";
				this.#nextPollAt = 0;
				this.#nextPostAt = 0;
				return;
			}
			if (this.#endsHere(res)) return;
			if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408)
				return this.#refuse(describeError(res) ?? "the app refused this session");
			return this.#retryRegister(`the app answered ${res.status}`, retryAfter(res.headers));
		} finally {
			this.#registering = false;
			if (this.#sessionId !== null && !this.#stopped && this.#retireBy === null) {
				if (!this.#polling) this.#track(this.#poll());
				this.#flush();
			}
		}
	}

	#retryRegister(message: string, retryAfterSeconds: number | null): void {
		this.#registerFailures += 1;
		this.#nextRegisterAt = this.#d.now() + backoffMs(this.#registerFailures, this.#d.random, retryAfterSeconds);
		this.#set({ kind: "retrying", message });
	}

	// ── the poll ───────────────────────────────────────────────────────────

	async #poll(): Promise<void> {
		const sessionId = this.#sessionId;
		if (this.#stopped || this.#retireBy !== null || sessionId === null) return;
		const gen = ++this.#pollGen;
		this.#polling = true;
		const body = this.#d.pollBody();
		this.#lastBody = JSON.stringify(body);
		const startedAt = this.#d.now();
		const held = this.#d.pollHoldSeconds > 0;
		let again = false;
		try {
			const res = await this.#request(`${this.#d.sessions}/${encodeURIComponent(sessionId)}/poll`, body);
			if (this.#stopped) return;
			if (gen !== this.#pollGen) {
				// Superseded by our own newer poll (or retired): its answer is
				// normally an empty list; commands it carries anyway are kept.
				const commands = res.kind === "answer" && res.status === 200 ? this.#commands(res.json) : null;
				if (commands !== null && commands.length > 0) this.#d.onCommands(commands);
				return;
			}
			if (res.kind === "network") return this.#retryPoll(res.message, null);
			if (res.status === 200) {
				const commands = this.#commands(res.json);
				if (commands === null) return this.#retryPoll("its answer to a poll was not readable", null);
				this.#pollFailures = 0;
				this.#losses = 0;
				if (this.#state.kind === "retrying") this.#set({ kind: "live", sessionId, updateNeeded: false });
				if (commands.length > 0) {
					this.#fastEmpties = 0;
					this.#d.onCommands(commands);
				} else if (held && this.#d.now() - startedAt < FAST_ANSWER_MS) {
					// Not held: another process polls this session too.
					this.#fastEmpties += 1;
					this.#nextPollAt = this.#d.now() + backoffMs(this.#fastEmpties + 1, this.#d.random);
					return;
				} else this.#fastEmpties = 0;
				if (held) again = true;
				else this.#nextPollAt = this.#d.now() + this.#d.pollIntervalSeconds * 1000;
				return;
			}
			if (res.status === 404) return this.#lost(sessionId);
			if (this.#endsHere(res)) return;
			return this.#retryPoll(`the app answered ${res.status}`, retryAfter(res.headers));
		} finally {
			if (gen === this.#pollGen) {
				this.#polling = false;
				if (again && !this.#stopped && this.#retireBy === null && this.#sessionId !== null) this.#track(this.#poll());
			}
		}
	}

	/** The commands it could read; the parser skips one it cannot (a newer
	 * app) so it does not hide the others. Null when the body is not a poll answer. */
	#commands(json: unknown): Command[] | null {
		const parsed = parsePollResponse(json);
		return parsed.ok ? parsed.value.commands : null;
	}

	#retryPoll(message: string, retryAfterSeconds: number | null): void {
		this.#pollFailures += 1;
		this.#nextPollAt = this.#d.now() + backoffMs(this.#pollFailures, this.#d.random, retryAfterSeconds);
		this.#set({ kind: "retrying", message });
	}

	// ── events ─────────────────────────────────────────────────────────────

	#flush(): void {
		if (this.#posting || this.#stopped || this.#sessionId === null || !this.outbox.pending) return;
		if (this.#nextPostAt > this.#d.now()) return; // the next tick sends it
		this.#track(this.#post());
	}

	async #post(): Promise<void> {
		const sessionId = this.#sessionId;
		if (this.#posting || this.#stopped || sessionId === null) return;
		const batch = this.outbox.nextBatch();
		if (batch.length === 0) return;
		this.#posting = true;
		let again = false;
		try {
			const res = await this.#request(`${this.#d.sessions}/${encodeURIComponent(sessionId)}/events`, { events: batch });
			if (this.#stopped) return;
			if (res.kind === "network") return this.#retryPost(null);
			if (res.status === 204 || res.status === 200) {
				this.outbox.taken(batch);
				this.#postFailures = 0;
				this.#nextPostAt = this.#d.now() + MIN_POST_GAP_MS;
				again = true;
				return;
			}
			if (res.status === 404) return this.#lost(sessionId);
			if (this.#endsHere(res)) return;
			if (res.status === 422) {
				const gap = seqGap(res.json);
				if (gap !== null) this.outbox.gap(gap.messageId ?? (batch[0]?.message_id as string), gap.expected);
				// Any other 422 names something no resend fixes.
				else this.outbox.dropped(batch);
				again = true;
				return;
			}
			return this.#retryPost(retryAfter(res.headers));
		} finally {
			this.#posting = false;
			if (again) this.#flush();
			this.#finishRetiring();
		}
	}

	#retryPost(retryAfterSeconds: number | null): void {
		this.#postFailures += 1;
		this.#nextPostAt = this.#d.now() + backoffMs(this.#postFailures, this.#d.random, retryAfterSeconds);
	}

	// ── endings ────────────────────────────────────────────────────────────

	#finishRetiring(): void {
		if (this.#retireBy !== null && !this.#stopped && !this.#posting && !this.outbox.pending) this.stop();
	}

	/** 404: the app forgot the session. Register the same host session again. */
	#lost(sessionId: string): void {
		if (this.#sessionId !== sessionId) return;
		if (this.#retireBy !== null) return this.stop();
		this.#sessionId = null;
		this.#pollGen += 1;
		this.#polling = false;
		this.#losses += 1;
		this.#nextRegisterAt = this.#d.now() + backoffMs(this.#losses, this.#d.random);
		this.#set({ kind: "registering" });
	}

	/** 401 and 403 end the link on every door. */
	#endsHere(res: Extract<Answer, { kind: "answer" }>): boolean {
		if (res.status === 401) {
			this.#stopped = true;
			this.#set({ kind: "revoked" });
			return true;
		}
		if (res.status === 403) {
			this.#refuse(describeError(res) ?? "this connection cannot hold a session");
			return true;
		}
		return false;
	}

	#refuse(message: string): void {
		this.#stopped = true;
		this.#set({ kind: "refused", message });
	}

	#set(state: LinkState): void {
		this.#state = state;
		this.#d.onState?.(state);
	}

	#track(p: Promise<unknown>): void {
		const tracked: Promise<unknown> = p.catch(() => undefined).finally(() => this.#inflight.delete(tracked));
		this.#inflight.add(tracked);
	}

	#request(url: string, body: unknown): Promise<Answer> {
		return door(this.#d.http, { origin: this.#d.origin, url, method: "POST", token: this.#d.token, body });
	}
}

function describeError(res: Extract<Answer, { kind: "answer" }>): string | null {
	const err = parseWireError(res.json);
	return err === null ? null : (err.error_description ?? err.error);
}

/** `422 seq_gap`: `expected`, and `message_id` when the app names it. */
function seqGap(json: unknown): { expected: number; messageId: string | null } | null {
	if (!isRecord(json) || json.error !== "seq_gap" || typeof json.expected !== "number" || json.expected < 0) return null;
	return { expected: json.expected, messageId: typeof json.message_id === "string" ? json.message_id : null };
}

/** True when version `a` is older than `b` (dotted numbers; anything else
 * compares as 0). */
export function olderThan(a: string, b: string): boolean {
	const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x !== y) return x < y;
	}
	return false;
}

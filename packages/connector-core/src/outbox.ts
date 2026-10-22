// The events one session owes one app, per message, numbered with `seq` from
// 0 and posted in order (forked from Workspaces' outbox). The app drops a
// repeated `seq`, so a batch that failed on the network is posted again as it
// was. Each message keeps its events until the app has taken all of them
// through its end event, so `422 seq_gap { message_id, expected }` can be
// answered by resending that message from `expected`.

import { END_EVENTS, LIMITS, type MessageEvent, type MessageEventBody } from "./protocol.ts";

/** One POST's events: far under any sane body bound. Plumbing: a longer
 * answer goes in more batches. */
export const MAX_BATCH_BYTES = 192 * 1024;

interface MessageLog {
	events: MessageEvent[];
	/** Every event below this `seq` the app has. */
	taken: number;
	ended: boolean;
}

export class Outbox {
	readonly #logs = new Map<string, MessageLog>();

	/** Adds one event (several for a long delta). Nothing is added after the
	 * message's end event. */
	add(messageId: string, body: MessageEventBody): void {
		let log = this.#logs.get(messageId);
		if (log === undefined) {
			log = { events: [], taken: 0, ended: false };
			this.#logs.set(messageId, log);
		}
		if (log.ended) return;
		const bodies: MessageEventBody[] =
			body.type === "delta" ? splitText(body.text, LIMITS.delta).map((text) => ({ type: "delta", text })) : [body];
		for (const b of bodies) log.events.push({ ...b, message_id: messageId, seq: log.events.length } as MessageEvent);
		if (END_EVENTS.has(body.type)) log.ended = true;
	}

	get pending(): boolean {
		for (const log of this.#logs.values()) if (log.taken < log.events.length) return true;
		return false;
	}

	/** The next events to post, each message's untaken events in order,
	 * within MAX_BATCH_BYTES and LIMITS.eventsPerRequest. */
	nextBatch(): MessageEvent[] {
		const batch: MessageEvent[] = [];
		let bytes = 16;
		for (const log of this.#logs.values()) {
			for (let seq = log.taken; seq < log.events.length; seq++) {
				const event = log.events[seq] as MessageEvent;
				const size = utf8Length(JSON.stringify(event)) + 1;
				if (batch.length > 0 && (bytes + size > MAX_BATCH_BYTES || batch.length >= LIMITS.eventsPerRequest)) return batch;
				batch.push(event);
				bytes += size;
			}
		}
		return batch;
	}

	/** The app took the whole batch (204). */
	taken(batch: readonly MessageEvent[]): void {
		for (const event of batch) this.#take(event.message_id, event.seq + 1);
	}

	/** `422 seq_gap`: the app has `messageId` below `expected`. Only that
	 * message is rewound; the rest of the batch is posted again and the app
	 * drops what it already has. */
	gap(messageId: string, expected: number): void {
		const log = this.#logs.get(messageId);
		if (log !== undefined) log.taken = Math.max(0, Math.min(expected, log.events.length));
	}

	/** Any other refusal: an event the app will never take must not block
	 * every later one. */
	dropped(batch: readonly MessageEvent[]): void {
		this.taken(batch);
	}

	/** Messages with events not yet taken or not yet ended. */
	get open(): number {
		return this.#logs.size;
	}

	#take(messageId: string, through: number): void {
		const log = this.#logs.get(messageId);
		if (log === undefined) return;
		if (through > log.taken) log.taken = Math.min(through, log.events.length);
		if (log.ended && log.taken >= log.events.length) this.#logs.delete(messageId);
	}
}

/** Cuts text into pieces of at most `max` UTF-16 units, never inside a
 * surrogate pair. */
export function splitText(text: string, max: number): string[] {
	if (text.length <= max) return [text];
	const out: string[] = [];
	let piece = "";
	for (const ch of text) {
		if (piece.length + ch.length > max) {
			out.push(piece);
			piece = "";
		}
		piece += ch;
	}
	if (piece.length > 0) out.push(piece);
	return out;
}

/** UTF-8 byte length without TextEncoder (not a language global). */
export function utf8Length(text: string): number {
	let n = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
			n += 4;
			i += 1;
		} else n += 3;
	}
	return n;
}

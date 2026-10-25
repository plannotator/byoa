// A scripted clock for tests: time moves only when a test calls advance(),
// and due timers fire in order. Shared by this package's own tests and the
// store conformance suite, so it uses no Node API and runs in workerd too.

import type { Clock } from "./types.ts";

/** Let pending promise chains run. Not a sleep: a FakeClock does not move.
 * Microtasks alone are not enough: Web Crypto's digest resolves from a
 * macrotask on Node, so each round also yields one zero-delay timer, which
 * every runtime (Node, Bun, Deno, browsers, workerd) has. */
export async function settle(rounds = 10): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		for (let j = 0; j < 10; j++) await Promise.resolve();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

interface Timer {
	at: number;
	fn: () => void;
}

export class FakeClock implements Clock {
	t: number;
	#timers = new Map<number, Timer>();
	#next = 1;
	readonly #settle: () => Promise<void>;

	/** `settle` waits for pending work before and after time moves; the
	 * default suits in-memory code. */
	constructor(start = Date.parse("2026-10-21T12:00:00Z"), settleFn: () => Promise<void> = () => settle()) {
		this.t = start;
		this.#settle = settleFn;
	}

	now(): number {
		return this.t;
	}

	setTimeout(fn: () => void, ms: number): unknown {
		const id = this.#next++;
		this.#timers.set(id, { at: this.t + ms, fn });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.#timers.delete(handle as number);
	}

	/** Move time forward, firing due timers in order. */
	async advance(ms: number): Promise<void> {
		// Requests already in flight reach their timers before time moves.
		await this.#settle();
		const end = this.t + ms;
		for (;;) {
			let due: [number, Timer] | undefined;
			for (const entry of this.#timers) if (entry[1].at <= end && (due === undefined || entry[1].at < due[1].at)) due = entry;
			if (due === undefined) break;
			this.#timers.delete(due[0]);
			this.t = due[1].at;
			due[1].fn();
			await this.#settle();
		}
		this.t = end;
		await this.#settle();
	}
}

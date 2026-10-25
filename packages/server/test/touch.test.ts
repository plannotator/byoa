// The last-seen write: at most one touch per connection a minute, also when
// the app builds createByoa (and so its context) anew for each request.

import assert from "node:assert/strict";
import { test } from "node:test";
import { body, makeApp } from "./harness.ts";

test("two createByoa instances over one store: polls through both touch once a minute", async () => {
	const a = makeApp({ pollHoldSeconds: 0 });
	const b = makeApp({ pollHoldSeconds: 0, store: a.store, clock: a.clock });
	const touches: number[] = [];
	const real = a.store.connections.touch;
	a.store.connections.touch = (id, now) => {
		touches.push(now);
		return real(id, now);
	};
	const t0 = a.clock.now();
	const { token, connectionId } = await a.pair();
	const id = await a.register(token);
	const registeredAt = a.clock.now();
	assert.deepEqual(touches, [registeredAt], "register always touches");

	for (let i = 0; i < 5; i++) {
		await body(a.poll(token, id));
		await body(b.poll(token, id));
		await a.clock.advance(10_000);
	}
	assert.deepEqual(touches, [registeredAt], "no poll within the minute touches, whichever instance it reached");

	await a.clock.advance(10_000);
	await body(b.poll(token, id));
	await body(a.poll(token, id));
	await body(b.poll(token, id));
	assert.equal(touches.length, 2, "one touch once the minute passed");
	assert.equal((await a.store.connections.get(connectionId))?.last_seen_at, touches[1]);
	assert.ok(touches[1] !== undefined && touches[1] - registeredAt >= 60_000 && registeredAt >= t0);
});

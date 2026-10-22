// Rule 7: events in `seq` order with repeats dropped, seq_gap past the
// look-ahead, exactly one end, unknown messages accepted and dropped, and
// the per-message buffer bound ending the UI view `gone`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { body, makeApp, settle } from "./harness.ts";

async function setup(limits = {}) {
	const app = makeApp({ limits });
	const { token } = await app.pair();
	const id = await app.register(token);
	const watch = app.watch();
	const { message_id } = await body(app.send("ramos", id, { text: "go" }));
	await body(app.poll(token, id));
	const kinds = async () => {
		await settle();
		return watch.messages(message_id).map((e) => (e.type === "event" ? `${e.event.type}:${e.event.seq}` : e.type));
	};
	return { app, token, id, message_id, kinds, watch };
}

test("duplicates dropped, out-of-order events reordered, then one end", async () => {
	const { app, token, id, message_id: m, kinds } = await setup();
	assert.equal((await app.events(token, id, [{ message_id: m, seq: 0, type: "started" }, { message_id: m, seq: 0, type: "started" }])).status, 204);
	await app.events(token, id, [{ message_id: m, seq: 2, type: "delta", text: "b" }]);
	await app.events(token, id, [{ message_id: m, seq: 1, type: "delta", text: "a" }, { message_id: m, seq: 2, type: "delta", text: "b" }]);
	await app.events(token, id, [{ message_id: m, seq: 3, type: "done" }]);
	// After the end, more events for it are ignored, an end included.
	assert.equal((await app.events(token, id, [{ message_id: m, seq: 4, type: "delta", text: "late" }, { message_id: m, seq: 5, type: "error", reason: "x" }])).status, 204);
	assert.deepEqual(await kinds(), ["accepted", "started:0", "delta:1", "delta:2", "done:3"]);
});

test("too far ahead answers 422 seq_gap with the seq to resend from", async () => {
	const { app, token, id, message_id: m } = await setup({ seqLookAhead: 4 });
	await app.events(token, id, [{ message_id: m, seq: 0, type: "started" }]);
	assert.equal((await app.events(token, id, [{ message_id: m, seq: 5, type: "delta", text: "x" }])).status, 204);
	const res = await app.events(token, id, [{ message_id: m, seq: 6, type: "delta", text: "x" }]);
	assert.equal(res.status, 422);
	assert.deepEqual(await body(res), { error: "seq_gap", error_description: `Resend ${m} from seq 1.`, message_id: m, expected: 1 });
});

test("an end ahead of a gap flushes what arrived and ends the message", async () => {
	const { app, token, id, message_id: m, kinds } = await setup();
	await app.events(token, id, [{ message_id: m, seq: 0, type: "started" }, { message_id: m, seq: 2, type: "delta", text: "b" }, { message_id: m, seq: 3, type: "error", reason: "host failed" }]);
	assert.deepEqual(await kinds(), ["accepted", "started:0", "delta:2", "error:3"]);
});

test("an unknown message_id is accepted and dropped", async () => {
	const { app, token, id, kinds } = await setup();
	assert.equal((await app.events(token, id, [{ message_id: "msg_unknown", seq: 0, type: "done" }])).status, 204);
	assert.deepEqual(await kinds(), ["accepted"]);
	assert.equal((await app.events(token, id, [{ message_id: "m", seq: 0, type: "tool", name: "x", title: "y", phase: "start" }])).status, 204);
	assert.equal((await app.events(token, id, [{ message_id: "m", seq: -1, type: "done" }])).status, 422);
});

test("past the buffer bound the UI view ends gone continues_in_terminal; the turn goes on", async () => {
	const { app, token, id, message_id: m, kinds } = await setup({ bufferedEventsPerMessage: 3 });
	const deltas = Array.from({ length: 4 }, (_, i) => ({ message_id: m, seq: i, type: "delta", text: `${i}` }));
	await app.events(token, id, deltas);
	await app.events(token, id, [{ message_id: m, seq: 4, type: "done" }]);
	// accepted + 2 deltas fill 3; the third delta ends the view; the done is not shown.
	assert.deepEqual(await kinds(), ["accepted", "delta:0", "delta:1", "gone"]);
	const last = (await kinds()).at(-1);
	assert.equal(last, "gone");
});

test("a subscriber that joins mid-turn is replayed the message so far", async () => {
	const { app, token, id, message_id: m } = await setup();
	await app.events(token, id, [{ message_id: m, seq: 0, type: "started" }, { message_id: m, seq: 1, type: "delta", text: "a" }]);
	const late = app.watch();
	await settle();
	assert.deepEqual(
		late.seen.map((e) => e.type),
		["sessions", "accepted", "event", "event"],
	);
});

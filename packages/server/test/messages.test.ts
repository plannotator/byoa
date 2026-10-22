// Rule 6 (what a message may carry, and where it waits) and rule 9 (Stop:
// withdrawn, interrupt_sent, already_finished).

import assert from "node:assert/strict";
import { test } from "node:test";
import { body, makeApp, pending } from "./harness.ts";

async function setup() {
	const app = makeApp();
	const { token } = await app.pair();
	const id = await app.register(token, "h1", { interrupt: false, stream: false, settings: [{ id: "effort", name: "Effort", value: "high", choices: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }] });
	return { app, token, id };
}

test("text must be non-empty; kind, flags and set are checked", async () => {
	const { app, id } = await setup();
	const refused = async (payload: Record<string, unknown>) => {
		const res = await app.send("ramos", id, payload);
		assert.equal(res.status, 422, JSON.stringify(payload));
		return (await body(res)).error_description as string;
	};
	await refused({ text: "" });
	await refused({ text: "   \n" });
	await refused({});
	await refused({ text: "hi", kind: "shout" });
	assert.match(await refused({ text: "hi", interrupt_first: true }), /cannot interrupt/);
	assert.match(await refused({ text: "hi", set: { model: "opus" } }), /no such setting/);
	assert.match(await refused({ text: "hi", set: { effort: "max" } }), /choices/);
	assert.equal((await app.send("ramos", id, { text: "hi", set: { effort: "low" }, kind: "reply" })).status, 202);
	// The same rules on the server-side send.
	assert.deepEqual(await app.byoa.send("ramos", id, { text: " " }), { error: "validation_error", error_description: "text: must not be empty" });
	assert.equal(((await app.byoa.send("ramos", id, { text: "go", interruptFirst: true })) as { error: string }).error, "validation_error");
});

test("stream follows the session's capability", async () => {
	const { app, token, id } = await setup();
	await app.send("ramos", id, { text: "hi", stream: true });
	assert.equal((await body(app.poll(token, id))).commands[0].stream, false);
});

test("a message to a gone session waits and goes out when the session polls again", async () => {
	const { app, token, id } = await setup();
	await app.clock.advance(60_000);
	const res = await app.send("ramos", id, { text: "hi" });
	assert.equal(res.status, 202);
	const { message_id } = await body(res);
	const commands = (await body(app.poll(token, id))).commands;
	assert.equal(commands[0].message_id, message_id);
});

test("a message waits server-side for a session that is between polls", async () => {
	const { app, token, id } = await setup();
	await app.clock.advance(30_000);
	const sent = await body(app.send("ramos", id, { text: "first" }));
	const second = await body(app.send("ramos", id, { text: "second" }));
	await app.clock.advance(5_000);
	const commands = (await body(app.poll(token, id))).commands;
	assert.deepEqual(commands.map((c: { message_id: string }) => c.message_id), [sent.message_id, second.message_id]);
});

test("interrupt: queued server-side -> withdrawn, delivered -> interrupt_sent, finished -> already_finished", async () => {
	const app = makeApp();
	const { token } = await app.pair();
	const id = await app.register(token);
	const watch = app.watch();
	const stop = (mid: string) => body(app.call("POST", `/byoa/ui/sessions/${id}/messages/${mid}/interrupt`, { user: "ramos" }));

	const queued = await body(app.send("ramos", id, { text: "never mind" }));
	assert.deepEqual(await stop(queued.message_id), { outcome: "withdrawn" });
	await new Promise((r) => setImmediate(r));
	const ended = watch.messages(queued.message_id).at(-1);
	assert.ok(ended?.type === "event" && ended.event.type === "withdrawn");
	// It never reaches the session: the poll stays held, empty.
	const held = app.poll(token, id);
	assert.ok(await pending(held));

	// The next send answers that held poll.
	const delivered = await body(app.send("ramos", id, { text: "work" }));
	assert.equal((await body(held)).commands[0].message_id, delivered.message_id);
	const next = app.poll(token, id);
	assert.deepEqual(await stop(delivered.message_id), { outcome: "interrupt_sent" });
	assert.deepEqual((await body(next)).commands, [{ type: "interrupt", message_id: delivered.message_id }]);
	// Asking again sends no second command.
	assert.deepEqual(await stop(delivered.message_id), { outcome: "interrupt_sent" });
	assert.ok(await pending(app.poll(token, id)));

	await app.events(token, id, [{ message_id: delivered.message_id, seq: 0, type: "interrupted", reason: "stopped" }]);
	assert.deepEqual(await stop(delivered.message_id), { outcome: "already_finished" });
	assert.equal((await app.call("POST", `/byoa/ui/sessions/ses_nope/messages/x/interrupt`, { user: "ramos" })).status, 404);
});

test("byoa.interrupt stops a waiting message from the app's own server", async () => {
	const { app, id } = await setup();
	const sent = await app.byoa.send("ramos", id, { text: "hi" });
	assert.ok("message_id" in sent);
	assert.equal(await app.byoa.interrupt("ramos", id, sent.message_id), "withdrawn");
	assert.equal(await app.byoa.interrupt("ramos", "nope", sent.message_id), null);
});

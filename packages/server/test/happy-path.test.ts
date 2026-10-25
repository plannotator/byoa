// The whole loop once, as a real connector and browser would drive it:
// pair, register, a chat message from the UI, the turn's events back to
// the UI stream in order, and a second app message while the session is busy.

import assert from "node:assert/strict";
import { test } from "node:test";
import { body, makeApp, pending, settle, sseReader } from "./harness.ts";

test("pair, register, send, poll, stream events to the UI in order", async () => {
	const app = makeApp({ mcpPath: "/mcp" });

	const discovery = await body(app.call("GET", "/.well-known/byoa"));
	assert.equal(discovery.endpoints.pair_start, "/byoa/pair/start");
	assert.equal(discovery.endpoints.mcp, "/mcp");
	assert.equal(discovery.poll_hold_seconds, 20);
	assert.equal(discovery.poll_interval_seconds, undefined);

	const { token, connectionId } = await app.pair();
	assert.match(token, /^byoa_[A-Za-z0-9_-]{43}$/);

	const sessionId = await app.register(token);
	const stream = await app.call("GET", "/byoa/ui/events", { user: "ramos" });
	assert.equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8");
	const sse = sseReader(stream);
	await settle();
	const first = sse.events()[0];
	assert.equal(first?.type, "sessions");
	assert.equal(first?.data.connections[0].id, connectionId);
	assert.equal(first?.data.connections[0].machine_name, "ramos-mbp");
	assert.equal(first?.data.connections[0].sessions[0].id, sessionId);

	// The connector's poll is held: nothing to do yet.
	const held = app.poll(token, sessionId);
	assert.ok(await pending(held));

	const sent = await app.send("ramos", sessionId, { text: "Draw a box", set: { model: "opus" } });
	assert.equal(sent.status, 202);
	const { message_id } = await body(sent);

	// The send answers the held poll at once.
	const commands = (await body(held)).commands;
	assert.deepEqual(commands, [
		{ type: "message", message_id, kind: "chat", from: { display_name: "Ramos" }, text: "Draw a box", interrupt_first: false, stream: true, set: { model: "opus" } },
	]);

	// The connector polls again at once when the turn starts: presence goes busy.
	const busyPoll = app.poll(token, sessionId, "busy");
	assert.ok(await pending(busyPoll));
	const posted = await app.events(token, sessionId, [
		{ message_id, seq: 0, type: "started" },
		{ message_id, seq: 1, type: "delta", text: "Drawing" },
		{ message_id, seq: 2, type: "tool", name: "draw", title: "Draw a box" },
		{ message_id, seq: 3, type: "delta", text: " done." },
		{ message_id, seq: 4, type: "done" },
	]);
	assert.equal(posted.status, 204);
	await settle();

	const answer = sse.events().filter((e) => e.data.message_id === message_id);
	assert.deepEqual(
		answer.map((e) => (e.type === "event" ? e.data.event.type : e.type)),
		["accepted", "started", "delta", "tool", "delta", "done"],
	);
	assert.deepEqual(answer.map((e) => e.data.event?.seq), [undefined, 0, 1, 2, 3, 4]);
	// Presence went busy at the poll, before the events.
	const busy = sse.events().find((e) => e.type === "sessions" && e.data.connections[0].sessions[0]?.state === "busy");
	assert.ok(busy, "the busy poll reached the UI as a session list change");

	// A second message while the session is busy waits server-side for the next poll.
	const second = await app.byoa.send("ramos", sessionId, { text: "Then a circle" });
	assert.ok("message_id" in second);
	const next = await body(busyPoll);
	assert.equal(next.commands.length, 1);
	assert.equal(next.commands[0].message_id, second.message_id);
	assert.equal(next.commands[0].kind, "task");
	assert.equal(next.commands[0].from.display_name, "Ramos");
	await app.events(token, sessionId, [{ message_id: second.message_id, seq: 0, type: "queued" }]);
	await settle();
	assert.equal(sse.events().at(-1)?.data.event.type, "queued");

	// Keep-alive comments every 15 s on a quiet stream.
	const before = sse.frames.filter((f) => f === ": keep-alive").length;
	await app.clock.advance(15_000);
	assert.equal(sse.frames.filter((f) => f === ": keep-alive").length, before + 1);
	await sse.cancel();
});

test("pollHoldSeconds 0 answers at once and advertises a poll interval", async () => {
	const app = makeApp({ pollHoldSeconds: 0 });
	const discovery = await body(app.call("GET", "/.well-known/byoa"));
	assert.equal(discovery.poll_hold_seconds, 0);
	assert.equal(discovery.poll_interval_seconds, 5);
	const { token } = await app.pair();
	const sessionId = await app.register(token);
	const answer = app.poll(token, sessionId);
	assert.equal(await pending(answer), false);
	assert.deepEqual(await body(answer), { commands: [] });
});

test("routes outside the base path are not BYOA's", async () => {
	const app = makeApp();
	assert.equal(await app.byoa.handle(new Request("https://app.example/other")), null);
	assert.equal((await app.call("GET", "/byoa/nope")).status, 404);
	assert.equal((await app.call("GET", "/byoa/sessions")).status, 405);
});

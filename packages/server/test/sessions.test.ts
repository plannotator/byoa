// Rule 4 (sessions: derived ids, the cap, gone, no existence leak) and
// rule 5 (the poll: hold, newer poll wins, re-offer after 30 s).

import assert from "node:assert/strict";
import { test } from "node:test";
import { body, CAPS, makeApp, pending } from "./harness.ts";

test("re-register returns the same session id; another connection gets another", async () => {
	const app = makeApp();
	const a = await app.pair();
	const first = await app.register(a.token, "host-1");
	assert.equal(await app.register(a.token, "host-1"), first);
	assert.notEqual(await app.register(a.token, "host-2"), first);
	const b = await app.pair("ramos", "other-mbp");
	assert.notEqual(await app.register(b.token, "host-1"), first);
});

test("a restarted app (fresh hub) gives the same id back on re-register", async () => {
	const app = makeApp();
	const { token } = await app.pair();
	const id = await app.register(token, "host-1");
	// Simulate an app restart that kept its durable store: a fresh hub.
	const { SessionHub } = await import("../src/hub.ts");
	const fresh = new SessionHub({ clock: app.clock, limits: { sessionsPerConnection: 64, bufferedEventsPerMessage: 4096, seqLookAhead: 256 }, pollHoldMs: 20_000 });
	const original = app.store.hub;
	app.store.hub = () => fresh;
	assert.equal((await body(app.poll(token, id))).error, "session_not_found");
	assert.equal(await app.register(token, "host-1"), id);
	app.store.hub = original;
});

test("sessions per connection are capped; gone sessions make room", async () => {
	const app = makeApp({ limits: { sessionsPerConnection: 2 } });
	const { token } = await app.pair();
	await app.register(token, "h1");
	await app.register(token, "h2");
	const third = await app.call("POST", "/byoa/sessions", {
		token,
		body: { host_session_id: "h3", host: "claude-code", connector_version: "0.1.0", started_at: "2026-10-21T11:00:00Z", capabilities: CAPS },
	});
	assert.equal(third.status, 429);
	assert.equal((await body(third)).error, "too_many_sessions");
	await app.clock.advance(60_000);
	await app.register(token, "h3");
});

test("gone after 60 s with no poll, listed 24 h, then forgotten", async () => {
	const app = makeApp();
	const { token } = await app.pair();
	const id = await app.register(token);
	const watch = app.watch();
	const { message_id } = await body(app.send("ramos", id, { text: "work" }));
	const state = async () => (await app.byoa.sessions("ramos"))[0]?.sessions.find((s) => s.id === id)?.state;
	await app.clock.advance(59_999);
	assert.equal(await state(), "ready");
	await app.clock.advance(1);
	assert.equal(await state(), "gone");
	// A message no poll took keeps waiting while the session is gone ...
	assert.notEqual(watch.messages(message_id).at(-1)?.type, "gone");
	await app.clock.advance(23 * 60 * 60 * 1000);
	assert.equal(await state(), "gone");
	await app.clock.advance(60 * 60 * 1000 + 1);
	assert.equal(await state(), undefined);
	// ... and ends only when the session is forgotten.
	assert.deepEqual(watch.messages(message_id).at(-1), { type: "gone", session_id: id, message_id, reason: "stopped_polling" });
});

test("a held poll keeps the session live; it answers [] at 20 s", async () => {
	const app = makeApp();
	const { token } = await app.pair();
	const id = await app.register(token);
	const held = app.poll(token, id);
	await app.clock.advance(19_999);
	assert.ok(await pending(held));
	await app.clock.advance(1);
	assert.deepEqual(await body(held), { commands: [] });
	// Polling every 20 s, it never goes gone.
	for (let i = 0; i < 5; i++) {
		const next = app.poll(token, id);
		await app.clock.advance(20_000);
		await next;
	}
	assert.equal((await app.byoa.sessions("ramos"))[0]?.sessions[0]?.state, "ready");
});

test("a newer poll answers the held one with [] and carries presence to the UI at once", async () => {
	const app = makeApp();
	const { token } = await app.pair();
	const id = await app.register(token);
	const watch = app.watch();
	const older = app.poll(token, id, "ready");
	assert.ok(await pending(older));
	const newer = app.poll(token, id, "blocked", { cause: "permission", settings: [{ ...CAPS.settings[0], value: "sonnet" }] });
	assert.deepEqual(await body(older), { commands: [] });
	assert.ok(await pending(newer));
	const last = watch.seen.at(-1);
	assert.equal(last?.type, "sessions");
	const session = last?.type === "sessions" ? last.connections[0]?.sessions[0] : undefined;
	assert.equal(session?.state, "blocked");
	assert.equal(session?.cause, "permission");
	assert.equal(session?.capabilities.settings[0]?.value, "sonnet");
});

test("unknown and other people's sessions answer the same 404", async () => {
	const app = makeApp();
	const ramos = await app.pair();
	const dana = await app.pair("dana", "dana-mbp");
	const danaSession = await app.register(dana.token, "d1");
	const unknown = await app.poll(ramos.token, "ses_nope");
	const theirs = await app.poll(ramos.token, danaSession);
	assert.equal(unknown.status, 404);
	assert.equal(theirs.status, 404);
	assert.deepEqual(await body(unknown), await body(theirs));
	// The UI side too: Ramos cannot send to Dana's session.
	const send = await app.send("ramos", danaSession, { text: "hi" });
	assert.equal(send.status, 404);
	assert.equal((await body(send)).error, "session_not_found");
	assert.equal((await app.events(ramos.token, danaSession, [])).status, 404);
});

test("a message no event answered is offered again after 30 s, not before", async () => {
	const app = makeApp();
	const { token } = await app.pair();
	const id = await app.register(token);
	const sent = await body(app.send("ramos", id, { text: "hi" }));
	assert.equal((await body(app.poll(token, id))).commands[0].message_id, sent.message_id);
	// Lost answer: the next poll within 30 s holds, empty.
	const quiet = app.poll(token, id);
	await app.clock.advance(20_000);
	assert.deepEqual(await body(quiet), { commands: [] });
	await app.clock.advance(10_000);
	assert.equal((await body(app.poll(token, id))).commands[0].message_id, sent.message_id);
	// Once any event answers it, it is never offered again.
	await app.events(token, id, [{ message_id: sent.message_id, seq: 0, type: "queued" }]);
	await app.clock.advance(31_000);
	const later = app.poll(token, id);
	assert.ok(await pending(later));
});

test("a session must say the host the connection was paired as", async () => {
	const app = makeApp();
	const { token } = await app.pair(); // paired as claude-code
	const wrong = await app.call("POST", "/byoa/sessions", {
		token,
		body: { host_session_id: "h1", host: "pi", connector_version: "0.1.0", started_at: "2026-10-21T11:00:00Z", capabilities: CAPS },
	});
	assert.equal(wrong.status, 422);
	const err = await body(wrong);
	assert.equal(err.error, "validation_error");
	assert.match(err.error_description, /paired as claude-code, not pi/);
	assert.equal((await app.byoa.sessions("ramos"))[0]?.sessions.length, 0, "nothing registered");
	await app.register(token, "h1");
});

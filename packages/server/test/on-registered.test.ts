// onRegistered: called after the hub accepts a register, re-registers too,
// with the session as byoa.sessions shows it. It is awaited before the
// answer, never changes it, and a throw goes to onError, not to the connector.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { UiSession } from "../src/index.ts";
import { body, makeApp, CAPS } from "./harness.ts";

const REGISTER = { host_session_id: "host-1", host: "claude-code", connector_version: "0.1.0", workspace: { folder_name: "byoa" }, started_at: "2026-10-21T11:00:00Z", capabilities: CAPS };

test("called with the person and the session as sessions() shows it, on every register", async () => {
	const calls: { userId: string; session: UiSession }[] = [];
	const app = makeApp({ onRegistered: (userId, session) => void calls.push({ userId, session: structuredClone(session) }) });
	const { token } = await app.pair();
	const id = await app.register(token);
	assert.equal(calls.length, 1);
	const listed = (await app.byoa.sessions("ramos"))[0]?.sessions[0];
	assert.deepEqual(calls[0], { userId: "ramos", session: listed });
	assert.equal(calls[0]?.session.id, id);
	assert.equal(calls[0]?.session.machine_name, "ramos-mbp");

	await app.clock.advance(5000);
	assert.equal(await app.register(token), id, "a re-register keeps the id");
	assert.equal(calls.length, 2);
	assert.equal(calls[1]?.session.last_seen_at, new Date(app.clock.now()).toISOString());
});

test("awaited before the answer, and nothing it does changes the answer", async () => {
	const order: string[] = [];
	const app = makeApp({
		onRegistered: async (_userId, session) => {
			order.push("hook started");
			(session as { host: string }).host = "changed";
			session.capabilities.settings.length = 0;
			await new Promise((resolve) => setTimeout(resolve, 5));
			order.push("hook done");
		},
	});
	const { token } = await app.pair();
	const res = await app.call("POST", "/byoa/sessions", { token, body: REGISTER });
	order.push("answered");
	assert.deepEqual(order, ["hook started", "hook done", "answered"]);
	const answer = await body(res);
	assert.equal(answer.session.host, "claude-code");
	assert.deepEqual(answer.session.capabilities, CAPS);
	assert.deepEqual((await app.byoa.sessions("ramos"))[0]?.sessions[0]?.capabilities, CAPS, "the hub's own state is untouched");
});

test("a throw goes to onError with the request; the register still succeeds", async () => {
	const boom = new Error("index write failed");
	const errors: { error: unknown; url: string }[] = [];
	const app = makeApp({
		onRegistered: async () => {
			throw boom;
		},
		onError: (error, req) => void errors.push({ error, url: req.url }),
	});
	const { token } = await app.pair();
	const res = await app.call("POST", "/byoa/sessions", { token, body: REGISTER });
	assert.equal(res.status, 200);
	assert.ok((await body(res)).session.id.startsWith("ses_"));
	assert.deepEqual(errors, [{ error: boom, url: "https://app.example/byoa/sessions" }]);
});

test("not called when the register is refused", async () => {
	let calls = 0;
	const app = makeApp({ limits: { sessionsPerConnection: 1 }, onRegistered: () => void calls++ });
	const { token } = await app.pair();
	await app.register(token, "a");
	const res = await app.call("POST", "/byoa/sessions", { token, body: { ...REGISTER, host_session_id: "b" } });
	assert.equal(res.status, 429);
	assert.equal(calls, 1);
});

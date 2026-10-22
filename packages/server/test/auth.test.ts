// Rule 1: connector doors take only a BYOA bearer token, UI doors only the
// app's human session with CSRF, and no token can create a message. Also
// the one loopback-era check kept: a connector door refuses any Origin.

import assert from "node:assert/strict";
import { test } from "node:test";
import { body, makeApp, pending } from "./harness.ts";

test("connector doors refuse a person's session and a bad token", async () => {
	const app = makeApp();
	const { token } = await app.pair();
	const sessionId = await app.register(token);
	const register = { host_session_id: "h", host: "pi", connector_version: "0.1.0", workspace: {}, started_at: "2026-10-21T11:00:00Z", capabilities: { interrupt: false, stream: false, settings: [] } };
	for (const [path, payload] of [
		["/byoa/sessions", register],
		[`/byoa/sessions/${sessionId}/poll`, { state: "ready" }],
		[`/byoa/sessions/${sessionId}/events`, { events: [] }],
	] as const) {
		// The cookie alone: no Origin, as a same-site form or script might not send one.
		assert.equal((await app.call("POST", path, { headers: { cookie: "session=ramos" }, body: payload })).status, 401, path);
		assert.equal((await app.call("POST", path, { token: "byoa_forged", body: payload })).status, 401, path);
	}
	assert.equal((await app.call("POST", "/byoa/revoke")).status, 401);
});

test("connector doors refuse any request carrying Origin", async () => {
	const app = makeApp();
	const { token } = await app.pair();
	const sessionId = await app.register(token);
	for (const path of ["/byoa/pair/start", "/byoa/pair/poll", "/byoa/revoke", "/byoa/sessions", `/byoa/sessions/${sessionId}/poll`, `/byoa/sessions/${sessionId}/events`]) {
		const res = await app.call("POST", path, { token, origin: "https://app.example", body: { state: "ready" } });
		assert.equal(res.status, 403, path);
		assert.equal((await body(res)).error, "forbidden");
	}
});

test("UI doors refuse any Authorization header, the connection's own token included", async () => {
	const app = makeApp();
	const { token, connectionId } = await app.pair();
	const sessionId = await app.register(token);
	const doors: [string, string][] = [
		["GET", "/byoa/ui/events"],
		["GET", "/byoa/ui/sessions"],
		["POST", `/byoa/ui/sessions/${sessionId}/messages`],
		["POST", `/byoa/ui/sessions/${sessionId}/messages/msg_x/interrupt`],
		["DELETE", `/byoa/ui/connections/${connectionId}`],
	];
	for (const [method, path] of doors) {
		// Token alone, and token next to a valid session: both 401.
		assert.equal((await app.call(method, path, { token, body: { text: "hi" } })).status, 401, path);
		assert.equal((await app.call(method, path, { token, user: "ramos", body: { text: "hi" } })).status, 401, path);
		assert.equal((await app.call(method, path, { body: { text: "hi" } })).status, 401, path);
	}
	// Nothing was queued (the poll is held, empty) and nothing was revoked.
	assert.ok(await pending(app.poll(token, sessionId)));
	assert.equal((await body(app.call("GET", "/byoa/ui/sessions", { user: "ramos" }))).connections.length, 1);
});

test("UI doors need CSRF on POST and DELETE", async () => {
	const app = makeApp();
	const { token, connectionId } = await app.pair();
	const sessionId = await app.register(token);
	assert.equal((await app.send("ramos", sessionId, { text: "hi" })).status, 202);
	for (const origin of [null, "https://evil.example"]) {
		assert.equal((await app.call("POST", `/byoa/ui/sessions/${sessionId}/messages`, { user: "ramos", origin, body: { text: "hi" } })).status, 403);
		assert.equal((await app.call("DELETE", `/byoa/ui/connections/${connectionId}`, { user: "ramos", origin })).status, 403);
	}
	// A custom check replaces the default: here it also refuses a same-origin request.
	const custom = makeApp({ checkCsrf: (req) => req.headers.get("origin") === "https://app.example" && req.headers.get("x-csrf") !== "bad" });
	const paired = await custom.pair();
	const sid = await custom.register(paired.token);
	assert.equal((await custom.call("POST", `/byoa/ui/sessions/${sid}/messages`, { user: "ramos", headers: { "x-csrf": "bad" }, body: { text: "hi" } })).status, 403);
	assert.equal((await custom.call("POST", `/byoa/ui/sessions/${sid}/messages`, { user: "ramos", body: { text: "hi" } })).status, 202);
});

test("verifyBearer accepts a live token and checks the session it names", async () => {
	const app = makeApp();
	const { token, connectionId } = await app.pair();
	const sessionId = await app.register(token);
	const other = await app.pair("dana", "dana-mbp");
	const danaSession = await app.register(other.token, "dana-1");
	const req = () => new Request("https://app.example/mcp", { method: "POST", headers: { authorization: `Bearer ${token}` } });
	assert.deepEqual(await app.byoa.verifyBearer(req()), { userId: "ramos", connectionId });
	assert.deepEqual(await app.byoa.verifyBearer(req(), { sessionId }), { userId: "ramos", connectionId, sessionId });
	assert.deepEqual(await app.byoa.verifyBearer(req(), { sessionId: danaSession }), { userId: "ramos", connectionId });
	assert.equal(await app.byoa.verifyBearer(new Request("https://app.example/mcp", { headers: { authorization: "Bearer byoa_nope" } })), null);
	await app.byoa.revoke(connectionId);
	assert.equal(await app.byoa.verifyBearer(req()), null);
});

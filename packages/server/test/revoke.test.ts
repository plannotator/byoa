// Rule 8: revocation from each of its three doors. Every later door 401s,
// held polls 401 at once, and the UI hears `gone` (disconnected) for that
// connection's open messages and a session list without it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { body, makeApp, pending, settle } from "./harness.ts";

const WAYS = {
	"connector POST revoke": async (app: ReturnType<typeof makeApp>, token: string) => {
		assert.equal((await app.call("POST", "/byoa/revoke", { token })).status, 204);
	},
	"UI DELETE connection": async (app: ReturnType<typeof makeApp>, _token: string, connectionId: string) => {
		assert.equal((await app.call("DELETE", `/byoa/ui/connections/${connectionId}`, { user: "ramos" })).status, 204);
	},
	"byoa.revoke": async (app: ReturnType<typeof makeApp>, _token: string, connectionId: string) => {
		await app.byoa.revoke(connectionId);
	},
};

for (const [way, revoke] of Object.entries(WAYS)) {
	test(`revoked by ${way}`, async () => {
		const app = makeApp();
		const { token, connectionId } = await app.pair();
		const id = await app.register(token);
		const other = await app.pair("ramos", "second-mbp");
		const otherId = await app.register(other.token, "h2");
		const watch = app.watch();
		const { message_id } = await body(app.send("ramos", id, { text: "work" }));
		await body(app.poll(token, id));
		await app.events(token, id, [{ message_id, seq: 0, type: "started" }]);
		const held = app.poll(token, id);
		assert.ok(await pending(held));

		await revoke(app, token, connectionId);
		const answer = await held;
		assert.equal(answer.status, 401);
		assert.equal((await body(answer)).error, "unauthorized");

		for (const res of [
			await app.poll(token, id),
			await app.events(token, id, [{ message_id, seq: 1, type: "done" }]),
			await app.call("POST", "/byoa/sessions", { token, body: {} }),
		])
			assert.equal(res.status, 401);
		// The revoke door itself stays idempotent.
		assert.equal((await app.call("POST", "/byoa/revoke", { token })).status, 204);

		await settle();
		const gone = watch.messages(message_id).at(-1);
		assert.deepEqual(gone, { type: "gone", session_id: id, message_id, reason: "disconnected" });
		const list = watch.seen.filter((e) => e.type === "sessions").at(-1);
		assert.ok(list?.type === "sessions");
		assert.deepEqual(list.connections.map((c) => c.id), [other.connectionId]);
		// The other connection is untouched.
		assert.ok(await pending(app.poll(other.token, otherId)));
	});
}

test("a person cannot disconnect someone else's connection", async () => {
	const app = makeApp();
	const dana = await app.pair("dana", "dana-mbp");
	const res = await app.call("DELETE", `/byoa/ui/connections/${dana.connectionId}`, { user: "ramos" });
	assert.equal(res.status, 404);
	assert.equal((await app.byoa.verifyBearer(new Request("https://app.example/mcp", { headers: { authorization: `Bearer ${dana.token}` } })))?.userId, "dana");
});

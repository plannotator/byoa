// Rule 10: durable records and the live hub are separate. A store whose
// durable half is the app's own and whose hub is a SessionHub per person
// works unchanged, and the durable half never sees live state or raw secrets.

import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryStore, SessionHub, type ByoaStore, type Hub } from "../src/index.ts";
import { body, makeApp } from "./harness.ts";

test("a store built from a durable half and per-person hubs works end to end", async () => {
	const durable = memoryStore();
	const hubs = new Map<string, Hub>();
	const hubCalls: string[] = [];
	const store: ByoaStore = {
		pairings: durable.pairings,
		connections: durable.connections,
		hub(userId, config) {
			hubCalls.push(userId);
			let hub = hubs.get(userId);
			if (hub === undefined) hubs.set(userId, (hub = new SessionHub(config)));
			return hub;
		},
	};
	const app = makeApp({ store });
	const ramos = await app.pair();
	const dana = await app.pair("dana", "dana-mbp");
	const id = await app.register(ramos.token);
	await app.register(dana.token, "d1");
	assert.equal((await app.send("ramos", id, { text: "a distinctive request" })).status, 202);
	assert.equal((await body(app.poll(ramos.token, id))).commands.length, 1);
	// One hub per person, and only the person's own sessions in it.
	assert.deepEqual([...hubs.keys()].sort(), ["dana", "ramos"]);
	assert.deepEqual((await hubs.get("ramos")?.list())?.map((s) => s.id), [id]);
	assert.ok(hubCalls.length > 0);

	// The durable half holds only records: no session, message or raw token.
	const records = JSON.stringify([await durable.connections.listByUser("ramos"), await durable.connections.listByUser("dana")]);
	for (const secret of [ramos.token, dana.token, id, "distinctive"]) assert.ok(!records.includes(secret), secret);
	assert.match(records, /"token_hash":"[0-9a-f]{64}"/);
});

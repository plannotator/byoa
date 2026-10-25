// The store conformance suite, proved: it passes against memoryStore() and
// against a split store (a durable half plus per-person hubs) whose restart
// either forgets or keeps live state, and it fails on stores that break a
// rule. The suite itself imports no Node API; the last test checks that
// nothing it pulls in does.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { storeConformance, type StoreFactory } from "../src/conformance.ts";
import { memoryStore, SessionHub, type ByoaStore, type ConnectionRecord, type Hub, type PairingRecord } from "../src/index.ts";

for (const c of storeConformance(() => ({ store: memoryStore() }))) test(`memoryStore: ${c.name}`, c.run);

/** memoryStore's durable half and one SessionHub per person. `restart`
 * keeps the durable half and either drops every hub (an app restart, a
 * Durable Object eviction) or keeps them (a fresh stub to a live object). */
function splitStore(keepHubs: boolean): StoreFactory {
	return () => {
		const durable = memoryStore();
		const build = (hubs: Map<string, Hub>): ByoaStore => ({
			pairings: durable.pairings,
			connections: durable.connections,
			hub(userId, config) {
				let hub = hubs.get(userId);
				if (hub === undefined) hubs.set(userId, (hub = new SessionHub(config)));
				return hub;
			},
		});
		const hubs = new Map<string, Hub>();
		return { store: build(hubs), restart: () => build(keepHubs ? hubs : new Map()) };
	};
}

for (const c of storeConformance(splitStore(false))) if (c.name.startsWith("restart:")) test(`split store, restart forgets: ${c.name}`, c.run);
for (const c of storeConformance(splitStore(true))) if (c.name.startsWith("restart:")) test(`split store, restart keeps: ${c.name}`, c.run);
for (const c of storeConformance(splitStore(false))) if (!c.name.startsWith("restart:")) test(`split store: ${c.name}`, c.run);

/** A hub that ignores config.clock and runs on real time, as a Durable
 * Object adapter might: with timing off, every other case still passes. */
const realClock = {
	now: () => Date.now(),
	setTimeout(fn: () => void, ms: number) {
		const timer = setTimeout(fn, ms);
		timer.unref();
		return timer;
	},
	clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
for (const c of storeConformance(
	() => {
		const durable = memoryStore();
		const hubs = new Map<string, Hub>();
		return {
			store: {
				pairings: durable.pairings,
				connections: durable.connections,
				hub(userId, config) {
					let hub = hubs.get(userId);
					if (hub === undefined) hubs.set(userId, (hub = new SessionHub({ ...config, clock: realClock })));
					return hub;
				},
			},
		};
	},
	{ timing: false },
))
	test(`real-time hub, timing off: ${c.name}`, c.run);

test("timing: false leaves out exactly the scripted-time cases", () => {
	const all = storeConformance(() => ({ store: memoryStore() })).map((c) => c.name);
	const untimed = storeConformance(() => ({ store: memoryStore() }), { timing: false }).map((c) => c.name);
	assert.deepEqual(
		all.filter((n) => !untimed.includes(n)),
		all.filter((n) => n.startsWith("timing:")),
	);
	assert.equal(new Set(all).size, all.length, "case names are unique");
});

test("the factory is called once per case and cleanup runs after a failure too", async () => {
	let made = 0;
	let cleaned = 0;
	const [first] = storeConformance(() => {
		made++;
		return { store: memoryStore(), cleanup: () => void cleaned++ };
	});
	await first?.run();
	assert.deepEqual([made, cleaned], [1, 1]);
	const [broken] = storeConformance(() => ({ store: { ...memoryStore(), pairings: { ...memoryStore().pairings, insert: () => false } }, cleanup: () => void cleaned++ }));
	await assert.rejects(broken?.run() ?? Promise.resolve(), /insert a new pairing/);
	assert.equal(cleaned, 2);
});

type Bug = "collect is not atomic" | "revoke resets revoked_at" | "a new hub per call";

/** memoryStore with one rule broken. */
function brokenStore(bug: Bug): ByoaStore {
	const pairings = new Map<string, PairingRecord>();
	const connections = new Map<string, ConnectionRecord>();
	const hubs = new Map<string, Hub>();
	const real = memoryStore();
	return {
		pairings: {
			insert(p) {
				for (const q of pairings.values()) if (q.user_code_hash === p.user_code_hash && q.expires_at > p.created_at) return false;
				pairings.set(p.id, { ...p });
				return true;
			},
			findByUserCode(hash, now) {
				for (const p of pairings.values()) if (p.user_code_hash === hash && p.status === "pending" && p.expires_at > now) return { ...p };
				return null;
			},
			findByDeviceCode(hash) {
				for (const p of pairings.values()) if (p.device_code_hash === hash) return { ...p };
				return null;
			},
			notePoll(id, now) {
				const p = pairings.get(id);
				if (p === undefined) return null;
				const previous = p.last_poll_at;
				p.last_poll_at = now;
				return previous;
			},
			decide(id, decision, approver, now) {
				const p = pairings.get(id);
				if (p === undefined || p.status !== "pending" || p.expires_at <= now) return false;
				p.status = decision;
				p.approved_by = approver;
				return true;
			},
			async collect(id, connection, now) {
				const p = pairings.get(id);
				if (p === undefined || p.status !== "approved" || p.expires_at <= now) return false;
				// A read, then a separate write: racing collects all pass the check.
				if (bug === "collect is not atomic") await Promise.resolve();
				p.status = "collected";
				connections.set(connection.id, { ...connection });
				return true;
			},
		},
		connections: {
			byTokenHash(hash) {
				for (const c of connections.values()) if (c.token_hash === hash) return { ...c };
				return null;
			},
			get(id) {
				const c = connections.get(id);
				return c === undefined ? null : { ...c };
			},
			listByUser(userId) {
				return [...connections.values()].filter((c) => c.user_id === userId).map((c) => ({ ...c }));
			},
			revoke(id, now) {
				const c = connections.get(id);
				if (c === undefined) return null;
				if (bug === "revoke resets revoked_at") c.revoked_at = now;
				else c.revoked_at ??= now;
				return { ...c };
			},
			touch(id, now) {
				const c = connections.get(id);
				if (c !== undefined) c.last_seen_at = now;
			},
		},
		hub(userId, config) {
			if (bug === "a new hub per call") return new SessionHub(config);
			return real.hub(userId, config);
		},
	};
}

async function failures(bug: Bug): Promise<Map<string, string>> {
	const failed = new Map<string, string>();
	for (const c of storeConformance(() => ({ store: brokenStore(bug) }))) {
		try {
			await c.run();
		} catch (error) {
			failed.set(c.name, error instanceof Error ? error.message : String(error));
		}
	}
	return failed;
}

test("a collect that is not atomic fails the collect case, and only it", async () => {
	const failed = await failures("collect is not atomic");
	assert.deepEqual([...failed.keys()], ["pairings: collect is atomic: one of several concurrent collects wins, and one connection exists"]);
	assert.match([...failed.values()][0] ?? "", /five racing collects: how many won: expected 1, got 5/);
});

test("a revoke that resets revoked_at fails the revoke case, and only it", async () => {
	// The doors never revoke twice, so only the direct case can see it.
	const failed = await failures("revoke resets revoked_at");
	assert.deepEqual([...failed.keys()], ["connections: revoke sets revoked_at once and returns null for an unknown id"]);
	assert.match([...failed.values()][0] ?? "", /a second revoke keeps the first revoked_at: expected \d+, got \d+/);
});

test("a store that makes a new hub per call fails the same-hub case", async () => {
	const failed = await failures("a new hub per call");
	assert.ok(failed.has("hub: one person's separate requests reach the same hub"), [...failed.keys()].join("\n"));
	assert.ok(!failed.has("pairings: decide wins once"), "durable cases still pass");
});

test("nothing the suite imports uses a Node API", () => {
	const dir = new URL("../src/", import.meta.url);
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
		const source = readFileSync(new URL(file, dir), "utf8");
		for (const banned of [/from "node:/, /\bsetImmediate\b/, /\bprocess\./, /\bBuffer\b/, /\brequire\(/])
			assert.ok(!banned.test(source.replace(/^\s*\/\/.*$/gm, "")), `${file} uses ${banned}`);
	}
});

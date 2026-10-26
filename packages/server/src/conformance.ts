// The store conformance suite: cases an app runs against its own ByoaStore
// (a database for the durable half, a Durable Object per person for the
// hub) to check it keeps every rule the SDK relies on. Each case builds a
// real app with createByoa and drives it through byoa.handle, the way a
// connector and a browser would, plus direct calls where a store method
// promises something the doors cannot show (one decide wins, collect is
// atomic). It imports no Node API and no test runner, so it runs in Node,
// Bun, Deno and workerd alike.
//
// The clock requirement: every case scripts time with a FakeClock passed to
// createByoa, which hands it to `store.hub(userId, config)` as
// `config.clock`. The hub that call returns must take all time and timers
// from `config.clock` (and its poll hold from `config.pollHoldMs`), so a
// Durable Object adapter under test has to pass that clock through. A hub
// that uses real time can still run the rest: pass `{ timing: false }` and
// the cases that need scripted time are left out.
//
// Wire it into any runner:
//
//   // node:test
//   import { test } from "node:test";
//   import { storeConformance } from "@plannotator/byoa-server/conformance";
//   for (const c of storeConformance(make)) test(c.name, c.run);
//
//   // vitest
//   import { test } from "vitest";
//   import { storeConformance } from "@plannotator/byoa-server/conformance";
//   for (const c of storeConformance(make)) test(c.name, c.run);
//
// where `make` returns a fresh store: `() => ({ store: myStore() })`. Do not
// fake the runner's global timers (vi.useFakeTimers): the suite yields to
// zero-delay timers to let requests in flight finish.

import type { SessionCapabilities } from "@plannotator/byoa-protocol";
import { createByoa } from "./byoa.ts";
import { randomId, sha256Hex } from "./crypto.ts";
import { FakeClock, settle } from "./fake-clock.ts";
import type { ByoaStore, ConnectionRecord, PairingRecord } from "./store.ts";
import type { ApprovalPage, Awaitable, Byoa, ByoaLimits, UiEvent } from "./types.ts";

export { FakeClock, settle };

/** What the factory gives each case. */
export interface StoreUnderTest {
	store: ByoaStore;
	/** A store over the same durable data; its hubs may or may not have kept
	 * live state, as after an app restart, a Durable Object eviction, or a
	 * fresh stub to the same object. Without it the restart cases pass
	 * without checking anything. */
	restart?: () => Awaitable<ByoaStore>;
	/** Called after the case, pass or fail. */
	cleanup?: () => Awaitable<void>;
}

/** Called once per case. Return a fresh store; the cases use their own user
 * ids, so a shared database works too. */
export type StoreFactory = () => Awaitable<StoreUnderTest>;

export interface ConformanceCase {
	name: string;
	run(): Promise<void>;
}

export interface ConformanceOptions {
	/** Default true. False leaves out the cases that script time. */
	timing?: boolean;
	/** How to let the store's pending work finish before scripted time moves.
	 * The default runs ten rounds of microtasks and a zero-delay timer, enough
	 * for an in-memory store. A store that does real I/O (a database round
	 * trip, an RPC) passes its own, for example
	 * `() => new Promise((r) => setTimeout(r, 25))`. */
	settle?: () => Promise<void>;
}

export function storeConformance(factory: StoreFactory, options: ConformanceOptions = {}): ConformanceCase[] {
	const timing = options.timing ?? true;
	return CASES.filter((c) => timing || !c.timing).map((c) => ({
		name: c.name,
		async run() {
			const env = await factory();
			try {
				await c.run(new Kit(env, options.settle));
			} finally {
				await env.cleanup?.();
			}
		},
	}));
}

// ── assertions ──────────────────────────────────────────────────────────────

class ConformanceError extends Error {
	override name = "ConformanceError";
}

function fail(message: string): never {
	throw new ConformanceError(message);
}

function ok(condition: unknown, message: string): asserts condition {
	if (!condition) fail(message);
}

/** Plain data in a stable form: object keys sorted. */
function canon(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v !== null && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
	) ?? "undefined";
}

function equal(actual: unknown, expected: unknown, what: string): void {
	if (!Object.is(actual, expected)) fail(`${what}: expected ${canon(expected)}, got ${canon(actual)}`);
}

function deepEqual(actual: unknown, expected: unknown, what: string): void {
	const a = canon(actual);
	const e = canon(expected);
	if (a !== e) fail(`${what}:\n  expected ${e}\n  got      ${a}`);
}

async function status(response: Response | Promise<Response>, expected: number, what: string): Promise<Response> {
	const res = await response;
	if (res.status !== expected) fail(`${what}: expected HTTP ${expected}, got ${res.status} ${await res.clone().text()}`);
	return res;
}

async function json(response: Response | Promise<Response>): Promise<any> {
	return (await response).json();
}

/** True when the promise has not settled after pending work ran. */
async function pending(kit: Kit, promise: Promise<unknown>): Promise<boolean> {
	const marker = Symbol("pending");
	await kit.settle();
	return (await Promise.race([promise, Promise.resolve(marker)])) === marker;
}

// ── the app each case drives ────────────────────────────────────────────────

const ORIGIN = "https://conformance.example";
const T0 = Date.parse("2026-10-21T12:00:00Z");

const CAPS: SessionCapabilities = {
	interrupt: true,
	stream: true,
	settings: [{ id: "model", name: "Model", value: null, choices: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] }],
};

interface AppOptions {
	/** Poll hold in seconds. Default 0, so a case that does not test the hold
	 * never waits on one. */
	hold?: number;
	limits?: Partial<ByoaLimits>;
}

interface CallOptions {
	token?: string;
	user?: string;
	body?: unknown;
	form?: Record<string, string>;
}

interface Started {
	device_code: string;
	user_code: string;
}

type Consent = Extract<ApprovalPage, { state: "consent" }>;

function withoutUserCode(record: PairingRecord | null): Omit<PairingRecord, "user_code_hash"> | null {
	if (record === null) return null;
	const { user_code_hash: _, ...rest } = record;
	return rest;
}

/** One case's people, clock and store. */
class Kit {
	readonly env: StoreUnderTest;
	readonly clock: FakeClock;
	/** Lets the store's pending work finish: the caller's `settle` option, or the default. */
	readonly settle: () => Promise<void>;
	/** Fresh ids per case, so cases never see each other's records. */
	readonly alice = `alice-${hexId()}`;
	readonly bob = `bob-${hexId()}`;

	constructor(env: StoreUnderTest, wait?: () => Promise<void>) {
		this.settle = wait ?? (() => settle());
		this.clock = new FakeClock(T0, this.settle);
		this.env = env;
	}

	app(options: AppOptions = {}, store: ByoaStore = this.env.store): App {
		return new App(this, store, options);
	}
}

function hexId(): string {
	return randomId("").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
}

class App {
	readonly byoa: Byoa;
	readonly kit: Kit;
	readonly store: ByoaStore;
	#consent: Consent | null = null;

	constructor(kit: Kit, store: ByoaStore, options: AppOptions) {
		this.kit = kit;
		this.store = store;
		const names: Record<string, string> = { [kit.alice]: "Alice", [kit.bob]: "Bob" };
		this.byoa = createByoa({
			app: { id: "conformance", name: "Conformance", origin: ORIGIN },
			authenticate: async (req) => {
				const id = /(?:^|;\s*)session=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
				return id !== undefined && names[id] !== undefined ? { userId: id, displayName: names[id] } : null;
			},
			store,
			clock: kit.clock,
			pollHoldSeconds: options.hold ?? 0,
			...(options.limits !== undefined ? { limits: options.limits } : {}),
			renderPage: (page) => {
				if (page.state === "consent") this.#consent = page;
				return null;
			},
		});
	}

	get clock(): FakeClock {
		return this.kit.clock;
	}

	async call(method: string, path: string, opts: CallOptions = {}): Promise<Response> {
		const headers: Record<string, string> = {};
		if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
		if (opts.user !== undefined) {
			headers.cookie = `session=${opts.user}`;
			// A browser sends its own origin on POST and DELETE.
			if (method !== "GET") headers.origin = ORIGIN;
		}
		let body: string | undefined;
		if (opts.form !== undefined) {
			headers["content-type"] = "application/x-www-form-urlencoded";
			body = new URLSearchParams(opts.form).toString();
		} else if (opts.body !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(opts.body);
		}
		const response = await this.byoa.handle(new Request(ORIGIN + path, { method, headers, ...(body !== undefined ? { body } : {}) }));
		ok(response !== null, `${method} ${path} should be a BYOA route`);
		return response;
	}

	async start(machine = "laptop"): Promise<Started> {
		const res = await status(this.call("POST", "/byoa/pair/start", { body: { client: { host: "claude-code", connector: "byoa", connector_version: "0.1.0", machine_name: machine } } }), 200, "pair/start");
		return json(res);
	}

	/** The consent page as the person sees it, then Connect or Cancel. */
	async decide(user: string, started: Started, decision: "connect" | "cancel" = "connect"): Promise<Response> {
		this.#consent = null;
		await status(this.call("GET", `/byoa/connect?code=${started.user_code}`, { user }), 200, "the consent page");
		const consent = this.#consent as Consent | null;
		ok(consent !== null, `the consent page should render for a live code (user ${user})`);
		const { fields } = consent.form;
		return this.call("POST", consent.formAction, { user, form: { [fields.code]: consent.userCode, [fields.csrf]: consent.csrfToken, [fields.decision]: decision } });
	}

	pairPoll(started: Started): Promise<Response> {
		return this.call("POST", "/byoa/pair/poll", { body: { device_code: started.device_code } });
	}

	async collect(started: Started): Promise<{ token: string; connectionId: string }> {
		const answer = await json(status(this.pairPoll(started), 200, "pair/poll collects the token"));
		return { token: answer.access_token, connectionId: answer.connection_id };
	}

	/** The device grant end to end. */
	async pair(user: string, machine = "laptop") {
		const started = await this.start(machine);
		await status(this.decide(user, started), 200, "Connect");
		return { ...(await this.collect(started)), started };
	}

	async register(token: string, hostSessionId = "host-1"): Promise<string> {
		const res = await status(this.registerRaw(token, hostSessionId), 200, `register ${hostSessionId}`);
		return (await json(res)).session.id;
	}

	registerRaw(token: string, hostSessionId: string): Promise<Response> {
		return this.call("POST", "/byoa/sessions", {
			token,
			body: { host_session_id: hostSessionId, host: "claude-code", connector_version: "0.1.0", workspace: { folder_name: "byoa" }, started_at: "2026-10-21T11:00:00Z", capabilities: CAPS },
		});
	}

	poll(token: string, sessionId: string, state: "ready" | "busy" | "blocked" = "ready"): Promise<Response> {
		return this.call("POST", `/byoa/sessions/${sessionId}/poll`, { token, body: { state } });
	}

	async commands(token: string, sessionId: string): Promise<any[]> {
		return (await json(status(this.poll(token, sessionId), 200, "poll"))).commands;
	}

	events(token: string, sessionId: string, list: unknown[]): Promise<Response> {
		return this.call("POST", `/byoa/sessions/${sessionId}/events`, { token, body: { events: list } });
	}

	send(user: string, sessionId: string, text: string): Promise<Response> {
		return this.call("POST", `/byoa/ui/sessions/${sessionId}/messages`, { user, body: { text } });
	}

	async sent(user: string, sessionId: string, text: string): Promise<string> {
		return (await json(status(this.send(user, sessionId, text), 202, "send"))).message_id;
	}

	interrupt(user: string, sessionId: string, messageId: string): Promise<Response> {
		return this.call("POST", `/byoa/ui/sessions/${sessionId}/messages/${messageId}/interrupt`, { user });
	}

	/** Everything subscribe delivers to this person. */
	async watch(user: string) {
		const seen: UiEvent[] = [];
		const stop = this.byoa.subscribe(user, (event) => seen.push(event));
		await this.kit.settle();
		return { seen, stop, of: (id: string) => seen.filter((e) => e.type !== "sessions" && e.message_id === id) };
	}

	async sessionIds(user: string): Promise<string[]> {
		return (await this.byoa.sessions(user)).flatMap((c) => c.sessions.map((s) => s.id)).sort();
	}
}

/** What a message's events look like to the UI, for comparing. */
function shape(events: UiEvent[]): string[] {
	return events.map((e) => (e.type === "event" ? `${e.event.type}${e.event.seq === undefined ? "" : `#${e.event.seq}`}` : e.type === "gone" ? `gone:${e.reason}` : e.type));
}

async function pairingRecord(created: number, overrides: Partial<PairingRecord> = {}): Promise<PairingRecord> {
	return {
		id: randomId("conn_"),
		device_code_hash: await sha256Hex(randomId("d")),
		user_code_hash: await sha256Hex(randomId("u")),
		client: { host: "claude-code", connector: "byoa", connector_version: "0.1.0", machine_name: "laptop" },
		created_at: created,
		expires_at: created + 600_000,
		last_poll_at: null,
		status: "pending",
		approved_by: null,
		...overrides,
	};
}

async function connectionRecord(pairing: PairingRecord, userId: string, now: number): Promise<ConnectionRecord> {
	return {
		id: pairing.id,
		user_id: userId,
		display_name: "Alice",
		host: pairing.client.host,
		machine_name: pairing.client.machine_name ?? null,
		token_hash: await sha256Hex(randomId("byoa_")),
		created_at: now,
		revoked_at: null,
		last_seen_at: null,
	};
}

// ── the cases ───────────────────────────────────────────────────────────────

interface CaseDef {
	name: string;
	/** Needs the hub to take time from config.clock. */
	timing?: boolean;
	run(kit: Kit): Promise<void>;
}

const CASES: CaseDef[] = [
	// Durable pairing records.
	{
		name: "pairings: insert refuses a user code that a live pairing holds",
		async run(kit) {
			const pairings = kit.env.store.pairings;
			const first = await pairingRecord(T0);
			equal(await pairings.insert(first), true, "insert a new pairing");
			const clash = await pairingRecord(T0 + 1000, { user_code_hash: first.user_code_hash });
			equal(await pairings.insert(clash), false, "insert a pairing whose user code a live pairing holds");
			equal(await pairings.findByDeviceCode(clash.device_code_hash), null, "a refused insert writes nothing");
			equal(await pairings.insert(await pairingRecord(T0 + 1000)), true, "insert another user code");
			// Once the first has expired, its user code is free again.
			const later = await pairingRecord(first.expires_at + 1, { user_code_hash: first.user_code_hash });
			equal(await pairings.insert(later), true, "insert a user code whose pairing expired");
		},
	},
	{
		name: "pairings: findByUserCode returns only pending, unexpired pairings",
		async run(kit) {
			const pairings = kit.env.store.pairings;
			const p = await pairingRecord(T0);
			await pairings.insert(p);
			equal((await pairings.findByUserCode(p.user_code_hash, T0))?.id, p.id, "a pending pairing is found");
			equal((await pairings.findByUserCode(p.user_code_hash, p.expires_at - 1))?.id, p.id, "found until it expires");
			equal(await pairings.findByUserCode(p.user_code_hash, p.expires_at), null, "not found once expired");
			equal(await pairings.findByUserCode(await sha256Hex("unknown"), T0), null, "an unknown user code");
			ok(await pairings.decide(p.id, "approved", { user_id: kit.alice, display_name: "Alice" }, T0), "decide");
			equal(await pairings.findByUserCode(p.user_code_hash, T0), null, "not found once approved");
			const q = await pairingRecord(T0);
			await pairings.insert(q);
			ok(await pairings.decide(q.id, "denied", null, T0), "decide");
			equal(await pairings.findByUserCode(q.user_code_hash, T0), null, "not found once denied");
			// findByDeviceCode finds any status: the poll door reads it.
			const byDevice = await pairings.findByDeviceCode(p.device_code_hash);
			// user_code_hash is left out: the server never reads it back, so a
			// store may keep it hashed under its own pepper, or clear it on decide.
			deepEqual(withoutUserCode(byDevice), withoutUserCode({ ...p, status: "approved", approved_by: { user_id: kit.alice, display_name: "Alice" } }), "findByDeviceCode after approval");
			equal(await pairings.findByDeviceCode(await sha256Hex("unknown")), null, "an unknown device code");
		},
	},
	{
		name: "pairings: decide wins once",
		async run(kit) {
			const pairings = kit.env.store.pairings;
			const approver = { user_id: kit.alice, display_name: "Alice" };
			const p = await pairingRecord(T0);
			await pairings.insert(p);
			const [approved, denied] = await Promise.all([pairings.decide(p.id, "approved", approver, T0 + 1), pairings.decide(p.id, "denied", null, T0 + 1)]);
			equal([approved, denied].filter(Boolean).length, 1, "two racing decides: how many won");
			const after = await pairings.findByDeviceCode(p.device_code_hash);
			equal(after?.status, approved ? "approved" : "denied", "the status is the winner's");
			deepEqual(after?.approved_by, approved ? approver : null, "approved_by is the winner's");
			equal(await pairings.decide(p.id, "denied", null, T0 + 2), false, "a later decide");
			equal((await pairings.findByDeviceCode(p.device_code_hash))?.status, after?.status, "a later decide changes nothing");

			const late = await pairingRecord(T0);
			await pairings.insert(late);
			equal(await pairings.decide(late.id, "approved", approver, late.expires_at), false, "decide on an expired pairing");
			equal((await pairings.findByDeviceCode(late.device_code_hash))?.status, "pending", "an expired pairing stays pending");
			equal(await pairings.decide("conn_unknown", "approved", approver, T0), false, "decide on an unknown id");
		},
	},
	{
		name: "pairings: collect is atomic: one of several concurrent collects wins, and one connection exists",
		async run(kit) {
			const { pairings, connections } = kit.env.store;
			const p = await pairingRecord(T0);
			await pairings.insert(p);
			const candidates = await Promise.all([1, 2, 3, 4, 5].map(() => connectionRecord(p, kit.alice, T0 + 1)));
			equal(await pairings.collect(p.id, candidates[0] as ConnectionRecord, T0 + 1), false, "collect before approval");
			ok(await pairings.decide(p.id, "approved", { user_id: kit.alice, display_name: "Alice" }, T0 + 1), "decide");

			const results = await Promise.all(candidates.map((c) => pairings.collect(p.id, c, T0 + 2)));
			equal(results.filter(Boolean).length, 1, "five racing collects: how many won");
			const winner = candidates[results.indexOf(true)] as ConnectionRecord;
			deepEqual(await connections.listByUser(kit.alice), [winner], "the person's connections after the race");
			for (const c of candidates) if (c !== winner) equal(await connections.byTokenHash(c.token_hash), null, "a losing collect's token");
			equal((await pairings.findByDeviceCode(p.device_code_hash))?.status, "collected", "the pairing is collected");
			equal(await pairings.collect(p.id, await connectionRecord(p, kit.alice, T0 + 3), T0 + 3), false, "a later collect");

			const denied = await pairingRecord(T0);
			await pairings.insert(denied);
			await pairings.decide(denied.id, "denied", null, T0);
			equal(await pairings.collect(denied.id, await connectionRecord(denied, kit.bob, T0), T0), false, "collect a denied pairing");
			const expired = await pairingRecord(T0);
			await pairings.insert(expired);
			await pairings.decide(expired.id, "approved", { user_id: kit.bob, display_name: "Bob" }, T0);
			equal(await pairings.collect(expired.id, await connectionRecord(expired, kit.bob, expired.expires_at), expired.expires_at), false, "collect an expired pairing");
			deepEqual(await connections.listByUser(kit.bob), [], "a refused collect inserts no connection");
		},
	},
	{
		name: "pairings: notePoll records the poll and returns the previous one",
		async run(kit) {
			const pairings = kit.env.store.pairings;
			const p = await pairingRecord(T0);
			await pairings.insert(p);
			equal(await pairings.notePoll(p.id, T0 + 1), null, "the first poll");
			equal(await pairings.notePoll(p.id, T0 + 3000), T0 + 1, "the second poll");
			equal(await pairings.notePoll(p.id, T0 + 5000), T0 + 3000, "the third poll");
			equal((await pairings.findByDeviceCode(p.device_code_hash))?.last_poll_at, T0 + 5000, "last_poll_at");
			equal(await pairings.notePoll("conn_unknown", T0), null, "an unknown id");
		},
	},
	{
		name: "pairings: through the doors, pending, slow_down, the token once, then expired_token",
		async run(kit) {
			const app = kit.app();
			const started = await app.start();
			const error = async () => (await json(app.pairPoll(started))).error;
			equal(await error(), "authorization_pending", "the first poll");
			equal(await error(), "slow_down", "an immediate second poll");
			await status(app.decide(kit.alice, started), 200, "Connect");
			await app.clock.advance(2000);
			const { token } = await app.collect(started);
			ok(token.startsWith("byoa_"), "a token");
			await app.clock.advance(2000);
			equal(await error(), "expired_token", "a poll after collecting");

			const cancelled = await app.start();
			await status(app.decide(kit.alice, cancelled, "cancel"), 200, "Cancel");
			equal((await json(app.pairPoll(cancelled))).error, "access_denied", "a poll after Cancel");
		},
	},

	// Durable connection records.
	{
		name: "connections: byTokenHash, get and listByUser are scoped per person",
		async run(kit) {
			const app = kit.app();
			const connections = kit.env.store.connections;
			const a1 = await app.pair(kit.alice, "alice-mbp");
			const a2 = await app.pair(kit.alice, "alice-desk");
			const b1 = await app.pair(kit.bob, "bob-mbp");
			deepEqual((await connections.listByUser(kit.alice)).map((c) => c.id).sort(), [a1.connectionId, a2.connectionId].sort(), "Alice's connections");
			deepEqual((await connections.listByUser(kit.bob)).map((c) => c.id), [b1.connectionId], "Bob's connections");
			deepEqual(await connections.listByUser(`nobody-${hexId()}`), [], "an unknown person's connections");
			const record = await connections.get(a1.connectionId);
			deepEqual(
				record,
				{ id: a1.connectionId, user_id: kit.alice, display_name: "Alice", host: "claude-code", machine_name: "alice-mbp", token_hash: await sha256Hex(a1.token), created_at: T0, revoked_at: null, last_seen_at: null },
				"get",
			);
			deepEqual(await connections.byTokenHash(await sha256Hex(b1.token)), await connections.get(b1.connectionId), "byTokenHash");
			equal(await connections.byTokenHash(await sha256Hex("byoa_unknown")), null, "byTokenHash of an unknown token");
			equal(await connections.get("conn_unknown"), null, "get of an unknown id");
		},
	},
	{
		name: "connections: revoke sets revoked_at once and returns null for an unknown id",
		async run(kit) {
			const app = kit.app();
			const connections = kit.env.store.connections;
			const { connectionId } = await app.pair(kit.alice);
			const before = await connections.get(connectionId);
			const first = await connections.revoke(connectionId, T0 + 1000);
			deepEqual(first, { ...before, revoked_at: T0 + 1000 }, "the first revoke returns the record");
			const second = await connections.revoke(connectionId, T0 + 5000);
			equal(second?.revoked_at, T0 + 1000, "a second revoke keeps the first revoked_at");
			equal((await connections.get(connectionId))?.revoked_at, T0 + 1000, "revoked_at as stored");
			equal(await connections.revoke("conn_unknown", T0), null, "revoke of an unknown id");
		},
	},
	{
		name: "connections: touch updates last_seen_at",
		async run(kit) {
			const app = kit.app();
			const connections = kit.env.store.connections;
			const { token, connectionId } = await app.pair(kit.alice);
			equal((await connections.get(connectionId))?.last_seen_at, null, "last_seen_at before any use");
			await app.clock.advance(5000);
			await app.register(token);
			equal((await connections.get(connectionId))?.last_seen_at, T0 + 5000, "register touches the connection");
			await connections.touch(connectionId, T0 + 9000);
			equal((await connections.get(connectionId))?.last_seen_at, T0 + 9000, "touch");
			await connections.touch("conn_unknown", T0);
		},
	},
	{
		name: "records: never hold a raw token, a code, a session id or message text",
		async run(kit) {
			const app = kit.app();
			const { token, connectionId, started } = await app.pair(kit.alice);
			const sessionId = await app.register(token);
			const messageId = await app.sent(kit.alice, sessionId, "a distinctive request");
			equal((await app.commands(token, sessionId)).length, 1, "the poll takes the message");
			await status(app.events(token, sessionId, [{ message_id: messageId, seq: 0, type: "delta", text: "a telling answer" }]), 204, "events");
			const { pairings, connections } = kit.env.store;
			const records = canon([
				await connections.listByUser(kit.alice),
				await connections.get(connectionId),
				await connections.byTokenHash(await sha256Hex(token)),
				await pairings.findByDeviceCode(await sha256Hex(started.device_code)),
			]);
			const secrets = { token, device_code: started.device_code, user_code: started.user_code, normalized_user_code: started.user_code.replace("-", ""), session_id: sessionId, message_id: messageId, request: "distinctive", answer: "telling" };
			for (const [what, secret] of Object.entries(secrets)) ok(!records.includes(secret), `a durable record holds the ${what}`);
			ok(/"token_hash":"[0-9a-f]{64}"/.test(records), "the connection holds the token's SHA-256 hash");
		},
	},
	{
		name: "records: a record a store returns is a copy",
		async run(kit) {
			const { pairings, connections } = kit.env.store;
			const p = await pairingRecord(T0);
			await pairings.insert(p);
			p.status = "approved";
			equal((await pairings.findByDeviceCode(p.device_code_hash))?.status, "pending", "changing the inserted object");
			const found = await pairings.findByDeviceCode(p.device_code_hash);
			if (found !== null) found.status = "collected";
			equal((await pairings.findByDeviceCode(p.device_code_hash))?.status, "pending", "changing a returned pairing");
			const { connectionId } = await kit.app().pair(kit.alice);
			const got = await connections.get(connectionId);
			if (got !== null) got.revoked_at = 1;
			equal((await connections.get(connectionId))?.revoked_at, null, "changing a returned connection");
		},
	},

	// Restart.
	{
		name: "restart: the connection survives, the session is forgotten or kept, and re-register gives the same id",
		async run(kit) {
			if (kit.env.restart === undefined) return;
			const before = kit.app();
			const { token, connectionId } = await before.pair(kit.alice);
			const sessionId = await before.register(token);
			await before.sent(kit.alice, sessionId, "waiting across the restart");

			const after = kit.app({}, await kit.env.restart());
			const record = await after.store.connections.get(connectionId);
			ok(record !== null && record.revoked_at === null, "the connection survives a restart");
			equal((await after.store.connections.byTokenHash(await sha256Hex(token)))?.id, connectionId, "byTokenHash after a restart");
			const identity = await after.byoa.verifyBearer(new Request(`${ORIGIN}/mcp`, { headers: { authorization: `Bearer ${token}` } }));
			deepEqual(identity, { userId: kit.alice, connectionId }, "the token still authenticates");

			// Either the hub forgot the session (404, register again) or kept it.
			const res = await after.poll(token, sessionId);
			const answer = await json(res.clone());
			if (res.status === 404) equal(answer.error, "session_not_found", "a forgotten session's poll");
			else equal(res.status, 200, `the poll after a restart: expected 404 session_not_found or 200, got ${res.status} ${canon(answer)}`);
			equal(await after.register(token), sessionId, "re-register after a restart");
			await status(after.poll(token, sessionId), 200, "a poll after re-register");
			deepEqual(await after.sessionIds(kit.alice), [sessionId], "the session list after a restart");
			const messageId = await after.sent(kit.alice, sessionId, "after the restart");
			ok((await after.commands(token, sessionId)).some((c) => c.message_id === messageId), "a message sent after the restart reaches the poll");
		},
	},
	{
		name: "restart: a pairing started before a restart completes after it",
		async run(kit) {
			if (kit.env.restart === undefined) return;
			const before = kit.app();
			const approved = await before.start("approved-before");
			await status(before.decide(kit.alice, approved), 200, "Connect before the restart");
			const waiting = await before.start("approved-after");

			const after = kit.app({}, await kit.env.restart());
			const first = await after.collect(approved);
			await after.register(first.token);
			await status(after.decide(kit.alice, waiting), 200, "Connect after the restart");
			const second = await after.collect(waiting);
			await after.register(second.token);
			equal((await after.byoa.sessions(kit.alice)).length, 2, "two connections after the restart");
		},
	},

	// The hub, one per person.
	{
		name: "hub: two people's sessions are isolated, and another person's session answers like an unknown one",
		async run(kit) {
			const app = kit.app();
			const alice = await app.pair(kit.alice);
			const bob = await app.pair(kit.bob);
			const aliceSession = await app.register(alice.token);
			const bobSession = await app.register(bob.token, "host-b");
			const pairs: [string, (id: string) => Promise<Response>][] = [
				["poll", (id) => app.poll(alice.token, id)],
				["events", (id) => app.events(alice.token, id, [])],
				["send", (id) => app.send(kit.alice, id, "hello")],
				["interrupt", (id) => app.interrupt(kit.alice, id, "msg_x")],
			];
			for (const [door, call] of pairs) {
				const theirs = await call(bobSession);
				const unknown = await call("ses_unknown");
				equal(theirs.status, 404, `${door} on another person's session`);
				deepEqual(await theirs.json(), await unknown.json(), `${door}: another person's session and an unknown one answer alike`);
			}
			deepEqual(await app.sessionIds(kit.alice), [aliceSession], "Alice's sessions");
			deepEqual(await app.sessionIds(kit.bob), [bobSession], "Bob's sessions");
			const listed = await json(status(app.call("GET", "/byoa/ui/sessions", { user: kit.alice }), 200, "GET ui/sessions"));
			ok(!canon(listed).includes(bobSession), "Alice's session list names Bob's session");
			equal((await app.commands(bob.token, bobSession)).length, 0, "Bob still polls his own session");
		},
	},
	{
		name: "hub: one person's separate requests reach the same hub",
		async run(kit) {
			const app = kit.app();
			const laptop = await app.pair(kit.alice, "laptop");
			const desk = await app.pair(kit.alice, "desk");
			const s1 = await app.register(laptop.token, "host-1");
			const s2 = await app.register(desk.token, "host-2");
			deepEqual(await app.sessionIds(kit.alice), [s1, s2].sort(), "both connections' sessions are listed together");
			const messageId = await app.sent(kit.alice, s2, "to the desk");
			deepEqual((await app.commands(desk.token, s2)).map((c) => c.message_id), [messageId], "the desk's poll gets the message sent in another request");
			deepEqual(await app.commands(laptop.token, s1), [], "the laptop's poll gets nothing");
			const listed = await json(status(app.call("GET", "/byoa/ui/sessions", { user: kit.alice }), 200, "GET ui/sessions"));
			deepEqual(listed.connections.flatMap((c: any) => c.sessions.map((s: any) => s.id)).sort(), [s1, s2].sort(), "GET ui/sessions");
		},
	},
	{
		name: "hub: re-register returns the same session id",
		async run(kit) {
			const app = kit.app();
			const a = await app.pair(kit.alice, "laptop");
			const first = await app.register(a.token, "host-1");
			equal(await app.register(a.token, "host-1"), first, "the same host session again");
			ok((await app.register(a.token, "host-2")) !== first, "another host session gets another id");
			const b = await app.pair(kit.alice, "desk");
			ok((await app.register(b.token, "host-1")) !== first, "another connection gets another id");
			equal((await app.sessionIds(kit.alice)).length, 3, "three sessions listed");
		},
	},
	{
		name: "hub: the sessions-per-connection cap holds",
		async run(kit) {
			const app = kit.app({ limits: { sessionsPerConnection: 2 } });
			const a = await app.pair(kit.alice, "laptop");
			await app.register(a.token, "h1");
			await app.register(a.token, "h2");
			const third = await status(app.registerRaw(a.token, "h3"), 429, "a third session on one connection");
			equal((await json(third)).error, "too_many_sessions", "the error");
			await app.register(a.token, "h1");
			const b = await app.pair(kit.alice, "desk");
			await app.register(b.token, "h1");
			await app.register(b.token, "h2");
		},
	},

	// The hub, with scripted time.
	{
		name: "timing: a poll is held, then answers [] at the hold",
		timing: true,
		async run(kit) {
			const app = kit.app({ hold: 20 });
			const { token } = await app.pair(kit.alice);
			const id = await app.register(token);
			const held = app.poll(token, id);
			await app.clock.advance(19_999);
			ok(await pending(kit, held), "the poll is still held at 19.999 s");
			await app.clock.advance(1);
			deepEqual(await json(status(held, 200, "the held poll")), { commands: [] }, "the held poll at 20 s");
		},
	},
	{
		name: "timing: a newer poll answers the held one with []",
		timing: true,
		async run(kit) {
			const app = kit.app({ hold: 20 });
			const { token } = await app.pair(kit.alice);
			const id = await app.register(token);
			const older = app.poll(token, id, "ready");
			ok(await pending(kit, older), "the first poll is held");
			const newer = app.poll(token, id, "busy");
			deepEqual(await json(status(older, 200, "the older poll")), { commands: [] }, "the older poll");
			ok(await pending(kit, newer), "the newer poll is held");
			equal((await app.byoa.sessions(kit.alice))[0]?.sessions[0]?.state, "busy", "the newer poll's state");
			const messageId = await app.sent(kit.alice, id, "wake");
			deepEqual((await json(newer)).commands.map((c: any) => c.message_id), [messageId], "a send answers the held poll");
		},
	},
	{
		name: "timing: a session is gone after 60 s with no poll",
		timing: true,
		async run(kit) {
			const app = kit.app({ hold: 20 });
			const { token } = await app.pair(kit.alice);
			const id = await app.register(token);
			const state = async () => (await app.byoa.sessions(kit.alice))[0]?.sessions.find((s) => s.id === id)?.state;
			await app.clock.advance(59_999);
			equal(await state(), "ready", "the state at 59.999 s");
			await app.clock.advance(1);
			equal(await state(), "gone", "the state at 60 s");
			// A poll brings it back.
			const back = app.poll(token, id);
			await kit.settle();
			equal(await state(), "ready", "the state after a poll");
			await app.clock.advance(20_000);
			await back;
		},
	},
	{
		name: "timing: a waiting message is offered again after 30 s, but not once an event answered it",
		timing: true,
		async run(kit) {
			const app = kit.app({ hold: 20 });
			const { token } = await app.pair(kit.alice);
			const id = await app.register(token);
			const messageId = await app.sent(kit.alice, id, "hello");
			deepEqual((await app.commands(token, id)).map((c) => c.message_id), [messageId], "the first poll");
			const quiet = app.poll(token, id);
			await app.clock.advance(20_000);
			deepEqual(await json(quiet), { commands: [] }, "a poll within 30 s");
			await app.clock.advance(10_000);
			deepEqual((await app.commands(token, id)).map((c) => c.message_id), [messageId], "a poll at 30 s gets it again");
			await status(app.events(token, id, [{ message_id: messageId, seq: 0, type: "queued" }]), 204, "events");
			await app.clock.advance(31_000);
			const later = app.poll(token, id);
			ok(await pending(kit, later), "once an event answered it, a poll 31 s later holds empty");
			await app.clock.advance(20_000);
			deepEqual(await json(later), { commands: [] }, "and answers [] at the hold");
		},
	},
	{
		name: "timing: a gone session frees its place under the cap",
		timing: true,
		async run(kit) {
			const app = kit.app({ hold: 20, limits: { sessionsPerConnection: 1 } });
			const { token } = await app.pair(kit.alice);
			await app.register(token, "h1");
			await status(app.registerRaw(token, "h2"), 429, "a second session while the first is live");
			await app.clock.advance(60_000);
			await app.register(token, "h2");
		},
	},

	// Events.
	{
		name: "events: delivered in seq order, repeats dropped, with a typed seq_gap",
		async run(kit) {
			const app = kit.app({ limits: { seqLookAhead: 4 } });
			const { token } = await app.pair(kit.alice);
			const id = await app.register(token);
			const watch = await app.watch(kit.alice);
			const messageId = await app.sent(kit.alice, id, "go");
			await app.commands(token, id);
			const post = (events: unknown[]) => app.events(token, id, events.map((e) => ({ message_id: messageId, ...(e as object) })));
			await status(post([{ seq: 1, type: "delta", text: "b" }]), 204, "seq 1 before seq 0");
			await status(post([{ seq: 0, type: "started" }]), 204, "seq 0");
			await status(post([{ seq: 0, type: "started" }]), 204, "seq 0 again");
			const gap = await status(post([{ seq: 9, type: "delta", text: "far" }]), 422, "seq 9, past the look-ahead");
			deepEqual(await gap.json(), { error: "seq_gap", error_description: `Resend ${messageId} from seq 2.`, message_id: messageId, expected: 2 }, "the seq_gap answer");
			await status(post([{ seq: 2, type: "delta", text: "c" }, { seq: 3, type: "done" }]), 204, "seq 2 and the end");
			await kit.settle();
			deepEqual(shape(watch.of(messageId)), ["accepted", "started#0", "delta#1", "delta#2", "done#3"], "what the UI saw");
			watch.stop();
		},
	},
	{
		name: "events: the UI stream carries them in order",
		async run(kit) {
			const app = kit.app();
			const { token } = await app.pair(kit.alice);
			const id = await app.register(token);
			const stream = await status(app.call("GET", "/byoa/ui/events", { user: kit.alice }), 200, "GET ui/events");
			equal(stream.headers.get("content-type"), "text/event-stream; charset=utf-8", "the stream's content type");
			ok(stream.body !== null, "the stream has a body");
			const reader = stream.body.getReader();
			const frames: { event: string; data: any }[] = [];
			let buffer = "";
			const decoder = new TextDecoder();
			const readUntil = async (done: () => boolean) => {
				const deadline = Date.now() + 10_000;
				while (!done()) {
					let timer: unknown;
					const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), Math.max(0, deadline - Date.now()))));
					const next = await Promise.race([reader.read(), timeout]);
					clearTimeout(timer as Parameters<typeof clearTimeout>[0]);
					if (next === "timeout") fail(`the UI stream stopped early; frames so far: ${canon(frames.map((f) => f.event))}`);
					if (next.done) fail("the UI stream ended");
					buffer += decoder.decode(next.value, { stream: true });
					for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
						const block = buffer.slice(0, end);
						buffer = buffer.slice(end + 2);
						const event = /^event: (.+)$/m.exec(block)?.[1];
						const data = /^data: (.+)$/m.exec(block)?.[1];
						if (event !== undefined && data !== undefined) frames.push({ event, data: JSON.parse(data) });
					}
				}
			};
			try {
				await readUntil(() => frames.length > 0);
				equal(frames[0]?.event, "sessions", "the stream's first event");
				const messageId = await app.sent(kit.alice, id, "go");
				await app.commands(token, id);
				const events = [{ seq: 0, type: "started" }, { seq: 1, type: "delta", text: "hi" }, { seq: 2, type: "tool", name: "Read", title: "Read a file" }, { seq: 3, type: "done" }];
				await status(app.events(token, id, events.map((e) => ({ message_id: messageId, ...e }))), 204, "events");
				const mine = () => frames.filter((f) => f.data.message_id === messageId).map((f) => f.data as UiEvent);
				await readUntil(() => mine().some((e) => e.type === "event" && e.event.type === "done"));
				deepEqual(shape(mine()), ["accepted", "started#0", "delta#1", "tool#2", "done#3"], "the UI stream's events for the message");
			} finally {
				await reader.cancel().catch(() => undefined);
			}
		},
	},
	{
		name: "events: interrupt withdraws a waiting message and sends an interrupt for a handed one",
		async run(kit) {
			const app = kit.app();
			const { token } = await app.pair(kit.alice);
			const id = await app.register(token);
			const watch = await app.watch(kit.alice);

			const waiting = await app.sent(kit.alice, id, "never taken");
			deepEqual(await json(status(app.interrupt(kit.alice, id, waiting), 200, "interrupt a waiting message")), { outcome: "withdrawn" }, "interrupt a waiting message");
			deepEqual(await app.commands(token, id), [], "a withdrawn message never reaches a poll");

			const handed = await app.sent(kit.alice, id, "taken");
			deepEqual((await app.commands(token, id)).map((c) => c.message_id), [handed], "the poll takes it");
			deepEqual(await json(app.interrupt(kit.alice, id, handed)), { outcome: "interrupt_sent" }, "interrupt a handed message");
			deepEqual(await app.commands(token, id), [{ type: "interrupt", message_id: handed }], "the next poll carries the interrupt");
			await status(app.events(token, id, [{ message_id: handed, seq: 0, type: "interrupted", reason: "stopped" }]), 204, "events");
			deepEqual(await json(app.interrupt(kit.alice, id, handed)), { outcome: "already_finished" }, "interrupt a finished message");
			await kit.settle();
			deepEqual(shape(watch.of(waiting)), ["accepted", "withdrawn"], "the UI saw the waiting message withdrawn");
			deepEqual(shape(watch.of(handed)), ["accepted", "interrupted#0"], "the UI saw the handed message interrupted");
			watch.stop();
		},
	},

	// Revocation.
	{
		name: "revocation: revoking ends the held poll with 401 and drops that connection's sessions",
		async run(kit) {
			const app = kit.app({ hold: 20 });
			const laptop = await app.pair(kit.alice, "laptop");
			const desk = await app.pair(kit.alice, "desk");
			const s1 = await app.register(laptop.token, "host-1");
			const s2 = await app.register(desk.token, "host-2");
			const watch = await app.watch(kit.alice);
			const messageId = await app.sent(kit.alice, s1, "in flight");
			await app.commands(laptop.token, s1);
			const held = app.poll(laptop.token, s1);
			await pending(kit, held);

			await status(app.call("DELETE", `/byoa/ui/connections/${laptop.connectionId}`, { user: kit.bob }), 404, "Bob disconnects Alice's connection");
			await status(app.call("DELETE", `/byoa/ui/connections/${laptop.connectionId}`, { user: kit.alice }), 204, "Alice disconnects it");
			equal((await held).status, 401, "the held poll after revocation");
			ok(typeof (await kit.env.store.connections.get(laptop.connectionId))?.revoked_at === "number", "revoked_at is set");
			await status(app.registerRaw(laptop.token, "host-1"), 401, "register with the revoked token");
			equal((await json(status(app.send(kit.alice, s1, "after"), 404, "send to a dropped session"))).error, "session_not_found", "the error");
			deepEqual(await app.sessionIds(kit.alice), [s2], "only the other connection's session is left");
			await kit.settle();
			deepEqual(watch.of(messageId).at(-1), { type: "gone", session_id: s1, message_id: messageId, reason: "disconnected" }, "the open message ends gone");
			const other = await app.sent(kit.alice, s2, "still here");
			deepEqual((await app.commands(desk.token, s2)).map((c) => c.message_id), [other], "the other connection still works");
			watch.stop();
		},
	},
	{
		name: "revocation: the connector's revoke door is idempotent and ends the token",
		async run(kit) {
			const app = kit.app();
			const { token, connectionId } = await app.pair(kit.alice);
			const id = await app.register(token);
			await app.clock.advance(1000);
			await status(app.call("POST", "/byoa/revoke", { token }), 204, "revoke");
			await app.clock.advance(1000);
			await status(app.call("POST", "/byoa/revoke", { token }), 204, "revoke again");
			equal((await kit.env.store.connections.get(connectionId))?.revoked_at, T0 + 1000, "revoked_at stays the first revoke's");
			await status(app.poll(token, id), 401, "a poll with the revoked token");
			deepEqual(await app.byoa.sessions(kit.alice), [], "no connection is listed");
		},
	},
];

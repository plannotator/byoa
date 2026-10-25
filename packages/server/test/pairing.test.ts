// Rule 2: the device grant (SPEC 4.1, RFC 8628) and its approval page, and
// autoApprove for a local app with no accounts.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createByoa, memoryStore } from "../src/index.ts";
import { USER_CODE_ALPHABET } from "../src/crypto.ts";
import { body, FakeClock, makeApp, ORIGIN } from "./harness.ts";

const CLIENT = { client: { host: "claude-code", connector: "byoa", connector_version: "0.1.0", machine_name: "ramos-mbp" } };

async function start(app: ReturnType<typeof makeApp>, client: unknown = CLIENT) {
	return body(app.call("POST", "/byoa/pair/start", { body: client }));
}

async function csrfFor(app: ReturnType<typeof makeApp>, code: string, user = "ramos") {
	const page = await (await app.call("GET", `/byoa/connect?code=${code}`, { user })).text();
	return /name="csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
}

test("pair/start: codes, lifetime and interval", async () => {
	const app = makeApp();
	const s = await start(app);
	assert.match(s.user_code, new RegExp(`^[${USER_CODE_ALPHABET}]{4}-[${USER_CODE_ALPHABET}]{4}$`));
	assert.match(s.device_code, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(s.expires_in, 600);
	assert.equal(s.interval, 2);
	assert.equal(s.verification_uri, `${ORIGIN}/byoa/connect`);
	assert.equal(s.verification_uri_complete, `${ORIGIN}/byoa/connect?code=${s.user_code}`);
	assert.equal((await app.call("POST", "/byoa/pair/start", { body: { client: {} } })).status, 400);
	const hidden = { client: { ...CLIENT.client, machine_name: "ramos‮mbp" } };
	assert.equal((await body(app.call("POST", "/byoa/pair/start", { body: hidden }))).error, "invalid_request");
});

test("both codes are stored only as hashes", async () => {
	const app = makeApp();
	const s = await start(app);
	const normalized = s.user_code.replace("-", "");
	const dump = JSON.stringify(await app.store.pairings.findByUserCode(await (await import("../src/crypto.ts")).userCodeHash(normalized), app.clock.now()));
	assert.ok(dump.length > 2);
	assert.ok(!dump.includes(s.device_code) && !dump.includes(normalized) && !dump.includes(s.user_code));
});

test("poll: pending, slow_down, then the token minted at collection, once", async () => {
	const app = makeApp();
	const s = await start(app);
	const poll = () => body(app.call("POST", "/byoa/pair/poll", { body: { device_code: s.device_code } }));
	assert.equal((await poll()).error, "authorization_pending");
	await app.clock.advance(1000);
	assert.equal((await poll()).error, "slow_down");
	await app.clock.advance(2000);
	assert.equal((await poll()).error, "authorization_pending");

	// Approval mints nothing: no connection exists until the poll collects.
	const csrf = await csrfFor(app, s.user_code);
	await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: s.user_code, csrf, decision: "connect" } });
	assert.deepEqual(await app.store.connections.listByUser("ramos"), []);

	await app.clock.advance(2000);
	// Two polls race: exactly one gets the token.
	const [a, b] = await Promise.all([poll(), poll()]);
	const winners = [a, b].filter((r) => r.access_token !== undefined);
	assert.equal(winners.length, 1);
	assert.deepEqual([a, b].filter((r) => r.access_token === undefined).map((r) => r.error), ["slow_down"]);
	assert.equal(winners[0].token_type, "bearer");
	assert.equal(winners[0].account.display_name, "Ramos");
	await app.clock.advance(2000);
	assert.equal((await poll()).error, "expired_token");

	// The token is stored hashed.
	const [connection] = await app.store.connections.listByUser("ramos");
	assert.ok(connection !== undefined && !JSON.stringify(connection).includes(winners[0].access_token));
});

test("cancel answers access_denied; expiry answers expired_token", async () => {
	const app = makeApp();
	const s = await start(app);
	const csrf = await csrfFor(app, s.user_code);
	const cancelled = await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: s.user_code, csrf, decision: "cancel" } });
	assert.match(await cancelled.text(), /Cancelled/);
	assert.equal((await body(app.call("POST", "/byoa/pair/poll", { body: { device_code: s.device_code } }))).error, "access_denied");

	const late = await start(app);
	await app.clock.advance(600_000);
	assert.equal((await body(app.call("POST", "/byoa/pair/poll", { body: { device_code: late.device_code } }))).error, "expired_token");
	assert.equal((await body(app.call("POST", "/byoa/pair/poll", { body: { device_code: "nope" } }))).error, "expired_token");
});

test("the approval page: headers, contents, no side effect on GET", async () => {
	const app = makeApp();
	const s = await start(app);
	const res = await app.call("GET", `/byoa/connect?code=${s.user_code.toLowerCase().replace("-", "")}`, { user: "ramos" });
	assert.equal(res.headers.get("content-security-policy")?.startsWith("default-src 'none'; style-src 'unsafe-inline'"), true);
	assert.equal(res.headers.get("x-frame-options"), "DENY");
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.equal(res.headers.get("referrer-policy"), "same-origin");
	const html = await res.text();
	assert.ok(!html.includes("<script"));
	assert.ok(html.includes(s.user_code), "the code, normalized from lowercase without hyphen");
	assert.ok(html.includes("Claude Code"));
	assert.match(html, /ramos-mbp<\/strong> <span class="muted">\(unverified/);
	assert.ok(html.includes("Account: <strong>Ramos</strong>"));
	assert.ok(html.includes("requested 0 seconds ago"));
	assert.ok(html.includes("Claude Code on ramos-mbp can use Test App as you, and Test App can start turns in that agent's sessions."));

	// GET changed nothing: still pending.
	assert.equal((await body(app.call("POST", "/byoa/pair/poll", { body: { device_code: s.device_code } }))).error, "authorization_pending");
	await app.clock.advance(90_000);
	assert.ok((await (await app.call("GET", `/byoa/connect?code=${s.user_code}`, { user: "ramos" })).text()).includes("requested 2 minutes ago"));
});

test("the approval page needs the human session; approval needs CSRF bound to person and code", async () => {
	const app = makeApp();
	const s = await start(app);
	assert.equal((await app.call("GET", `/byoa/connect?code=${s.user_code}`)).status, 401);
	const csrf = await csrfFor(app, s.user_code, "ramos");

	const tries = [
		{ user: undefined, form: { code: s.user_code, csrf, decision: "connect" } },
		{ user: "dana", form: { code: s.user_code, csrf, decision: "connect" } },
		{ user: "ramos", form: { code: s.user_code, csrf: "forged", decision: "connect" } },
		{ user: "ramos", form: { code: s.user_code, csrf, decision: "connect" }, origin: "https://evil.example" },
		{ user: "ramos", form: { code: s.user_code, csrf, decision: "connect" }, headers: { authorization: "Bearer byoa_x" } },
	];
	for (const t of tries) {
		const res = await app.call("POST", "/byoa/connect", { user: t.user, form: t.form, ...(t.origin ? { origin: t.origin } : {}), ...(t.headers ? { headers: t.headers } : {}) });
		assert.notEqual(res.status, 200, JSON.stringify(t));
	}
	assert.equal((await body(app.call("POST", "/byoa/pair/poll", { body: { device_code: s.device_code } }))).error, "authorization_pending");

	// Another code's CSRF token does not approve this one.
	const other = await start(app);
	const otherCsrf = await csrfFor(app, other.user_code);
	assert.equal((await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: s.user_code, csrf: otherCsrf, decision: "connect" } })).status, 403);
});

test("unknown, expired and used codes all render one identical page", async () => {
	const app = makeApp();
	const used = await start(app);
	const csrf = await csrfFor(app, used.user_code);
	await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: used.user_code, csrf, decision: "connect" } });
	const expired = await start(app);
	await app.clock.advance(600_000);
	const pages = await Promise.all(
		["BCDF-GHJK", "nonsense", used.user_code, expired.user_code].map(async (code) => {
			const res = await app.call("GET", `/byoa/connect?code=${code}`, { user: "ramos" });
			return `${res.status} ${await res.text()}`;
		}),
	);
	assert.equal(new Set(pages).size, 1);
	assert.match(pages[0] ?? "", /This code is not valid/);
	// A replayed approval form meets the same page.
	const replay = await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: used.user_code, csrf, decision: "connect" } });
	assert.equal(`${replay.status} ${await replay.text()}`, pages[0]);
});

test("autoApprove: a local app with no accounts pairs on the first poll, no page", async () => {
	const app = makeApp({ app: { id: "machine", name: "Machine", origin: "http://localhost:7420" }, autoApprove: () => ({ userId: "local", displayName: "You" }) });
	const s = await body(app.byoa.handle(new Request("http://localhost:7420/byoa/pair/start", { method: "POST", body: JSON.stringify(CLIENT) })) as Promise<Response>);
	const collected = await body(app.byoa.handle(new Request("http://localhost:7420/byoa/pair/poll", { method: "POST", body: JSON.stringify({ device_code: s.device_code }) })) as Promise<Response>);
	assert.match(collected.access_token, /^byoa_/);
	assert.equal(collected.account.display_name, "You");

	assert.throws(
		() => createByoa({ app: { id: "x", name: "X", origin: ORIGIN }, authenticate: async () => null, store: memoryStore(), clock: new FakeClock(), autoApprove: () => ({ userId: "u", displayName: "U" }) }),
		/loopback/,
	);
});

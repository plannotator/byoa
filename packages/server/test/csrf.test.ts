// The default CSRF check (byoa.ts sameOrigin). A browser's form POST from a
// page with Referrer-Policy: no-referrer carries `Origin: null`; the check
// then takes the browser's own Sec-Fetch-Site. Found by pressing Connect in
// a real Chromium, where the 0.1.0 check refused every press.

import assert from "node:assert/strict";
import { test } from "node:test";
import { sameOrigin } from "../src/byoa.ts";
import { FakeClock, settle } from "../src/fake-clock.ts";
import { storeConformance } from "../src/conformance.ts";
import { memoryStore } from "../src/index.ts";

const APP = "https://app.example";
const post = (headers: Record<string, string>) => new Request(`${APP}/byoa/connect`, { method: "POST", headers });

test("the default CSRF check: what passes and what is refused", () => {
	assert.ok(sameOrigin(new Request(`${APP}/byoa/connect`), APP), "a GET is never checked");
	assert.ok(sameOrigin(post({ origin: APP }), APP), "the app's own Origin");
	assert.ok(sameOrigin(post({ origin: "null", "sec-fetch-site": "same-origin" }), APP), "Origin null from a no-referrer page, same-origin per the browser");
	assert.ok(sameOrigin(post({ "sec-fetch-site": "same-origin" }), APP), "no Origin, same-origin per the browser");
	assert.ok(!sameOrigin(post({ origin: "https://evil.example" }), APP), "another origin");
	assert.ok(!sameOrigin(post({ origin: "https://evil.example", "sec-fetch-site": "same-origin" }), APP), "another origin, whatever Sec-Fetch-Site says");
	assert.ok(!sameOrigin(post({ origin: "null", "sec-fetch-site": "cross-site" }), APP), "Origin null from another site");
	assert.ok(!sameOrigin(post({ origin: "null", "sec-fetch-site": "same-site" }), APP), "Origin null from a sibling subdomain");
	assert.ok(!sameOrigin(post({ origin: "null" }), APP), "Origin null and no Sec-Fetch-Site");
	assert.ok(!sameOrigin(post({}), APP), "neither header");
	assert.ok(!sameOrigin(new Request(`${APP}/byoa/ui/connections/c`, { method: "DELETE", headers: { origin: "null", "sec-fetch-site": "none" } }), APP), "a DELETE typed into the address bar");
});

test("a FakeClock waits with the settle it was given", async () => {
	let calls = 0;
	const clock = new FakeClock(0, async () => {
		calls++;
		await settle();
	});
	let fired = false;
	clock.setTimeout(() => (fired = true), 1000);
	await clock.advance(1000);
	assert.ok(fired);
	assert.ok(calls >= 3, `settle ran ${calls} times`);
});

test("conformance: a store whose I/O outlasts the default settle passes with its own settle", async () => {
	// Every store call waits 40 ms of real time, longer than the default settle, as a database round trip would.
	const slow = () => {
		const base = memoryStore();
		const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
		const wrap = <T extends object>(o: T): T =>
			new Proxy(o, {
				get(target, key, receiver) {
					const value = Reflect.get(target, key, receiver);
					return typeof value === "function" ? async (...args: unknown[]) => (await delay(), value.apply(target, args)) : value;
				},
			});
		return { store: { pairings: wrap(base.pairings), connections: wrap(base.connections), hub: base.hub } };
	};
	const cases = storeConformance(slow, { settle: () => new Promise((resolve) => setTimeout(resolve, 200)) });
	const held = cases.find((c) => c.name.startsWith("timing: a poll is held"));
	assert.ok(held);
	await held.run();
});

test("conformance: the settle option also decides whether a poll is still held", async () => {
	// A broken store: its hub answers every poll at once, but only after 40 ms
	// of real time. With the default settle the poll would look held and pass.
	const broken = () => {
		const base = memoryStore();
		return {
			store: {
				...base,
				hub: (userId: string, config: Parameters<typeof base.hub>[1]) => {
					const hub = base.hub(userId, config);
					const poll = async () => (await new Promise((resolve) => setTimeout(resolve, 40)), { kind: "commands" as const, commands: [] });
					return new Proxy(hub, {
						get: (target, key) => (key === "poll" ? poll : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key)),
					});
				},
			},
		};
	};
	const cases = storeConformance(broken, { settle: () => new Promise((resolve) => setTimeout(resolve, 200)) });
	const newer = cases.find((c) => c.name.startsWith("timing: a newer poll answers"));
	assert.ok(newer);
	await assert.rejects(newer.run(), /the first poll is held/);
});

test("an encoded BYOA path is refused, never decoded", async () => {
	const { createByoa } = await import("../src/index.ts");
	const byoa = createByoa({ app: { id: "t", name: "T", origin: APP }, authenticate: async () => ({ userId: "u", displayName: "U" }) });
	const start = await byoa.handle(new Request(`${APP}/byoa/pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
	assert.notEqual(start?.status, 404, "the plain path is served");
	for (const path of ["/byoa/pair/%73tart", "/byoa/%63onnect?code=BCDF-GHJK", "/byoa/sessions%2Fx/poll", "/byoa/ui/%73essions", "/byoa/%"]) {
		const res = await byoa.handle(new Request(`${APP}${path}`, { method: path.includes("connect") || path.includes("ui/") ? "GET" : "POST", body: path.includes("connect") || path.includes("ui/") ? undefined : "{}" }));
		assert.equal(res?.status, 404, path);
	}
});

test("hostName names only known hosts; a prototype member is shown as declared", async () => {
	const { hostName } = await import("../src/pages.ts");
	assert.equal(hostName("claude-code"), "Claude Code");
	for (const h of ["constructor", "toString", "__proto__"]) assert.equal(hostName(h), h);
});

// onError: every caught failure reaches the app's handler with its own
// request before the 500, console.error stays quiet when there is one, and
// a handler that throws never escapes.

import assert from "node:assert/strict";
import { test } from "node:test";
import { body, makeApp, ORIGIN } from "./harness.ts";

/** Runs `fn` with console.error recorded instead of printed. */
async function quiet<T>(fn: (logged: unknown[][]) => Promise<T>): Promise<T> {
	const original = console.error;
	const logged: unknown[][] = [];
	console.error = (...args: unknown[]) => void logged.push(args);
	try {
		return await fn(logged);
	} finally {
		console.error = original;
	}
}

test("a door that throws: onError gets the error and the request, then 500", async () => {
	const boom = new Error("session store down");
	const seen: { error: unknown; req: Request }[] = [];
	const app = makeApp({
		authenticate: async () => {
			throw boom;
		},
		onError: (error, req) => void seen.push({ error, req }),
	});
	await quiet(async (logged) => {
		const res = await app.call("GET", "/byoa/ui/sessions", { user: "ramos" });
		assert.equal(res.status, 500);
		assert.deepEqual(await body(res), { error: "server_error", error_description: "Something failed on the app's side." });
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.error, boom);
		assert.equal(seen[0]?.req.url, `${ORIGIN}/byoa/ui/sessions`);
		assert.deepEqual(logged, [], "no console.error when onError is set");
	});
});

test("without onError, the error's message goes to console.error, never the request", async () => {
	const app = makeApp({
		authenticate: async () => {
			throw new Error("session store down");
		},
	});
	await quiet(async (logged) => {
		assert.equal((await app.call("GET", "/byoa/ui/sessions", { user: "ramos" })).status, 500);
		assert.deepEqual(logged, [["byoa: door failed", "session store down"]]);
	});
});

test("an onError that throws is ignored; the 500 still goes out", async () => {
	const app = makeApp({
		authenticate: async () => {
			throw new Error("first");
		},
		onError: () => {
			throw new Error("the handler failed too");
		},
	});
	await quiet(async (logged) => {
		const res = await app.call("GET", "/byoa/ui/sessions", { user: "ramos" });
		assert.equal(res.status, 500);
		assert.deepEqual(logged, []);
	});
});

test("a throw in renderPage reaches onError and answers 500", async () => {
	const boom = new Error("template missing");
	const errors: unknown[] = [];
	const app = makeApp({
		renderPage: () => {
			throw boom;
		},
		onError: (error) => void errors.push(error),
	});
	const res = await app.call("GET", "/byoa/connect", { user: "ramos" });
	assert.equal(res.status, 500);
	assert.deepEqual(errors, [boom]);
});

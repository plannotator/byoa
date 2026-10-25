// Test harness: a scripted clock (no test ever sleeps), an app with two
// people, and helpers that drive the doors the way a connector and a
// browser would. Everything goes through byoa.handle, as in production.

import assert from "node:assert/strict";
import type { SessionCapabilities } from "@plannotator/byoa-protocol";
import { FakeClock, settle } from "../src/fake-clock.ts";
import { createByoa, memoryStore, type ByoaOptions, type UiEvent } from "../src/index.ts";

export { FakeClock, settle };

export const ORIGIN = "https://app.example";
const USERS: Record<string, string> = { ramos: "Ramos", dana: "Dana" };

export const CAPS: SessionCapabilities = {
	interrupt: true,
	stream: true,
	settings: [{ id: "model", name: "Model", value: null, choices: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] }],
};

interface CallOptions {
	token?: string;
	user?: string;
	body?: unknown;
	form?: Record<string, string>;
	origin?: string | null;
	headers?: Record<string, string>;
}

export function makeApp(options: Partial<ByoaOptions> = {}) {
	const clock = new FakeClock();
	const store = memoryStore();
	const byoa = createByoa({
		app: { id: "test", name: "Test App", origin: ORIGIN },
		authenticate: async (req) => {
			const id = /session=(\w+)/.exec(req.headers.get("cookie") ?? "")?.[1];
			return id !== undefined && USERS[id] !== undefined ? { userId: id, displayName: USERS[id] } : null;
		},
		clock,
		store,
		...options,
	});

	async function call(method: string, path: string, opts: CallOptions = {}): Promise<Response> {
		const headers: Record<string, string> = { ...opts.headers };
		if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
		if (opts.user !== undefined) {
			headers.cookie = `session=${opts.user}`;
			// A browser sends its own origin on POST and DELETE.
			if (opts.origin !== null && method !== "GET") headers.origin = opts.origin ?? ORIGIN;
		} else if (opts.origin) headers.origin = opts.origin;
		let body: string | undefined;
		if (opts.form !== undefined) {
			headers["content-type"] = "application/x-www-form-urlencoded";
			body = new URLSearchParams(opts.form).toString();
		} else if (opts.body !== undefined && method !== "GET") {
			headers["content-type"] = "application/json";
			body = JSON.stringify(opts.body);
		}
		const response = await byoa.handle(new Request(ORIGIN + path, { method, headers, ...(body !== undefined ? { body } : {}) }));
		assert.ok(response !== null, `${method} ${path} is a BYOA route`);
		return response;
	}

	/** The device grant end to end: start, approve on the page, collect. */
	async function pair(user = "ramos", machine = "ramos-mbp") {
		const start = await body(call("POST", "/byoa/pair/start", { body: { client: { host: "claude-code", connector: "byoa", connector_version: "0.1.0", machine_name: machine } } }));
		const page = await (await call("GET", `/byoa/connect?code=${start.user_code}`, { user })).text();
		const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
		assert.ok(csrf, "the consent page carries a csrf token");
		const approved = await call("POST", "/byoa/connect", { user, form: { code: start.user_code, csrf, decision: "connect" } });
		assert.equal(approved.status, 200);
		await clock.advance(2000);
		const collected = await call("POST", "/byoa/pair/poll", { body: { device_code: start.device_code } });
		assert.equal(collected.status, 200);
		const answer = await body(collected);
		return { token: answer.access_token as string, connectionId: answer.connection_id as string, start };
	}

	async function register(token: string, hostSessionId = "host-1", capabilities: SessionCapabilities = CAPS) {
		const response = await call("POST", "/byoa/sessions", {
			token,
			body: { host_session_id: hostSessionId, host: "claude-code", connector_version: "0.1.0", workspace: { folder_name: "byoa" }, started_at: "2026-10-21T11:00:00Z", capabilities },
		});
		assert.equal(response.status, 200);
		return (await body(response)).session.id as string;
	}

	/** A poll, held or not: await `.response` later. */
	function poll(token: string, sessionId: string, state: "ready" | "busy" | "blocked" = "ready", extra: Record<string, unknown> = {}) {
		return call("POST", `/byoa/sessions/${sessionId}/poll`, { token, body: { state, ...extra } });
	}

	function events(token: string, sessionId: string, list: unknown[]) {
		return call("POST", `/byoa/sessions/${sessionId}/events`, { token, body: { events: list } });
	}

	function send(user: string, sessionId: string, body: Record<string, unknown>) {
		return call("POST", `/byoa/ui/sessions/${sessionId}/messages`, { user, body });
	}

	/** Everything subscribe delivers to this person, as it arrives. */
	function watch(user = "ramos") {
		const seen: UiEvent[] = [];
		const stop = byoa.subscribe(user, (event) => seen.push(event));
		return { seen, stop, messages: (id: string) => seen.filter((e) => e.type !== "sessions" && e.message_id === id) };
	}

	return { byoa, clock, store, call, pair, register, poll, events, send, watch };
}

/** A response's JSON body, loosely typed: tests read what they assert on. */
export async function body(response: Response | Promise<Response>): Promise<any> {
	return (await response).json();
}

/** True when the promise has not settled yet. */
export async function pending(promise: Promise<unknown>): Promise<boolean> {
	const marker = Symbol("pending");
	await settle();
	return (await Promise.race([promise, Promise.resolve(marker)])) === marker;
}

/** Read SSE frames off a stream as they come. `ended()` is true once the
 * server closed the stream. */
export function sseReader(response: Response) {
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let ended = false;
	const frames: string[] = [];
	(async () => {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				ended = true;
				return;
			}
			buffer += decoder.decode(value, { stream: true });
			let end = buffer.indexOf("\n\n");
			while (end >= 0) {
				frames.push(buffer.slice(0, end));
				buffer = buffer.slice(end + 2);
				end = buffer.indexOf("\n\n");
			}
		}
	})();
	return {
		frames,
		ended: () => ended,
		events: () =>
			frames
				.filter((f) => f.startsWith("event: "))
				.map((f) => ({ type: /^event: (\w+)/.exec(f)?.[1], data: JSON.parse(f.slice(f.indexOf("data: ") + 6)) })),
		cancel: () => reader.cancel(),
	};
}

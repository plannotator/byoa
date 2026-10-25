// prepareSend: the UI send door hands the app its parsed body after every
// check it makes, the app writes the turn, and the door checks and sends
// that as before. A Response goes out as is; a throw is a 500.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { PrepareSendInput, PreparedSend } from "../src/index.ts";
import { body, makeApp, ORIGIN, pending } from "./harness.ts";

/** An app whose prepareSend records each call and answers with `answer`. */
async function setup(answer: (input: PrepareSendInput) => PreparedSend | Response | Promise<PreparedSend | Response>) {
	const calls: PrepareSendInput[] = [];
	const errors: unknown[] = [];
	const app = makeApp({
		prepareSend: (input) => {
			calls.push(input);
			return answer(input);
		},
		onError: (error) => void errors.push(error),
	});
	const { token } = await app.pair();
	const id = await app.register(token);
	return { app, token, id, calls, errors };
}

test("the hook gets the person, the session and the raw body, and its message is sent", async () => {
	const { app, token, id, calls } = await setup(({ body: b, displayName }) => {
		const { doc } = b as { doc: string };
		return { text: `Look at document ${doc}.`, kind: "task", set: { model: "sonnet" }, from: `${displayName} (via Docs)` };
	});
	const watch = app.watch();
	const res = await app.send("ramos", id, { doc: "doc_42", anything: [1, 2] });
	assert.equal(res.status, 202);
	const { message_id } = await body(res);
	assert.equal(calls.length, 1);
	const [call] = calls;
	assert.deepEqual({ ...call, req: undefined }, { userId: "ramos", displayName: "Ramos", sessionId: id, body: { doc: "doc_42", anything: [1, 2] }, req: undefined });
	assert.equal(call?.req.url, `${ORIGIN}/byoa/ui/sessions/${id}/messages`);
	assert.deepEqual((await body(app.poll(token, id))).commands, [
		{ type: "message", message_id, kind: "task", from: { display_name: "Ramos (via Docs)" }, text: "Look at document doc_42.", interrupt_first: false, stream: true, set: { model: "sonnet" } },
	]);
	const accepted = watch.messages(message_id)[0];
	assert.ok(accepted?.type === "accepted" && accepted.text === "Look at document doc_42.");
});

test("defaults: kind chat, from the person, stream on, no interrupt", async () => {
	const { app, token, id } = await setup(() => ({ text: "hello" }));
	const { message_id } = await body(app.send("ramos", id, {}));
	assert.deepEqual((await body(app.poll(token, id))).commands, [{ type: "message", message_id, kind: "chat", from: { display_name: "Ramos" }, text: "hello", interrupt_first: false, stream: true }]);
});

test("a Response from the hook is sent as is, and nothing is queued", async () => {
	const { app, token, id } = await setup(() => new Response("no such document", { status: 409, headers: { "x-app": "docs" } }));
	const res = await app.send("ramos", id, { doc: "gone" });
	assert.equal(res.status, 409);
	assert.equal(res.headers.get("x-app"), "docs");
	assert.equal(await res.text(), "no such document");
	assert.ok(await pending(app.poll(token, id)), "the poll stays held, empty");
});

test("what the hook returns is checked under the door's rules", async () => {
	let next: PreparedSend = { text: "" };
	const { app, id } = await setup(() => next);
	const refused = async (prepared: PreparedSend) => {
		next = prepared;
		const res = await app.send("ramos", id, {});
		assert.equal(res.status, 422, JSON.stringify(prepared));
		return (await body(res)).error_description as string;
	};
	assert.equal(await refused({ text: "  " }), "text: must not be empty");
	assert.match(await refused({ text: "x".repeat(64 * 1024 + 1) }), /at most/);
	assert.match(await refused({ text: "hi", kind: "shout" as never }), /kind/);
	assert.match(await refused({ text: "hi", set: { effort: "max" } }), /no such setting/);
	assert.match(await refused({ text: "hi", set: { model: "gpt" } }), /choices/);
	assert.match(await refused({ text: "hi", interruptFirst: "yes" as never }), /interrupt_first/);
	assert.match(await refused({ text: "hi", from: 7 as never }), /from/);
});

test("the door's own checks run first; the hook never sees a refused request", async () => {
	const { app, token, id, calls } = await setup(() => ({ text: "hi" }));
	const path = `/byoa/ui/sessions/${id}/messages`;
	assert.equal((await app.call("POST", path, { body: { text: "hi" } })).status, 401, "no session");
	assert.equal((await app.call("POST", path, { user: "ramos", origin: "https://evil.example", body: {} })).status, 403, "CSRF");
	assert.equal((await app.call("POST", path, { user: "ramos", token, body: {} })).status, 401, "a bearer");
	assert.equal((await app.call("POST", path, { user: "ramos", body: { pad: "x".repeat(130 * 1024) } })).status, 413, "too large");
	assert.equal((await app.call("POST", path, { user: "ramos", headers: { "content-type": "application/json" }, body: undefined })).status, 400, "no JSON");
	assert.equal(calls.length, 0);
});

test("a throw in the hook goes to onError and answers 500 server_error", async () => {
	const boom = new Error("docs database down");
	const { app, id, errors } = await setup(() => {
		throw boom;
	});
	const res = await app.send("ramos", id, {});
	assert.equal(res.status, 500);
	assert.equal((await body(res)).error, "server_error");
	assert.deepEqual(errors, [boom]);
});

test("without the hook the door reads text, kind, interrupt_first, stream and set, as before", async () => {
	const app = makeApp();
	const { token } = await app.pair();
	const id = await app.register(token);
	const { message_id } = await body(app.send("ramos", id, { text: "plain", kind: "reply", stream: false, set: { model: "opus" } }));
	assert.deepEqual((await body(app.poll(token, id))).commands, [{ type: "message", message_id, kind: "reply", from: { display_name: "Ramos" }, text: "plain", interrupt_first: false, stream: false, set: { model: "opus" } }]);
});

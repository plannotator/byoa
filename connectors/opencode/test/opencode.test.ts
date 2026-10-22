// The OpenCode adapter against a fake server-plugin context and fake apps:
// TUI hellos and OpenCode's events in, the app's events out.
import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../../../packages/connector-core/test/fakes.ts";
import { NOTES, ocWorld, TASKS } from "./fakes.ts";

const S = "ses_root";
const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: S, ...data } });

test("no TUI hello: nothing registers, however long the plugin runs", async () => {
	const w = await ocWorld();
	await w.step(5);
	assert.equal(app(w.net, NOTES.origin).sessions.size, 0);
	assert.equal(w.oc.tools.length, 0);
});

test("a hello registers the shown session as opencode, and adds the proxied tools once", async () => {
	const w = await ocWorld();
	await w.running.hello([S]);
	await w.step(2);
	await w.running.hello([S]);
	await w.step();
	const s = app(w.net, NOTES.origin).session();
	assert.equal(s.register.host, "opencode");
	assert.equal(s.register.host_version, "2.1.2");
	assert.equal(s.register.host_session_id, S);
	assert.deepEqual(s.register.workspace, { folder_name: "northstar" });
	assert.deepEqual(w.oc.tools.map((t) => t.name), ["notes"]);
	assert.equal(w.oc.reloads, 1);
	assert.equal(w.oc.tools[0]?.options?.codemode, false);
});

test("a subagent session never registers", async () => {
	const w = await ocWorld();
	w.oc.infos.set("ses_child", { id: "ses_child", parentID: S });
	await w.running.hello(["ses_child"]);
	await w.step(2);
	assert.deepEqual([...app(w.net, NOTES.origin).sessions.values()].map((s) => s.register.host_session_id), [S], "only its root, which a hello for the child stands for");
});

test("a message is a queued prompt, never steer, and its turn streams back once per block", async () => {
	const w = await ocWorld();
	const notes = app(w.net, NOTES.origin);
	await w.running.hello([S]);
	await w.step(2);
	notes.send({ message_id: "m1", text: "hello" });
	await w.step(3);
	assert.equal(w.oc.prompts.length, 1);
	assert.equal(w.oc.prompts[0]?.delivery, "queue");
	assert.match(w.oc.prompts[0]?.text ?? "", /^\[BYOA\] Notes \(127\.0\.0\.1:4100\) · chat from Dana · m1\nhello$/);
	w.deliverOurs();
	w.emit(
		ev("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "Hi " }),
		ev("session.tool.input.started", { assistantMessageID: "a1", id: "c1", name: "read" }),
		ev("session.text.ended", { assistantMessageID: "a1", ordinal: 0, text: "Hi there" }),
		ev("session.text.ended", { assistantMessageID: "a2", ordinal: 0, text: "Whole block" }),
		ev("session.reasoning.delta", { assistantMessageID: "a2", ordinal: 1, delta: "thinking is never sent" }),
		ev("session.execution.succeeded"),
	);
	await w.step(3);
	assert.deepEqual(notes.eventsOf("m1"), ["started", "delta:Hi ", "tool:read", "delta:there", "delta:Whole block", "done"]);
});

test("busy while an execution runs or someone else's row waits; ready after", async () => {
	const w = await ocWorld();
	const notes = app(w.net, NOTES.origin);
	await w.running.hello([S]);
	await w.step(2);
	w.emit(ev("session.inbox.enqueued", { inboxID: "msg_p", item: { type: "user", payload: { text: "the person's prompt" }, delivery: "steer" } }));
	await w.step();
	assert.equal(notes.session().polls.at(-1)?.state, "busy");
	w.emit(ev("session.execution.started"), ev("session.inbox.delivered", { inboxID: "msg_p" }));
	notes.send({ message_id: "m1", text: "later" });
	await w.step(3);
	assert.equal(w.oc.prompts.length, 0, "nothing is prompted into a running session");
	w.emit(ev("session.execution.succeeded"));
	await w.step(3);
	assert.equal(w.oc.prompts.length, 1);
	assert.deepEqual(notes.eventsOf("m1").slice(0, 2), ["queued", "started"]);
});

test("a prompt typed into our turn silences it and takes it over at delivery", async () => {
	const w = await ocWorld();
	const notes = app(w.net, NOTES.origin);
	await w.running.hello([S]);
	await w.step(2);
	notes.send({ message_id: "m1", text: "x" });
	await w.step(3);
	w.deliverOurs();
	w.emit(
		ev("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "ours " }),
		ev("session.inbox.enqueued", { inboxID: "msg_p", item: { type: "user", payload: { text: "PERSONAL" }, delivery: "steer" } }),
		ev("session.text.delta", { assistantMessageID: "a1", ordinal: 0, delta: "silenced" }),
		ev("session.inbox.delivered", { inboxID: "msg_p" }),
		ev("session.text.delta", { assistantMessageID: "a2", ordinal: 0, delta: "the person's own answer" }),
		ev("session.execution.succeeded"),
	);
	await w.step(3);
	assert.deepEqual(notes.eventsOf("m1"), ["started", "delta:ours ", "interrupted:taken_over"]);
});

test("interrupt calls session.interrupt for our turn only, and it ends interrupted stopped", async () => {
	const w = await ocWorld();
	const notes = app(w.net, NOTES.origin);
	await w.running.hello([S]);
	await w.step(2);
	notes.send({ message_id: "m1", text: "x" });
	await w.step(3);
	w.deliverOurs();
	notes.interrupt("m1");
	await w.step();
	assert.deepEqual(w.oc.interrupts, [S]);
	w.emit(ev("session.execution.interrupted", { reason: "user" }));
	await w.step(3);
	assert.deepEqual(notes.eventsOf("m1"), ["started", "interrupted:stopped"]);
});

test("a failed execution ends error turn_failed; a permission prompt is blocked", async () => {
	const w = await ocWorld();
	const notes = app(w.net, NOTES.origin);
	await w.running.hello([S]);
	await w.step(2);
	notes.send({ message_id: "m1", text: "x" });
	await w.step(3);
	w.deliverOurs();
	w.emit(ev("permission.asked", { id: "per_1", action: "shell", resources: [] }));
	await w.step();
	assert.equal(notes.session().polls.at(-1)?.state, "blocked");
	w.emit(ev("permission.replied", { requestID: "per_1", reply: "reject" }), ev("session.execution.failed", { error: {} }));
	await w.step(3);
	assert.deepEqual(notes.eventsOf("m1"), ["started", "error:turn_failed"]);
});

test("a lost end event is found by asking OpenCode (session.wait)", async () => {
	const w = await ocWorld();
	const notes = app(w.net, NOTES.origin);
	const live = async (n: number) => {
		for (let i = 0; i < n; i++) {
			await w.running.hello([S]);
			await w.step();
		}
	};
	await live(2);
	notes.send({ message_id: "m1", text: "x" });
	await live(3);
	w.oc.idle = false;
	w.deliverOurs();
	await live(22);
	assert.deepEqual(notes.eventsOf("m1"), ["started"], "a quiet run that OpenCode says still runs goes on");
	await new Promise((r) => setTimeout(r, 400));
	w.oc.idle = true;
	await live(22);
	assert.deepEqual(notes.eventsOf("m1"), ["started", "done"]);
});

test("the TUI going away retires the session; a hello brings it back under the same id", async () => {
	const w = await ocWorld();
	const notes = app(w.net, NOTES.origin);
	await w.running.hello([S]);
	await w.step(2);
	w.oc.idle = false;
	w.emit(ev("session.execution.started"));
	notes.send({ message_id: "m1", text: "x" });
	await w.step(12);
	assert.deepEqual(notes.eventsOf("m1"), ["queued", "withdrawn:session_ended"]);
	const polls = notes.session().polls.length;
	await w.step(3);
	assert.equal(notes.session().polls.length, polls, "no polls without a TUI");
	await w.running.hello([S]);
	await w.step(2);
	assert.equal(notes.sessions.size, 1);
	assert.ok(notes.session().polls.length > polls);
});

test("two apps' messages run one after the other", async () => {
	const w = await ocWorld([NOTES, TASKS]);
	const notes = app(w.net, NOTES.origin);
	const tasks = app(w.net, TASKS.origin);
	await w.running.hello([S]);
	await w.step(2);
	tasks.send({ message_id: "t1", text: "first" });
	await w.step();
	notes.send({ message_id: "n1", text: "second" });
	await w.step(3);
	assert.equal(w.oc.prompts.length, 1);
	w.deliverOurs();
	w.emit(ev("session.execution.succeeded"));
	await w.step(3);
	assert.equal(w.oc.prompts.length, 2);
	assert.match(w.oc.prompts[1]?.text ?? "", /Notes/);
	w.deliverOurs();
	w.emit(ev("session.execution.succeeded"));
	await w.step(3);
	assert.deepEqual(tasks.eventsOf("t1"), ["started", "done"]);
	assert.deepEqual(notes.eventsOf("n1"), ["queued", "started", "done"]);
});

test("settings: the model is declared with display names and switched before the turn", async () => {
	const w = await ocWorld();
	const notes = app(w.net, NOTES.origin);
	await w.running.hello([S]);
	await w.step(3);
	const model = notes.session().polls.findLast((p) => p.settings)?.settings?.[0] ?? notes.session().register.capabilities.settings[0];
	assert.equal(model?.value, "echo/echo-1");
	assert.deepEqual(model?.choices, [{ value: "echo/echo-1", name: "Echo" }, { value: "echo/echo-2", name: "Echo 2" }]);
	notes.send({ message_id: "m1", text: "x", set: { model: "echo/echo-2" } });
	await w.step(3);
	assert.deepEqual(w.oc.switched, ["echo/echo-2"]);
	assert.equal(w.oc.prompts.length, 1);
});

test("the proxied tool runs as the calling session (a subagent's as its root), and refuses a session no TUI shows", async () => {
	const w = await ocWorld();
	const notes = app(w.net, NOTES.origin);
	w.oc.infos.set("ses_child", { id: "ses_child", parentID: S });
	w.oc.infos.set("ses_run", { id: "ses_run" });
	await w.running.hello([S]);
	await w.step(2);
	const tool = w.oc.tools[0]!;
	const out = await tool.execute({ action: "add_note", text: "hi" }, { sessionID: "ses_child" });
	assert.equal(out.content, "notes did add_note");
	assert.equal((notes.toolCalls[0]?.meta as Record<string, unknown>)["dev.byoa/session"], notes.session().id);
	const refused = await tool.execute({ action: "add_note", text: "hi" }, { sessionID: "ses_run" });
	assert.match(refused.content, /works only in an OpenCode session open in a terminal/);
	assert.equal(notes.toolCalls.length, 1);
});

test("/byoa from the TUI answers through the connector and registers the session it was typed in", async () => {
	const w = await ocWorld();
	const text = await w.running.command("status", S);
	await w.step(2);
	assert.match(text, /Notes \(http:\/\/127\.0\.0\.1:4100\) · connected as Dana/);
	assert.equal(app(w.net, NOTES.origin).session().register.host_session_id, S);
});

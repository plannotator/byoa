// The Pi adapter against a fake Pi and fake apps: Pi's events in, the app's
// events out. Each case is a host rule from SPEC 5 or an earlier review.
import assert from "node:assert/strict";
import { test } from "node:test";
import { app } from "../../../packages/connector-core/test/fakes.ts";
import { NOTES, piWorld, TASKS } from "./fakes.ts";

test("a message runs as a follow-up custom message, and its turn streams back to done", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	notes.send({ message_id: "m1", text: "hello" });
	await w.step(3);
	assert.equal(w.pi.sent.length, 1);
	const sent = w.pi.sent[0]!;
	assert.equal(sent.customType, "byoa");
	assert.deepEqual(sent.options, { triggerTurn: true, deliverAs: "followUp" });
	assert.match(sent.content, /^\[BYOA\] Notes \(127\.0\.0\.1:4100\) · chat from Dana · m1\nhello$/);
	w.pi.startTurn(sent.content);
	w.pi.say("Hi ");
	w.pi.emit("tool_execution_start", { toolCallId: "t1", toolName: "read" });
	w.pi.emit("tool_execution_start", { toolCallId: "t2", toolName: "grep", parentToolCallId: "t1" } as never);
	w.pi.say("there");
	w.pi.endTurn();
	await w.step(3);
	assert.deepEqual(notes.eventsOf("m1"), ["started", "delta:Hi ", "tool:read", "delta:there", "done"]);
});

test("the session registers as pi with the Pi version, and the poll says busy while a run goes on", async () => {
	const w = await piWorld();
	const s = app(w.net, NOTES.origin).session();
	assert.equal(s.register.host, "pi");
	assert.equal(s.register.host_version, "1.0.2");
	assert.equal(s.register.host_session_id, "pi-session-1");
	assert.deepEqual(s.register.workspace, { folder_name: "northstar" });
	assert.equal(s.register.capabilities.interrupt, true);
	w.pi.startTurn("the person's own prompt", "user");
	await w.step();
	assert.equal(s.polls.at(-1)?.state, "busy");
	w.pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	await w.step();
	assert.equal(s.polls.at(-1)?.state, "busy", "agent_end is not the end: Pi may retry");
	w.pi.ctx.idle = true;
	w.pi.emit("agent_settled", {});
	await w.step();
	assert.equal(s.polls.at(-1)?.state, "ready");
});

test("a message waits while Pi is busy or has queued messages, then goes", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	w.pi.ctx.pending = true;
	notes.send({ message_id: "m1", text: "later" });
	await w.step(4);
	assert.equal(w.pi.sent.length, 0);
	assert.deepEqual(notes.eventsOf("m1"), ["queued"]);
	w.pi.ctx.pending = false;
	await w.step(3);
	assert.equal(w.pi.sent.length, 1);
});

test("a retry after agent_end keeps the turn ours until agent_settled", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	notes.send({ message_id: "m1", text: "flaky" });
	await w.step(3);
	w.pi.startTurn(w.pi.sent[0]!.content);
	w.pi.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
	w.pi.emit("agent_start", {});
	w.pi.say("second try");
	w.pi.endTurn();
	await w.step(3);
	assert.deepEqual(notes.eventsOf("m1"), ["started", "delta:second try", "done"]);
});

test("a run that ends in error ends the message error turn_failed", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	notes.send({ message_id: "m1", text: "x" });
	await w.step(3);
	w.pi.startTurn(w.pi.sent[0]!.content);
	w.pi.endTurn("error");
	await w.step();
	assert.deepEqual(notes.eventsOf("m1"), ["started", "error:turn_failed"]);
});

test("the person typing into our turn silences it at Enter and takes it over", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	notes.send({ message_id: "m1", text: "x" });
	await w.step(3);
	w.pi.startTurn(w.pi.sent[0]!.content);
	w.pi.say("ours ");
	w.pi.emit("input", { text: "PERSONAL", source: "interactive", streamingBehavior: "followUp" });
	w.pi.say("not sent");
	w.pi.emit("message_start", { message: { role: "user", content: "PERSONAL" } });
	w.pi.say("the person's own answer");
	w.pi.endTurn();
	await w.step(3);
	assert.deepEqual(notes.eventsOf("m1"), ["started", "delta:ours ", "interrupted:taken_over"]);
});

test("another extension's message in the context sent to the model takes our turn over", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	notes.send({ message_id: "m1", text: "x" });
	await w.step(3);
	const ours = w.pi.sent[0]!.content;
	w.pi.startTurn(ours);
	w.pi.say("ours");
	w.pi.emit("context", { messages: [{ role: "custom", customType: "byoa", content: ours }, { role: "assistant" }, { role: "custom", customType: "other", content: "a notice" }] });
	w.pi.say("after the notice");
	w.pi.endTurn();
	await w.step(3);
	assert.deepEqual(notes.eventsOf("m1"), ["started", "delta:ours", "interrupted:taken_over"]);
});

test("interrupt aborts only our running turn, and it ends interrupted stopped", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	w.pi.startTurn("the person's own prompt", "user");
	notes.send({ message_id: "m0", text: "x", interrupt_first: true });
	await w.step();
	assert.equal(w.pi.ctx.aborts, 0, "the person's turn is never aborted");
	w.pi.endTurn();
	await w.step(3);
	w.pi.startTurn(w.pi.sent[0]!.content);
	notes.interrupt("m0");
	await w.step();
	assert.equal(w.pi.ctx.aborts, 1);
	w.pi.endTurn("aborted");
	await w.step();
	assert.deepEqual(notes.eventsOf("m0"), ["queued", "started", "interrupted:stopped"]);
});

test("two apps' messages run one after the other, in arrival order", async () => {
	const w = await piWorld([NOTES, TASKS]);
	const notes = app(w.net, NOTES.origin);
	const tasks = app(w.net, TASKS.origin);
	tasks.send({ message_id: "t1", text: "first" });
	await w.step();
	notes.send({ message_id: "n1", text: "second" });
	await w.step(3);
	assert.equal(w.pi.sent.length, 1);
	assert.match(w.pi.sent[0]!.content, /Tasks/);
	w.pi.startTurn(w.pi.sent[0]!.content);
	w.pi.endTurn();
	await w.step(3);
	assert.equal(w.pi.sent.length, 2);
	assert.match(w.pi.sent[1]!.content, /Notes/);
	w.pi.startTurn(w.pi.sent[1]!.content);
	w.pi.endTurn();
	await w.step();
	assert.deepEqual(tasks.eventsOf("t1"), ["started", "done"]);
	assert.deepEqual(notes.eventsOf("n1"), ["queued", "started", "done"]);
});

test("a blocking extension prompt reports blocked", async () => {
	const w = await piWorld();
	const s = app(w.net, NOTES.origin).session();
	w.pi.emit("ui_prompt_start", {});
	await w.step();
	assert.equal(s.polls.at(-1)?.state, "blocked");
	w.pi.emit("ui_prompt_end", {});
	await w.step();
	assert.equal(s.polls.at(-1)?.state, "ready");
});

test("settings: the model and thinking level are declared and applied before the turn", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	const s = notes.session();
	const settings = s.register.capabilities.settings;
	assert.deepEqual(settings.map((x) => [x.id, x.value]), [["model", "echo/echo-1"], ["effort", "medium"]]);
	assert.deepEqual(settings[0]?.choices, [{ value: "echo/echo-1", name: "echo-1" }, { value: "echo/echo-2", name: "echo-2" }]);
	notes.send({ message_id: "m1", text: "x", set: { model: "echo/echo-2", effort: "high" } });
	await w.step(3);
	assert.deepEqual(w.pi.setModels, ["echo/echo-2"]);
	assert.equal(w.pi.thinking, "high");
	assert.equal(w.pi.sent.length, 1);
});

test("the proxied tool is registered once, and its call carries the session in _meta", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	assert.deepEqual(w.pi.tools.map((t) => t.name), ["notes"]);
	const tool = w.pi.tools[0]!;
	const result = await tool.execute("c1", { action: "add_note", text: "hi" }, undefined, undefined, w.pi.ctx);
	assert.deepEqual(result.content, [{ type: "text", text: "notes did add_note" }]);
	const call = notes.toolCalls[0]!;
	assert.deepEqual(call.arguments, { text: "hi" });
	assert.equal((call.meta as Record<string, unknown>)["dev.byoa/session"], notes.session().id);
	await assert.rejects(tool.execute("c2", { action: "nope" }, undefined, undefined, w.pi.ctx), /action must be one of/);
});

test("a print, JSON or RPC run starts nothing: no request, no tool, and /byoa says why", async () => {
	for (const mode of ["print", "json", "rpc"] as const) {
		const w = await piWorld([NOTES], { mode });
		const before = w.net.sent.length;
		await w.step(3);
		assert.equal(w.net.sent.length, before, `${mode}: nothing polls`);
		assert.equal(w.pi.tools.length, 0);
		assert.match((await w.pi.command("status")) ?? "", /interactive Pi session only/);
	}
});

test("/byoa status answers through the connector; session_shutdown ends held messages", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	assert.match((await w.pi.command("status")) ?? "", /Notes \(http:\/\/127\.0\.0\.1:4100\) · connected as Dana · this session: registered/);
	w.pi.ctx.idle = false;
	notes.send({ message_id: "m1", text: "x" });
	await w.step();
	w.pi.emit("session_shutdown", { reason: "quit" });
	w.pi.ctx.stale = true;
	await w.step(2);
	assert.deepEqual(notes.eventsOf("m1"), ["queued", "withdrawn:session_ended"]);
});

test("a replaced runtime's stale context never throws into Pi, and nothing is submitted to it", async () => {
	const w = await piWorld();
	const notes = app(w.net, NOTES.origin);
	w.pi.ctx.stale = true;
	notes.send({ message_id: "m1", text: "x" });
	await w.step(4);
	assert.doesNotThrow(() => w.pi.emit("agent_start", {}));
	assert.equal(w.pi.sent.length, 0);
});

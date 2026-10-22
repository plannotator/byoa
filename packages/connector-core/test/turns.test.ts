// The turn scheduler end to end: a fake app hands out commands on its poll,
// the fake host is scripted busy or idle, and the test plays the host's turn
// events into the session handle. What the app hears is read from the app.
import assert from "node:assert/strict";
import { test } from "node:test";

import { START_TIMEOUT_MS } from "../src/turns.ts";
import { app, world, type World } from "./fakes.ts";

const WS = { id: "workspaces", name: "Workspaces", origin: "https://workspaces.example" };
const MACHINE = { id: "machine", name: "Machine", origin: "http://127.0.0.1:4100" };
const LINE = (id: string, kind = "chat") => `[BYOA] Workspaces (workspaces.example) · ${kind} from Dana · ${id}`;

async function live(apps = [WS]): Promise<World> {
	const w = await world(apps);
	await w.tick(1);
	return w;
}

// Catches: text submitted without the connector's line, a turn started before
// the host was idle for two ticks, and events out of order or misnumbered.
test("a message starts after two idle ticks, with the provenance line; the app hears started, tool, deltas, done with seq 0..n", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	a.send({ message_id: "msg_1", text: "What changed in the plan?" });
	await w.tick(1);
	// The poll answer lands after this tick's check; the next tick starts it.
	assert.equal(w.session.submitted.length, 0);
	await w.tick(1);
	assert.deepEqual(w.session.submitted, [`${LINE("msg_1")}\nWhat changed in the plan?`]);
	// Claude Code wraps a plugin prompt in its own frame: still ours.
	assert.equal(w.handle.turnStarted(`<plugin-prompt>${w.session.submitted[0]}</plugin-prompt>`), true);
	w.session.isBusy = true;
	w.handle.tool("Read", "Read");
	w.handle.delta("It ");
	w.handle.delta("changed.");
	w.handle.turnEnded("done");
	w.session.isBusy = false;
	await w.tick(2);
	assert.deepEqual(a.eventsOf("msg_1"), ["started", "tool:Read", "delta:It ", "delta:changed.", "done"]);
	assert.deepEqual(a.session().events.map((e) => e.seq), [0, 1, 2, 3, 4]);
});

// Catches: a message submitted into a busy host (it could not be taken back).
test("busy host: the message is held with queued, starts only after the host is idle for two ticks", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	w.session.isBusy = true; // the person's own turn
	a.send({ message_id: "msg_1" });
	await w.tick(5);
	assert.equal(w.session.submitted.length, 0);
	assert.deepEqual(a.eventsOf("msg_1"), ["queued"]);
	w.session.isBusy = false;
	await w.tick(1);
	assert.equal(w.session.submitted.length, 0, "one idle tick: the person may still type");
	await w.tick(1);
	assert.equal(w.session.submitted.length, 1);
	assert.deepEqual(a.eventsOf("msg_1"), ["queued", "started"]);
});

// Catches: a prompt the person typed while a message waited being overtaken.
test("a prompt the person types restarts the idle count", async () => {
	const w = await live();
	w.session.isBusy = true;
	app(w.net, WS.origin).send({ message_id: "msg_1" });
	await w.tick(1);
	w.session.isBusy = false;
	await w.tick(1);
	w.handle.foreignPrompt("fix the tests");
	await w.tick(1);
	assert.equal(w.session.submitted.length, 0);
	await w.tick(2);
	assert.equal(w.session.submitted.length, 1);
});

// Catches: Stop failing to withdraw a held message, and a lost poll answer
// leaving the app's stream open.
test("interrupt: a held message is withdrawn and never submitted; an unknown id answers withdrawn", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	w.session.isBusy = true;
	a.send({ message_id: "msg_1" });
	await w.tick(1);
	a.interrupt("msg_1");
	a.interrupt("never_seen");
	w.session.isBusy = false;
	await w.tick(4);
	assert.equal(w.session.submitted.length, 0);
	assert.deepEqual(a.eventsOf("msg_1"), ["queued", "withdrawn"]);
	assert.deepEqual(a.eventsOf("never_seen"), ["withdrawn"]);
	assert.equal(w.session.aborts, 0);
});

// Catches: Stop not aborting our running turn, or the wrong reason.
test("interrupt of our own running turn aborts it and ends interrupted, stopped", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	a.send({ message_id: "msg_1" });
	await w.tick(2);
	w.handle.turnStarted(w.session.submitted[0] as string);
	w.session.isBusy = true;
	a.interrupt("msg_1");
	await w.tick(1);
	assert.equal(w.session.aborts, 1);
	w.handle.turnEnded("interrupted");
	w.session.isBusy = false;
	await w.tick(1);
	assert.deepEqual(a.eventsOf("msg_1"), ["started", "interrupted:stopped"]);
});

// Catches: interrupt_first aborting the person's turn or another app's turn.
test("never aborts a turn it did not start: the person's turn, or another app's", async () => {
	const w = await live([WS, MACHINE]);
	const ws = app(w.net, WS.origin);
	const machine = app(w.net, MACHINE.origin);
	w.session.isBusy = true; // the person's turn
	ws.send({ message_id: "msg_p", interrupt_first: true });
	await w.tick(2);
	assert.equal(w.session.aborts, 0);
	w.session.isBusy = false;
	await w.tick(2);
	w.handle.turnStarted(w.session.submitted[0] as string);
	w.session.isBusy = true;
	// Machine asks to interrupt first, and tries to stop Workspaces' message.
	machine.send({ message_id: "msg_m", interrupt_first: true });
	machine.interrupt("msg_p");
	await w.tick(2);
	assert.equal(w.session.aborts, 0, "another app's turn is never aborted");
	assert.deepEqual(machine.eventsOf("msg_m"), ["queued"]);
	assert.deepEqual(machine.eventsOf("msg_p"), ["withdrawn"], "Machine never had msg_p: unknown to it");
	// The same app's interrupt_first does stop its own running turn.
	ws.send({ message_id: "msg_p2", interrupt_first: true });
	await w.tick(1);
	assert.equal(w.session.aborts, 1);
});

// Catches: the answer to what the person typed into an app turn streaming to the app.
test("take-over: after a prompt we did not submit, nothing more streams and the message ends interrupted, taken_over", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	a.send({ message_id: "msg_1" });
	await w.tick(2);
	const ours = w.session.submitted[0] as string;
	w.handle.turnStarted(ours);
	w.session.isBusy = true;
	w.handle.delta("before ");
	assert.equal(w.handle.foreignPrompt(ours), false, "our own prompt is not foreign");
	assert.equal(w.handle.foreignPrompt("actually, do this instead"), true);
	w.handle.delta("the answer to the person");
	w.handle.tool("Bash");
	w.handle.takenOver();
	w.handle.delta("more");
	w.handle.turnEnded("done");
	w.session.isBusy = false;
	await w.tick(2);
	assert.deepEqual(a.eventsOf("msg_1"), ["started", "delta:before ", "interrupted:taken_over"]);
});

// Catches: deltas of a turn that is not ours leaving the machine.
test("events of a turn that is not ours are dropped", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	assert.equal(w.handle.turnStarted("the person's own prompt"), false);
	w.handle.delta("private");
	w.handle.tool("Bash");
	w.handle.turnEnded("done");
	await w.tick(2);
	assert.equal(a.session().events.length, 0);
});

// Catches: a command redelivered after a lost poll answer starting twice.
test("a duplicate command is acted on once", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	a.send({ message_id: "msg_1" });
	await w.tick(1);
	a.send({ message_id: "msg_1" });
	await w.tick(2);
	w.handle.turnStarted(w.session.submitted[0] as string);
	w.handle.turnEnded("done");
	a.send({ message_id: "msg_1" });
	await w.tick(4);
	assert.equal(w.session.submitted.length, 1);
	assert.deepEqual(a.eventsOf("msg_1"), ["started", "done"]);
});

// Catches: two apps' turns overlapping, or a later app overtaking an earlier one.
test("two apps at once: one turn at a time, in arrival order across apps", async () => {
	const w = await live([WS, MACHINE]);
	const ws = app(w.net, WS.origin);
	const machine = app(w.net, MACHINE.origin);
	w.session.isBusy = true;
	machine.send({ message_id: "m_1", text: "draw it" });
	await w.tick(1);
	ws.send({ message_id: "w_1", text: "plan it" });
	await w.tick(1);
	w.session.isBusy = false;
	await w.tick(4);
	assert.equal(w.session.submitted.length, 1);
	assert.match(w.session.submitted[0] as string, /^\[BYOA\] Machine \(127\.0\.0\.1:4100\) · chat from Dana · m_1\ndraw it$/);
	w.handle.turnStarted(w.session.submitted[0] as string);
	w.handle.delta("drawn");
	w.handle.turnEnded("done");
	await w.tick(1);
	assert.equal(w.session.submitted.length, 1, "the next waits for two idle ticks");
	await w.tick(1);
	assert.equal(w.session.submitted.length, 2);
	assert.equal(w.session.submitted[1], `${LINE("w_1")}\nplan it`);
	assert.deepEqual(machine.eventsOf("m_1"), ["queued", "started", "delta:drawn", "done"]);
	assert.deepEqual(ws.eventsOf("w_1"), ["queued", "started"]);
});

// Catches: the next message submitted the very tick after a short turn of
// ours that started and ended between two ticks (seen live on Claude Code:
// the idle count from before that turn was never reset).
test("after a turn of ours that ends between two ticks, the next message still waits two idle ticks", async () => {
	const w = await live([WS, MACHINE]);
	const ws = app(w.net, WS.origin);
	const machine = app(w.net, MACHINE.origin);
	machine.send({ message_id: "m_1", text: "draw it" });
	ws.send({ message_id: "w_1", text: "plan it" });
	while (w.session.submitted.length === 0) await w.tick(1);
	w.handle.turnStarted(w.session.submitted[0] as string);
	w.handle.turnEnded("done");
	await w.tick(1);
	assert.equal(w.session.submitted.length, 1, "one idle tick after the turn: the person may still type");
	await w.tick(1);
	assert.equal(w.session.submitted.length, 2);
});

// Catches: a model switch landing after the turn, or an undeclared setting applied.
test("set is applied through the host before the turn; an undeclared setting or choice is refused", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	a.send({ message_id: "msg_1", set: { model: "opus" } });
	await w.tick(2);
	assert.deepEqual(w.session.order, ["set:model=opus", `submit:${LINE("msg_1")}`]);
	w.handle.turnStarted(w.session.submitted[0] as string);
	w.handle.turnEnded("done");
	a.send({ message_id: "msg_2", set: { model: "gpt" } });
	a.send({ message_id: "msg_3", set: { temperature: "2" } });
	await w.tick(4);
	assert.deepEqual(a.eventsOf("msg_2"), ["error:setting_not_declared"]);
	assert.deepEqual(a.eventsOf("msg_3"), ["error:setting_not_declared"]);
	assert.equal(w.session.submitted.length, 1);
});

// Catches: an app text running a slash command on Claude Code.
test("a text starting with / is refused, never submitted", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	a.send({ message_id: "msg_1", text: "  /plugin install something" });
	await w.tick(4);
	assert.equal(w.session.submitted.length, 0);
	assert.deepEqual(a.eventsOf("msg_1"), ["error:refused_slash_command"]);
});

// Catches: a refused or never-started submission blocking every later message.
test("a refused submit ends error; one the host never starts ends error after the timeout, and the next runs", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	w.session.failSubmit = true;
	a.send({ message_id: "msg_1" });
	await w.tick(3);
	assert.deepEqual(a.eventsOf("msg_1"), ["started", "error:submit_failed"]);
	w.session.failSubmit = false;
	a.send({ message_id: "msg_2" });
	a.send({ message_id: "msg_3" });
	await w.tick(2);
	w.advance(START_TIMEOUT_MS);
	await w.tick(3);
	assert.deepEqual(a.eventsOf("msg_2"), ["started", "error:not_started"]);
	assert.deepEqual(a.eventsOf("msg_3"), ["queued", "started"]);
});

// Catches: stream: false still sending the answer text.
test("stream false: lifecycle and tool events only", async () => {
	const w = await live();
	const a = app(w.net, WS.origin);
	a.send({ message_id: "msg_1", stream: false });
	await w.tick(2);
	w.handle.turnStarted(w.session.submitted[0] as string);
	w.handle.tool("Edit");
	w.handle.delta("secret answer");
	w.handle.turnEnded("done");
	await w.tick(1);
	assert.deepEqual(a.eventsOf("msg_1"), ["started", "tool:Edit", "done"]);
});

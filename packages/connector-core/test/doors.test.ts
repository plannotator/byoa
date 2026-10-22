// The session doors against fake apps: registration and what it shares,
// presence through the poll body, recovery (404, seq_gap), revocation, a
// hold of 0, a session id change, and two processes on one session.
import assert from "node:assert/strict";
import { test } from "node:test";

import { policyPath } from "../src/sharing.ts";
import { app, FakeNet, HOME, MemoryFiles, world } from "./fakes.ts";

const WS = { id: "workspaces", name: "Workspaces", origin: "https://workspaces.example" };
const NOTES = { id: "appnotes", name: "AppNotes", origin: "https://appnotes.example", pollHold: 0, pollInterval: 5, requires: ["git_remote"] };

// Catches: the path leaking by default, and a sharing file other users can
// widen being trusted.
test("registers with each app, sharing folder name and git remote by default, never the path; policy.json narrows or widens per app", async () => {
	const files = new MemoryFiles();
	files.put(policyPath(HOME), JSON.stringify({ share: { appnotes: ["git_remote", "path"] } }));
	const w = await world([WS, NOTES], { files });
	await w.tick(1);
	const ws = app(w.net, WS.origin).session().register;
	assert.deepEqual(ws.workspace, { folder_name: "northstar", git_remote: "github.com/acme/northstar" });
	assert.equal(ws.host, "claude-code");
	assert.equal(ws.host_session_id, "host-session-1");
	assert.deepEqual(ws.capabilities, { interrupt: true, stream: true, settings: w.session.settingsList });
	assert.deepEqual(app(w.net, NOTES.origin).session().register.workspace, { path: "/home/dana/code/northstar", git_remote: "github.com/acme/northstar" });
});

// Catches: an app that needs a withheld field being registered silently.
test("an app that requires a field the person withholds is not registered, and status says why", async () => {
	const files = new MemoryFiles();
	files.put(policyPath(HOME), JSON.stringify({ share: { "*": ["folder_name"] } }));
	const w = await world([WS, NOTES], { files });
	await w.tick(2);
	assert.equal(app(w.net, NOTES.origin).sessions.size, 0);
	assert.equal(app(w.net, WS.origin).sessions.size, 1);
	assert.match(await w.connector.status(), /AppNotes \(https:\/\/appnotes\.example\).*not registered \(AppNotes needs git_remote, which ~\/\.byoa\/policy\.json does not share/);
	files.chmod(policyPath(HOME), 0o666);
	assert.match(await w.connector.status(), /can be changed by other users.*nothing is shared/);
});

// Catches: presence only reaching the app at the next poll (up to 20 s late).
test("a state or setting change sends a new poll at once; the app answers the held one empty", async () => {
	const w = await world([WS]);
	await w.tick(1);
	const s = app(w.net, WS.origin).session();
	assert.deepEqual(s.polls, [{ state: "ready", idle_since: "2026-10-21T14:00:00.000Z" }]);
	w.session.isBusy = true;
	await w.tick(1);
	assert.deepEqual(s.polls.at(-1), { state: "busy" });
	w.session.isBusy = false;
	w.session.isBlocked = true;
	await w.tick(1);
	assert.deepEqual(s.polls.at(-1), { state: "blocked", cause: "permission" });
	w.session.isBlocked = false;
	w.session.settingsList = [{ id: "model", name: "Model", value: "sonnet", choices: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] }];
	await w.tick(1);
	assert.deepEqual(s.polls.at(-1), { state: "ready", idle_since: "2026-10-21T14:00:04.000Z", settings: w.session.settingsList });
	const count = s.polls.length;
	await w.tick(5);
	assert.equal(s.polls.length, count, "nothing changed: the held poll stays held");
	assert.equal(app(w.net, WS.origin).sessions.size, 1);
});

// Catches: an app that holds 0 (Workers plus D1) being polled in a hot loop.
test("a hold of 0: polls every poll_interval_seconds, and still at once on a state change", async () => {
	const w = await world([{ ...NOTES, requires: [] }]);
	const a = app(w.net, NOTES.origin);
	const first = a.session().polls.length; // at t0
	await w.tick(4);
	assert.equal(a.session().polls.length, first, "nothing before 5 s");
	await w.tick(1);
	assert.equal(a.session().polls.length, first + 1);
	a.send({ message_id: "n_1", text: "route it" });
	await w.tick(5);
	await w.tick(2);
	assert.equal(w.session.submitted.length, 1);
	// Our turn in flight reads busy: that poll went out at once, not at 5 s.
	assert.equal(a.session().polls.at(-1)?.state, "busy");
	w.handle.turnStarted(w.session.submitted[0] as string);
	w.handle.turnEnded("done");
	const before = a.session().polls.length;
	await w.tick(1);
	assert.equal(a.session().polls.length, before + 1);
	assert.equal(a.session().polls.at(-1)?.state, "ready");
});

// Catches: an app restart losing the session instead of registering again.
test("404 on a poll: registers the same host session again and goes on", async () => {
	const w = await world([WS]);
	await w.tick(1);
	const a = app(w.net, WS.origin);
	const id = a.session().id;
	a.restart();
	await w.tick(3);
	assert.equal(a.session().id, id, "the same session id back");
	a.send({ message_id: "msg_1" });
	await w.tick(3);
	assert.equal(w.session.submitted.length, 1);
});

// Catches: a revoked app polled forever, or one app's revocation stopping another.
test("401: that app stops everywhere and status says it was disconnected; another app goes on", async () => {
	const w = await world([WS, { ...NOTES, requires: [] }]);
	await w.tick(1);
	const ws = app(w.net, WS.origin);
	ws.revokeAll();
	await w.tick(2);
	assert.match(await w.connector.status(), /Workspaces disconnected this agent \(its token was revoked\)\. \/byoa connect https:\/\/workspaces\.example/);
	assert.ok(w.host.toasts.some((t) => /Workspaces disconnected this agent/.test(t)));
	const before = w.net.to(WS.origin).length;
	await w.tick(5);
	assert.equal(w.net.to(WS.origin).length, before, "no more requests to the revoked app");
	app(w.net, NOTES.origin).send({ message_id: "n_1" });
	await w.tick(8);
	assert.equal(w.session.submitted.length, 1, "the other app still reaches the session");
});

// Catches: events lost for good when the app's window says resend.
test("422 seq_gap: resends that message from expected, so the app ends with every event in order", async () => {
	const w = await world([WS]);
	await w.tick(1);
	const a = app(w.net, WS.origin);
	a.send({ message_id: "msg_1" });
	await w.tick(2);
	w.handle.turnStarted(w.session.submitted[0] as string);
	w.handle.delta("one ");
	await w.tick(1);
	assert.deepEqual(a.eventsOf("msg_1"), ["started", "delta:one "]);
	a.forgetFrom("msg_1", 1);
	w.handle.delta("two");
	w.handle.turnEnded("done");
	await w.tick(3);
	assert.deepEqual(a.eventsOf("msg_1"), ["started", "delta:one ", "delta:two", "done"]);
	assert.ok(w.net.to(WS.origin, "/events").length >= 3, "a refused batch and its resend");
});

// Catches: a message held for a cleared session reaching the new conversation.
test("/clear changes the host session id: messages end, the old session stops polling, every app gets a new registration", async () => {
	const w = await world([WS]);
	await w.tick(1);
	const a = app(w.net, WS.origin);
	a.send({ message_id: "msg_1" });
	await w.tick(2);
	w.handle.turnStarted(w.session.submitted[0] as string);
	w.session.isBusy = true;
	a.send({ message_id: "msg_2" });
	await w.tick(1);
	w.session.id = "host-session-2";
	w.session.isBusy = false;
	await w.tick(2);
	const old = a.session("host-session-1");
	assert.deepEqual(a.eventsOf("msg_1", "host-session-1"), ["started", "interrupted:session_ended"]);
	assert.deepEqual(a.eventsOf("msg_2", "host-session-1"), ["queued", "withdrawn:session_ended"]);
	const oldPolls = old.polls.length;
	assert.equal(a.session("host-session-2").register.host_session_id, "host-session-2");
	await w.tick(5);
	assert.equal(old.polls.length, oldPolls, "the old session is not polled any more");
	assert.equal(w.session.submitted.length, 1, "nothing of the old session was submitted after");
});

// Catches: two processes on one session (claude --continue twice) spinning
// against the app, and a message delivered twice.
test("two processes, one session: the newest poll wins, the other backs off and says so; each message runs once", async () => {
	const net = new FakeNet();
	const files = new MemoryFiles();
	const clock = { t: Date.parse("2026-10-21T14:00:00Z") };
	const one = await world([WS], { net, files, clock });
	const two = await world([WS], { net, files, clock });
	const a = app(net, WS.origin);
	for (let i = 0; i < 60; i++) {
		await one.tick(1);
		await two.connector.tick();
	}
	assert.equal(a.sessions.size, 1, "both hold the same session id");
	const polls = a.session().polls.length;
	assert.ok(polls < 40, `polls in 60 s: ${polls}`);
	const status = `${await one.connector.status()}\n${await two.connector.status()}`;
	assert.match(status, /open in another terminal too/);
	a.send({ message_id: "msg_1" });
	for (let i = 0; i < 40; i++) {
		await one.tick(1);
		await two.connector.tick();
	}
	assert.equal(one.session.submitted.length + two.session.submitted.length, 1);
});

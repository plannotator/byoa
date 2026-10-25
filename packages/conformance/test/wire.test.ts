// Conformance: the real @plannotator/byoa-server and the real @plannotator/byoa-connector-core,
// talking over the wire with nothing faked between them. Only the host is a
// fake (scripted busy/idle and turn events), and requests go to the server's
// fetch handler in-process instead of a socket. The fake host, the files, the
// HttpPort over fetch and the page pairing are the published test kit,
// @plannotator/byoa-connector-core/testing. Each test is a SPEC rule seen
// from both ends at once: what the person's UI sees and what the agent gets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createByoa, type Byoa, type UiEvent } from "../../server/src/index.ts";
import { Connector, type HttpPort } from "@plannotator/byoa-connector-core";
import { FakeHost, FakeSessionHost, fetchHttp, HOME, MemoryFiles, pairByPage, type FetchLike } from "@plannotator/byoa-connector-core/testing";
import { META } from "../../protocol/src/index.ts";

const PERSON = { userId: "u_ramos", displayName: "Ramos" };

/** One time for both ends: the connector's scripted seconds. The server's
 * held polls still release on real timers, so the wire really waits. */
const CLOCK = { t: Date.parse("2026-10-21T14:00:00Z") };
const SERVER_CLOCK = { now: () => CLOCK.t, setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) };
const COOKIE = "demo_session=signed-in";

interface App {
	origin: string;
	byoa: Byoa;
	events: UiEvent[];
	toolCalls: { name: string; session: string | undefined; connection: string }[];
}

function makeApp(id: string, port: number, opts: { hold?: number; autoApprove?: boolean } = {}): App {
	const origin = `http://localhost:${port}`;
	const toolCalls: App["toolCalls"] = [];
	const byoa = createByoa({
		app: { id, name: id[0]!.toUpperCase() + id.slice(1), origin },
		authenticate: async (req) => ((req.headers.get("cookie") ?? "").includes(COOKIE) ? PERSON : null),
		mcpPath: "/mcp",
		pollHoldSeconds: opts.hold ?? 1,
		clock: SERVER_CLOCK,
		...(opts.autoApprove ? { autoApprove: () => PERSON } : {}),
	});
	const app: App = { origin, byoa, events: [], toolCalls };
	byoa.subscribe(PERSON.userId, (e) => app.events.push(e));
	return app;
}

/** The app's own MCP server, as an app would write it: accept the BYOA token. */
async function mcp(app: App, req: Request): Promise<Response> {
	const body = (await req.json()) as { id: number; method: string; params?: { name?: string; _meta?: Record<string, string> } };
	const sessionId = body.params?._meta?.[META.session];
	const who = await app.byoa.verifyBearer(req, sessionId ? { sessionId } : {});
	if (!who) return Response.json({ error: "unauthorized" }, { status: 401 });
	const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result });
	if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "0" } });
	if (body.method === "tools/list")
		return reply({ tools: [{ name: "add_note", description: "Save a note.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] });
	app.toolCalls.push({ name: body.params?.name ?? "", session: who.sessionId, connection: who.connectionId });
	return reply({ content: [{ type: "text", text: "saved" }] });
}

/** The apps as one fetch function: each origin's BYOA handler and MCP server. */
function fetcher(apps: App[]): FetchLike {
	return async (url, init) => {
		const app = apps.find((a) => url.startsWith(a.origin));
		if (!app) throw new Error(`no route to ${url}`);
		const req = new Request(url, init);
		return new URL(url).pathname === "/mcp" ? await mcp(app, req) : ((await app.byoa.handle(req)) ?? new Response("nf", { status: 404 }));
	};
}

/** The connector's HttpPort, routed to the apps' fetch handlers. */
function network(apps: App[]): HttpPort {
	return fetchHttp(fetcher(apps));
}

/** The person's browser on the app. */
async function ui(app: App, method: string, path: string, body?: unknown): Promise<Response> {
	const headers: Record<string, string> = { cookie: COOKIE, origin: app.origin };
	if (body !== undefined) headers["content-type"] = "application/json";
	const res = await app.byoa.handle(new Request(app.origin + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
	assert.ok(res, `no UI route ${path}`);
	return res;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(apps: App[]) {
	const clock = CLOCK;
	const files = new MemoryFiles();
	const host = new FakeHost();
	const http = network(apps);
	const connector = new Connector({ host, http, files, now: () => clock.t, home: HOME, random: () => 0.5 });
	await connector.start();
	const session = new FakeSessionHost();
	const step = async () => {
		clock.t += 1000;
		await connector.tick();
		await sleep(15);
	};
	const until = async (what: string, cond: () => boolean, max = 60) => {
		for (let i = 0; i < max && !cond(); i++) await step();
		assert.ok(cond(), `timed out waiting for: ${what}`);
	};
	return { clock, files, host, connector, session, step, until };
}

function sessionsOf(app: App) {
	const last = [...app.events].reverse().find((e) => e.type === "sessions");
	return last?.type === "sessions" ? last.connections.flatMap((c) => c.sessions) : [];
}

function eventsFor(app: App, messageId: string): string[] {
	return app.events.flatMap((e) => (e.type === "event" && e.message_id === messageId ? [e.event.type] : e.type === "gone" && e.message_id === messageId ? [`gone:${e.reason}`] : []));
}

test("pair through the approval page, register, chat: the UI sees the turn stream in order", async () => {
	const notes = makeApp("notes", 4100);
	const w = await setup([notes]);
	const page = await (await ui(notes, "GET", "/byoa/connect")).text();
	assert.doesNotMatch(page, /csrf/, "no code, no consent form");
	const status = await pairByPage({ connector: w.connector, origin: notes.origin, request: fetcher([notes]), headers: { cookie: COOKIE }, step: w.step });
	assert.match(status, /as Ramos/);
	const handle = w.session.attachTo(w.connector);
	await w.until("session listed in the UI", () => sessionsOf(notes).some((s) => s.state === "ready"));
	const sessionId = sessionsOf(notes)[0]!.id;
	assert.deepEqual(sessionsOf(notes)[0]!.workspace, { folder_name: "northstar", git_remote: "github.com/acme/northstar" }, "path and branch are not shared by default");

	const sent = (await (await ui(notes, "POST", `/byoa/ui/sessions/${sessionId}/messages`, { text: "add a note that says hi" })).json()) as { message_id: string };
	await w.until("the host got the turn", () => w.session.submitted.length === 1);
	const submitted = w.session.submitted[0]!;
	assert.match(submitted, new RegExp(`^\\[BYOA\\] Notes \\(localhost:4100\\) · chat from Ramos · ${sent.message_id}\\nadd a note that says hi$`));

	assert.equal(w.session.startTurn(`The byoa plugin sent a message:\n${submitted}`), true, "our turn is matched by contains");
	assert.equal(handle, w.session.handle);
	w.session.text("Adding ");
	w.session.tool("add_note", "Add note");
	w.session.text("done.");
	w.session.end("done");
	await w.until("done reaches the UI", () => eventsFor(notes, sent.message_id).includes("done"));
	assert.deepEqual(eventsFor(notes, sent.message_id), ["started", "delta", "tool", "delta", "done"]);
	const text = notes.events.flatMap((e) => (e.type === "event" && e.event.type === "delta" ? [e.event.text] : [])).join("");
	assert.equal(text, "Adding done.");
});

test("one connector, two apps: messages from both run one at a time, in order; tools carry the session", async () => {
	const notes = makeApp("notes", 4100, { autoApprove: true });
	const tasks = makeApp("tasks", 4200, { autoApprove: true });
	const w = await setup([notes, tasks]);
	assert.match(await w.connector.connect(notes.origin), /connected to Notes/);
	assert.match(await w.connector.connect(tasks.origin), /connected to Tasks/);
	const handle = w.connector.attach(w.session);
	await w.until("listed in both apps", () => sessionsOf(notes).length === 1 && sessionsOf(tasks).length === 1);

	const tools = await handle.tools();
	assert.deepEqual(tools.map((t) => t.name).sort(), ["notes", "tasks"]);
	const a = (await (await ui(notes, "POST", `/byoa/ui/sessions/${sessionsOf(notes)[0]!.id}/messages`, { text: "first" })).json()) as { message_id: string };
	const b = (await (await ui(tasks, "POST", `/byoa/ui/sessions/${sessionsOf(tasks)[0]!.id}/messages`, { text: "second" })).json()) as { message_id: string };
	await w.until("first turn submitted", () => w.session.submitted.length >= 1);
	for (let i = 0; i < 4; i++) await w.step();
	assert.equal(w.session.submitted.length, 1, "the second app waits for the first turn");
	handle.turnStarted(w.session.submitted[0]!);
	w.session.isBusy = true;
	const notesTool = tools.find((t) => t.name === "notes")!;
	const result = await notesTool.call({ action: "add_note", text: "hi" });
	assert.equal(result.isError, false);
	assert.equal(notes.toolCalls[0]!.session, sessionsOf(notes)[0]!.id, "the app ties the call to the session");
	assert.equal(tasks.toolCalls.length, 0);
	await w.until("tasks shows the session busy", () => sessionsOf(tasks)[0]!.state === "busy", 10);
	handle.turnEnded("done");
	w.session.isBusy = false;
	await w.until("second turn submitted", () => w.session.submitted.length === 2);
	assert.match(w.session.submitted[1]!, /^\[BYOA\] Tasks \(localhost:4200\) · chat from Ramos/);
	handle.turnStarted(w.session.submitted[1]!);
	handle.turnEnded("done");
	await w.until("both done", () => eventsFor(notes, a.message_id).includes("done") && eventsFor(tasks, b.message_id).includes("done"));
	assert.ok(eventsFor(tasks, b.message_id).includes("queued"), "the second message reported queued while the first ran");
});

test("stop from the UI: a running turn of ours is aborted and ends interrupted; the person's turn is never aborted", async () => {
	const notes = makeApp("notes", 4100, { autoApprove: true });
	const w = await setup([notes]);
	await w.connector.connect(notes.origin);
	const handle = w.connector.attach(w.session);
	await w.until("listed", () => sessionsOf(notes).length === 1);
	const sid = sessionsOf(notes)[0]!.id;

	// The person's own turn is running: our message waits, and Stop withdraws it without touching the host.
	w.session.isBusy = true;
	const held = (await (await ui(notes, "POST", `/byoa/ui/sessions/${sid}/messages`, { text: "wait" })).json()) as { message_id: string };
	await w.until("queued", () => eventsFor(notes, held.message_id).includes("queued"));
	const out1 = (await (await ui(notes, "POST", `/byoa/ui/sessions/${sid}/messages/${held.message_id}/interrupt`)).json()) as { outcome: string };
	assert.equal(out1.outcome, "interrupt_sent");
	await w.until("withdrawn", () => eventsFor(notes, held.message_id).includes("withdrawn"));
	assert.equal(w.session.aborts, 0);
	assert.equal(w.session.submitted.length, 0);

	// Our own running turn: Stop aborts it.
	w.session.isBusy = false;
	const run = (await (await ui(notes, "POST", `/byoa/ui/sessions/${sid}/messages`, { text: "go" })).json()) as { message_id: string };
	await w.until("submitted", () => w.session.submitted.length === 1);
	handle.turnStarted(w.session.submitted[0]!);
	w.session.isBusy = true;
	await ui(notes, "POST", `/byoa/ui/sessions/${sid}/messages/${run.message_id}/interrupt`);
	await w.until("host aborted", () => w.session.aborts === 1);
	handle.turnEnded("interrupted");
	await w.until("interrupted", () => eventsFor(notes, run.message_id).includes("interrupted"));
});

test("the person types into an app turn: it is taken over and nothing more streams", async () => {
	const notes = makeApp("notes", 4100, { autoApprove: true });
	const w = await setup([notes]);
	await w.connector.connect(notes.origin);
	const handle = w.connector.attach(w.session);
	await w.until("listed", () => sessionsOf(notes).length === 1);
	const m = (await (await ui(notes, "POST", `/byoa/ui/sessions/${sessionsOf(notes)[0]!.id}/messages`, { text: "go" })).json()) as { message_id: string };
	await w.until("submitted", () => w.session.submitted.length === 1);
	handle.turnStarted(w.session.submitted[0]!);
	handle.delta("before ");
	handle.foreignPrompt("actually, show me my secrets");
	handle.takenOver();
	handle.delta("PRIVATE ANSWER");
	handle.turnEnded("done");
	await w.until("ended", () => eventsFor(notes, m.message_id).includes("interrupted"));
	const text = notes.events.flatMap((e) => (e.type === "event" && e.event.type === "delta" ? [e.event.text] : [])).join("");
	assert.equal(text, "before ");
	const end = notes.events.find((e) => e.type === "event" && e.message_id === m.message_id && e.event.type === "interrupted");
	assert.equal(end?.type === "event" && end.event.type === "interrupted" ? end.event.reason : null, "taken_over");
});

test("presence: a state change reaches the UI at once, not at the next hold; disconnect in the UI stops the agent", async () => {
	const notes = makeApp("notes", 4100, { autoApprove: true, hold: 20 });
	const w = await setup([notes]);
	await w.connector.connect(notes.origin);
	w.connector.attach(w.session);
	await w.until("listed ready", () => sessionsOf(notes)[0]?.state === "ready");
	w.session.isBusy = true;
	await w.step();
	await w.step();
	assert.equal(sessionsOf(notes)[0]!.state, "busy", "busy within two ticks despite a 20 s hold");

	const connections = (await (await ui(notes, "GET", "/byoa/ui/sessions")).json()) as { connections: { id: string }[] };
	const res = await ui(notes, "DELETE", `/byoa/ui/connections/${connections.connections[0]!.id}`);
	assert.ok(res.status < 300);
	await w.until("the connector knows", () => true, 3);
	for (let i = 0; i < 3; i++) await w.step();
	assert.match(await w.connector.status(), /disconnect|revoked|no longer/i);
	// A send now has no live session to reach.
	const again = await ui(notes, "POST", `/byoa/ui/sessions/${sessionsOf(notes)[0]?.id ?? "x"}/messages`, { text: "hello?" });
	assert.ok(again.status >= 400);
});

test("an app that holds 0 s: the connector polls on the interval and still delivers", async () => {
	const queue = makeApp("queue", 4300, { autoApprove: true, hold: 0 });
	const w = await setup([queue]);
	await w.connector.connect(queue.origin);
	const handle = w.connector.attach(w.session);
	await w.until("listed", () => sessionsOf(queue).length === 1);
	const m = (await (await ui(queue, "POST", `/byoa/ui/sessions/${sessionsOf(queue)[0]!.id}/messages`, { text: "task", kind: "task" })).json()) as { message_id: string };
	await w.until("submitted", () => w.session.submitted.length === 1, 30);
	assert.match(w.session.submitted[0]!, /· task from Ramos ·/);
	handle.turnStarted(w.session.submitted[0]!);
	handle.turnEnded("done");
	await w.until("done", () => eventsFor(queue, m.message_id).includes("done"), 30);
});

test("no bearer can start a turn: the connection's own token is refused on the UI doors", async () => {
	const notes = makeApp("notes", 4100, { autoApprove: true });
	const start = await notes.byoa.handle(new Request(`${notes.origin}/byoa/pair/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: { host: "pi", connector: "byoa", connector_version: "0.1.0" } }) }));
	const { device_code } = (await start!.json()) as { device_code: string };
	const poll = await notes.byoa.handle(new Request(`${notes.origin}/byoa/pair/poll`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_code }) }));
	const { access_token } = (await poll!.json()) as { access_token: string };
	const send = await notes.byoa.handle(new Request(`${notes.origin}/byoa/ui/sessions/x/messages`, { method: "POST", headers: { authorization: `Bearer ${access_token}`, cookie: COOKIE, origin: notes.origin, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) }));
	assert.equal(send!.status, 401);
});

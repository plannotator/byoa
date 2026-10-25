// The proxied tool: one per app, built from its tools/list at session start;
// a call goes to that app's MCP endpoint with its own token and _meta. When
// the list fails, the last list the app answered is used from disk.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildToolDefinition, MAX_DESCRIPTION, toolCall } from "../src/tools.ts";
import { jsonRpcMessage } from "../src/mcp.ts";
import { app, FakeApp, FakeSessionHost, HOME, world } from "./fakes.ts";

const SAY = { name: "say", description: "Put a note into the designer. Shown at once.", inputSchema: { type: "object", properties: { text: { type: "string", description: "The note." } } } };
const DRAFT = { name: "draft_machine", description: "Draft a machine.", inputSchema: { type: "object", properties: { text: { type: "string" }, size: { type: "number" } } } };
const GET = { name: "get_draft", description: "Read the draft.\nMore lines.", inputSchema: { type: "object", properties: { draft_id: { type: "string" } } } };
const MACHINE = { id: "machine", name: "Machine", origin: "http://127.0.0.1:4100", mcp: true, tools: [SAY, DRAFT, GET], mcpSession: true };
const WS = { id: "workspaces", name: "Workspaces", origin: "https://workspaces.example", mcp: true, tools: [{ name: "list_files", description: "List files.", inputSchema: { type: "object", properties: {} } }] };

// Catches: a tool per MCP tool (a changing list breaks the prompt cache), and
// an app's token sent to another app.
test("one tool per app from tools/list; a call carries _meta and only that app's token, over JSON and over SSE with initialize", async () => {
	const w = await world([MACHINE, WS]);
	await w.tick(1);
	const tools = await w.handle.tools();
	assert.deepEqual(tools.map((t) => t.name), ["machine", "workspaces"]);
	const machine = tools[0]!;
	assert.match(machine.description, /^Machine \(http:\/\/127\.0\.0\.1:4100\)/);
	assert.match(machine.description, /- say: Put a note into the designer\.\n- draft_machine: Draft a machine\.\n- get_draft: Read the draft\./);
	const props = (machine.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>);
	assert.deepEqual(props.action?.enum, ["say", "draft_machine", "get_draft"]);
	assert.equal(props.text?.description, "(say, draft_machine) The note.");
	assert.deepEqual(machine.inputSchema.required, ["action"]);

	const m = app(w.net, MACHINE.origin);
	const ws = app(w.net, WS.origin);
	const sessionId = m.session().id;
	// Outside a turn: session and wakes, no message.
	assert.deepEqual(await machine.call({ action: "say", text: "hi" }), { text: "machine did say", isError: false });
	assert.deepEqual(m.toolCalls[0], { name: "say", arguments: { text: "hi" }, meta: { "dev.byoa/session": sessionId, "dev.byoa/wakes": true }, auth: `Bearer ${[...m.tokens][0]}` });
	// Inside Machine's turn: its message id too; Workspaces' call never gets it.
	m.send({ message_id: "m_1" });
	await w.tick(2);
	w.handle.turnStarted(w.session.submitted[0] as string);
	await machine.call({ action: "get_draft", draft_id: "d1" });
	assert.equal((m.toolCalls[1]?.meta as Record<string, unknown>)["dev.byoa/message"], "m_1");
	await tools[1]!.call({ action: "list_files" });
	assert.equal((ws.toolCalls[0]?.meta as Record<string, unknown>)["dev.byoa/message"], undefined);
	// Every request to each origin carried only that origin's token.
	for (const [origin, a] of [[MACHINE.origin, m], [WS.origin, ws]] as const) {
		for (const s of w.net.to(origin)) if (s.auth !== null) assert.ok(a.tokens.has(s.auth.replace("Bearer ", "")), `${s.url} carried a foreign token`);
	}
	assert.ok(w.net.sent.some((s) => s.url === `${MACHINE.origin}/mcp` && (s.body as { method?: string }).method === "initialize"), "initialized for the server that needs it");
});

// Catches: a call with fields of another action, or an unknown action, reaching the app.
test("a call with an unknown action or a field the action does not take is refused before any request", async () => {
	const w = await world([MACHINE]);
	const [machine] = await w.handle.tools();
	const before = w.net.sent.length;
	assert.deepEqual(await machine!.call({ action: "delete_all" }), { text: "Invalid machine call: action must be one of say, draft_machine, get_draft.", isError: true });
	assert.deepEqual(await machine!.call({ action: "say", draft_id: "x" }), { text: 'Invalid machine call: say takes no "draft_id" (its fields: text).', isError: true });
	assert.equal(w.net.sent.length, before);
});

// Catches: the tool list changing mid-session (prompt cache), or an app
// paired mid-session appearing in this session's tools.
test("the tool list is fixed for the session; an app paired later reaches the next session", async () => {
	const w = await world([WS]);
	const first = await w.handle.tools();
	w.net.add(new FakeApp({ ...MACHINE, approveAtOnce: true }));
	await w.connector.connect(MACHINE.origin);
	assert.equal(await w.handle.tools(), await w.handle.tools());
	assert.deepEqual((await w.handle.tools()).map((t) => t.name), first.map((t) => t.name));
	const next = w.connector.attach(w.session);
	assert.deepEqual((await next.tools()).map((t) => t.name), ["workspaces", "machine"]);
});

test("descriptions stay within 2,048 characters; a long list names the rest in the action enum", () => {
	const many = Array.from({ length: 80 }, (_, i) => ({ name: `tool_${i}`, description: `Does thing number ${i} with a fairly long explanation that goes on.`, inputSchema: {} }));
	const def = buildToolDefinition({ id: "big.app", name: "Big", origin: "https://big.example" }, many)!;
	assert.equal(def.name, "big_app");
	assert.ok(def.description.length <= MAX_DESCRIPTION, `${def.description.length}`);
	assert.match(def.description, /\(and \d+ more, listed in "action"\)$/);
	assert.equal((def.inputSchema.properties as Record<string, { enum: string[] }>).action?.enum.length, 80);
	assert.deepEqual(toolCall({ action: "tool_3" }, many), { name: "tool_3", arguments: {} });
});

test("an SSE body carries the JSON-RPC answer with the matching id", () => {
	const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n';
	assert.deepEqual(jsonRpcMessage(sse, "text/event-stream", 7), { result: { ok: true } });
	assert.deepEqual(jsonRpcMessage('{"jsonrpc":"2.0","id":7,"error":{"message":"nope"}}', "application/json", 7), { error: "nope" });
});

// ── the tools cache ─────────────────────────────────────────────────────────

const CACHE = `${HOME}/.byoa/tools/claude-code/https_workspaces.example.json`;

const definition = (t: { name: string; description: string; inputSchema: Record<string, unknown> }) => JSON.stringify([t.name, t.description, t.inputSchema]);

// Catches: a failed tools/list (an app deploy) leaving the session with no
// tool, and a cached tool that differs from the fresh one (prompt cache).
test("a listed tool refreshes the cache, 0600 in a 0700 folder; a failed list later uses it, byte for byte, and calls still reach the app", async () => {
	const w = await world([WS]);
	const [fresh] = await w.handle.tools();
	assert.ok(fresh);
	assert.equal(w.files.files.get(CACHE)?.mode, 0o600);
	assert.equal(w.files.dirs.get(`${HOME}/.byoa/tools/claude-code`), 0o700);
	assert.deepEqual(JSON.parse(w.files.files.get(CACHE)!.text).tools, WS.tools);

	const ws = app(w.net, WS.origin);
	ws.listFailures = Number.POSITIVE_INFINITY;
	const next = w.connector.attach(new FakeSessionHost());
	const [cached] = await next.tools();
	assert.ok(cached);
	assert.equal(definition(cached), definition(fresh));
	assert.ok(w.host.toasts.some((t) => /tools from cache/.test(t) && /503|deploying/.test(t)), w.host.toasts.join("\n"));
	await w.tick(2);
	assert.match(await w.connector.status(), /tools from cache/);
	assert.deepEqual(await cached.call({ action: "list_files" }), { text: "workspaces did list_files", isError: false });
	assert.equal(ws.toolCalls.length, 1);
});

test("one quick retry: a list that fails once still comes fresh", async () => {
	const w = await world([WS]);
	app(w.net, WS.origin).listFailures = 1;
	const tools = await w.handle.tools();
	assert.deepEqual(tools.map((t) => t.name), ["workspaces"]);
	assert.ok(!w.host.toasts.some((t) => /tools/.test(t)), w.host.toasts.join("\n"));
	assert.ok(w.files.files.has(CACHE));
});

test("a failed list with no cache gives no tool for that app, and says so", async () => {
	const w = await world([WS]);
	app(w.net, WS.origin).listFailures = 2;
	assert.deepEqual(await w.handle.tools(), []);
	assert.ok(w.host.toasts.some((t) => /tools are not available in this session/.test(t)));
	assert.equal(w.files.files.has(CACHE), false);
});

test("a cache file other users may write is not used", async () => {
	const w = await world([WS]);
	await w.handle.tools();
	w.files.chmod(CACHE, 0o666);
	app(w.net, WS.origin).listFailures = 2;
	assert.deepEqual(await w.connector.attach(new FakeSessionHost()).tools(), []);
});

test("disconnect removes the cache with the credential, and so does a revoked token", async () => {
	const w = await world([WS]);
	await w.handle.tools();
	assert.match(await w.connector.disconnect("workspaces"), /disconnected/);
	assert.equal(w.files.files.has(CACHE), false);

	const v = await world([WS]);
	await v.handle.tools();
	assert.ok(v.files.files.has(CACHE));
	app(v.net, WS.origin).revokeAll();
	await v.tick(3);
	await v.connector.settled();
	assert.match(await v.connector.status(), /revoked/);
	assert.equal(v.files.files.has(CACHE), false);
	assert.ok([...v.files.files.keys()].some((p) => p.includes("/credentials/")), "the credential stays until a reconnect replaces it");
});

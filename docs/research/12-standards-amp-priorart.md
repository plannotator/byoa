# Standards, Amp, prior art (verified 2026-10-21)
MCP @80041ab (2026-10-20); ACP @67e1c3d (2026-10-20); ext-apps @10195ad; webmcp @f5645e9.

## MCP — latest released 2026-07-28
- Stateless transport (no initialize; _meta per request; server/discover). SEP-2575, SEP-2567.
- subscriptions/listen: only list-changed/resource-updated. No turn semantics.
- Tasks: official extension io.modelcontextprotocol/tasks (SEP-2663), polling. No client listed as supporting it.
- Elicitation only inside a request (MRTR, SEP-2322). Sampling/roots/logging deprecated (SEP-2577); standalone server-initiated requests MUST NOT (SEP-2260).
- Events: NOT in spec. Tasks & Events WG; SEP-3415 Events Extension draft PR (events/list|poll|stream|subscribe webhook) — delivers to client, not into model turns. SEP-2495 (push that starts LLM turns) open, unsponsored, stalled. github.com/modelcontextprotocol/experimental-ext-triggers-events
- MCP Apps stable 2026-01-26 (io.modelcontextprotocol/ui). Not in Claude Code. Inverted from BYOA (app UI inside agent chat). ui/message shows host-approved UI->chat path.
- Adoption: 2/22 clients on 2026-07-28 (zuplo.com/learn/mcp/compatibility). Claude Code still initialize era.
=> No standard way for a server to wake an agent.

## ACP v1.12.0 (2026-10-16), v2 draft 2026-07-20
- Editor(client) <-> agent subprocess, stdio JSON-RPC; session/prompt, session/update; client passes MCP servers in session/new.
- RFDs: Streamable HTTP/WebSocket transport (active), MCP-over-ACP (draft, "type":"acp" + mcp/message), proxy chains (draft), v2 prompt lifecycle (agent can initiate without prompt; active), client system prompt, subagents.
- Invertible: app (or local bridge) acts as ACP client, spawns agent (e.g. claude-agent-acp). But spawns a NEW agent process — not "my running session with my plugins/context". No shipping ACP web client; browser can't spawn.

## WebMCP: W3C CG draft, document.modelContext.registerTool(); Chrome 149 / Edge 150 OT. No page->agent prompt/wake; autonomy non-goal. MCP-B local relay bridges to stdio MCP clients (tools only).

## Amp plugins (ampcode.com/docs/markdown/plugin-api)
registerTool/Command/Skill/AgentMode; events session.start, tool.call/result, agent.start/end; agent.end -> {action:'continue', userMessage}; ctx.thread.append, threads.get(id).appendUserMessage; createAgent().createThread; long-lived process, onDispose; amp.createWebhook (durable, at-least-once, 30 s). Unverified: can external event start a turn in the user's CURRENT thread. Only amp.experimental marked unstable.

## Codex app-server: turn/start, turn/steer, thread/inject_items; dynamicTools experimental; WS experimental.

## Prior art
MCP-B webmcp-local-relay (tools only); Paperclip BYOA (claude_local/codex_local adapters — spawns); Agentation; Plannotator; CC Remote Control (first-party); Happy; claudecodeui; VibeTunnel; Vibe Kanban; Conductor; Omnara; Linear agent sessions (hosted agents via webhooks); A2A. No cross-vendor BYOA protocol.
Watch: ACP v2 prompt lifecycle + HTTP/WS transport; MCP SEP-3415.

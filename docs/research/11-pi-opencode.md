# Pi and OpenCode V2 extension surfaces (verified 2026-10-21)
Versions: pi (earendil-works/pi, coding-agent 1.0.2) d677d0ee7 2026-10-04; opencode 2.0.32 1cb7bcadb1 2026-10-16. OpenCode was rewritten (V2: packages/server, protocol, client, sdk, @opencode/plugin). OpenChamber still on 1.x API.

## Pi (earendil-works/pi, packages/coding-agent)
- Extension = factory (pi: ExtensionAPI) (src/core/extensions/types.ts:2004); jiti; .pi/extensions, ~/.pi/agent/extensions; `pi install npm:|git:`.
- Start sockets in session_start, close in session_shutdown (runtime rebuilt on reload/new/resume/fork).
- Tools: pi.registerTool at runtime; setActiveTools; registerMcpServer/unregisterMcpServer.
- Inbound: pi.sendUserMessage(content,{deliverAs: steer|followUp}); pi.sendMessage(custom,{triggerTurn, deliverAs: steer|followUp|nextTurn}) wakes idle (agent-session.ts:2246). Sending while streaming w/o deliverAs throws.
- New session only from command context (newSession/switchSession/fork).
- Observe: message_update (token), tool_execution_*, agent_start/end, agent_settled, ctx.isIdle().
- Background: yes. Example pi-subagents/src/extension/herdr-pi-bridge.ts (unix socket server -> prompt/steer/followUp; emits message_end/agent_settled). pi-until timers wake idle.
- External: `pi --mode rpc` JSONL stdio; SDK createAgentSession; experimental CBOR unix server + Radius WebSocket relay (no peer auth).
- UI: ctx.ui.select/confirm/input/notify; tool_call handler can block.

## OpenCode V2 (opencode, packages/)
- Plugin.define({id, setup(ctx) -> cleanup}); plugins config with npm auto-install, .opencode/plugins; entrypoints server/tui/rpc; one instance PER PROJECT DIRECTORY (fixed ports collide).
- Tools: ctx.tool.transform + reload; ctx.mcp.transform.
- Inbound: ctx.session.{create,prompt,synthetic,command,interrupt,wait}; prompt({sessionID,text,delivery: steer|queue, resume?}) wakes idle.
- Observe: ctx.event.subscribe(): session.text.delta, reasoning.delta, tool.called/success, execution.started/succeeded, session.status, session.idle.
- ctx.rpc.register -> POST /api/rpc/:rpcID/:method + rpc.* SSE events (a ready-made channel).
- External: `opencode serve` HTTP+SSE /api/event, Basic auth always on (OPENCODE_PASSWORD), `opencode pair [--remote]`; @opencode/sdk in-process.
- Permissions: ctx.permission.assert.

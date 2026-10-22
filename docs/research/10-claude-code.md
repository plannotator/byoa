# Claude Code extension surface (verified 2026-10-21, CLI v2.1.306)

Mods = BYOA surface. Plugin with hooks/hooks.json "modules": ["./register.js"], in-process JS, `$` capability object. On by default since v2.1.287, early access, API churns weekly.
- Inbound/wake: `$.prompt.submit({text, asUser?})` queues and starts a turn when idle (labelled as plugin turn unless asUser). Refused after Esc until next user input. `$.session.append` mid-turn (>=2.1.301). `$.turn.abort` interrupts.
- Observe: `turn.step` async generator {kind:text|tool}, `turn.complete {answer,isAborted,usage}`, `agentId` for subagents, `session.messages()`.
- Tools: `$.tool.register` any time, appears as mcp__<plugin>__<name> from next prompt; no unregister found. `$.command.register`.
- I/O: `$.http.fetch` (4 MiB, 30 s abort) — NO listen. `$.process.run` (30 s default, 10 min max). `$.clock.every/after`. `$.mcp.call/connect` (shares CC's MCP OAuth). `$.store` is 0644.
- UI: panes, band above prompt, toasts.
- Distribution: marketplace `claude plugin install x@mkt`, --plugin-dir, --plugin-url zip. Name may not contain "claude".
- Docs: https://code.claude.com/docs/en/plugins/mods/{overview,api,reference}.md; the types ship with the mods docs (claude-code.d.ts)
- Issue anthropics/claude-code#91870 "Mods" (poteat, Sep 3 2026, live Oct 1). Qwen Code building compat layer on same authoring contract (QwenLM/qwen-code#13749) -> possible cross-agent standard.

Channels (`experimental['claude/channel']` + notifications/claude/channel): research preview, allowlist, `--channels` flag per session, custom need `--dangerously-load-development-channels`; stdio only; no ack; breaks with MCP 2026-07-28 negotiation unless legacy. => fallback only.
Hooks: asyncRewake (stderr reminder on exit 2), Stop.last_assistant_message, transcript_path.
External drive: `claude -p --input-format stream-json --output-format stream-json`, Agent SDK streaming input, `claude --bg`/attach. Remote Control is first-party only.

Proof in the wild: the Workspaces and Plannotator mods already long-poll an app and stream deltas from inside a mod.

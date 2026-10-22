# Proof log

What has been shown to work, against what, with the evidence.

| Date | What | Against | Evidence |
| --- | --- | --- | --- |
| 2026-10-21 | One Claude Code mod holds 6 concurrent held fetches; a quick fetch mid-hold is not delayed | real Claude Code 2.1.306 | `research/30-fetch-concurrency-probe.md` |
| 2026-10-21 | `@plannotator/byoa-server` and `@plannotator/byoa-connector-core` speak the same wire: page pairing, chat stream in order, two apps FIFO, stop, take-over, presence, revoke, hold 0, no bearer sends | the real packages, fake host | `packages/conformance/test/wire.test.ts` (7 tests); 86 tests in all |
| 2026-10-21 | Claude Code connector: connect two apps, a tool turn with a real permission prompt, two apps FIFO, interrupt, provenance line, `/clear` re-register | real Claude Code 2.1.306 (`--model haiku`), two demo apps | `connectors/claude-code/scripts/live.py`, `live-transcript.txt` |
| 2026-10-21 | **Machine migrated** (first product on the wire): server on `@plannotator/byoa-server` (sqlite store, autoApprove local); its own Claude Code plugin deleted. Real run: connect in one command, designer picks the session up, haiku + low effort applied, two permission prompts, `draft_machine` + `say` land in the right designer session, 17 s send to draft | real Claude Code 2.1.306 + the `byoa` connector, Machine's server | Machine's repository: `docs/byoa/scripts/live-claude.py`, e2e `docs/byoa/scripts/e2e.mjs` |
| 2026-10-21 | Claude Code connector registers interactive sessions only, refuses its own tool unless the host's permission check allows it | real Claude Code 2.1.306, `--permission-mode default` | `connectors/claude-code/hooks/permission.ts`, live run |
| 2026-10-21 | Pi connector: connect two apps, stream, proxied tool, two apps FIFO, interrupt; `pi -p` registers nothing | real Pi 0.85.1 and 1.3.0, echo model | `connectors/pi/scripts/live.ts`, `live.transcript.txt` |
| 2026-10-21 | OpenCode 2 connector: the same steps; `run --standalone` registers nothing | real OpenCode 2.1.2 (`--standalone`), echo model | `connectors/opencode/scripts/live.ts`, `live.transcript.txt` |
| 2026-10-21 | **Machine is wire-only**: its Claude Code, Pi and OpenCode plugins, `/api/connect` and the `?agent=` MCP binding are deleted. Pi: settings by display name, effort applied, draft and note in 2 s. OpenCode 2: models listed by display name, draft and note in 2 s | real Pi 0.85.1, OpenCode 2.1.2 + the `byoa` connectors, Machine's server | Machine's repository: `docs/byoa/scripts/live-pioc.ts` |
| 2026-10-22 | **Published 0.1.0** as `@plannotator/byoa-{protocol,server,connector-core,pi,opencode}`; a clean `npm install` from the registry loads all five, `createByoa` answers discovery, Pi's and OpenCode's entries load | npm registry, Node 24 | `scripts/publish.sh`; install check in a temp folder |
| 2026-10-22 | **Machine on the published packages** (`^0.1.0`, no workspace links): a fresh copy installed from npm, built and served; the e2e (a connector on the published connector-core) paired, took a prompt and drafted | Machine's server on :7420 | Machine's repository: `docs/byoa/scripts/e2e.mjs` |

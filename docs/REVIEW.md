# Check: the four implementers reviewed SPEC 0.1

2026-10-21. The draft wire was sent to the four Claude Code sessions that built the pattern, one each for Workspaces, Plannotator Inbox, AppNotes and Machine. Each was asked whether its product could run on the wire, and what in it contradicts what they learned. They answered from their own code and review records. Each answer is summarised below with what changed in SPEC.md.

## Verdicts

| Product | Can it run on 0.1? | Biggest change it caused |
| --- | --- | --- |
| Workspaces | Yes, with contract changes beyond renames | Steer is forbidden for hand-offs. A local app has to be confirmed in the agent. No automation exception to "only a person starts a turn". |
| Plannotator Inbox | Yes, with five additions | Per-session lease and on-disk claim-once for two processes on one session. An `upgrade` command for Send now. The rules for several apps in one session (9.6). |
| AppNotes | Yes. Dropping its atomic claim is acceptable | `requires.workspace` in discovery. The no-other-people's-content rule became a MUST. Tool results mark untrusted content. |
| Machine | Yes, with four additions; nothing forbids its shape | A session-level `state` event. Settings carry their choices and the value in force. |

## Changes made to SPEC.md

**From Workspaces:**

- Steer is allowed only for `chat` and `reply`, and only when the person chose it. Never for `task` or `notice`.
- The loopback discovery file makes an app findable, not trusted. The person confirms it in the agent, and the connector pins the app to its origin.
- 9.1 has no automation exception. Only an action by the person in their own session starts a turn.
- The app's server writes the turn text, and the connector adds a line above it. The connector matches its own turns by the exact text it submitted, not by host framing.
- A token goes only to its exact origin, and no redirect is followed with it.
- Revocation answers `401 unauthorized`. `seq` starts at 0. The session id derives from the credential id.
- An attribution correction: the review found that a path *could* carry an injection, not that one did.

**From Plannotator:**

- Two processes on one `host_session_id`: a lease on disk, a claim per `message_id` on disk, and a claimed message that never started is reported once.
- An `upgrade` command and UI door ("Send now").
- `_meta["dev.byoa/wakes"]`.
- `idle_since` and `started_at` on poll and register.
- Busy comes only from main-loop turns, never subagents. `when_idle` waits two ticks.
- Loopback doors refuse forwarding headers (the `tailscale serve` exposure).
- One browser event stream shared across tabs, because of Chrome's six connections per host.
- The rules for several apps in one session (9.6).
- The stdio MCP fallback for hosts without plugins is listed under "Not in 0.1".
- Correction: Plannotator's registry is `~/.plannotator/inbox/inbox.json`. The "refuse a wider mode" rule is Workspaces', not Plannotator's.

**From AppNotes:**

- `requires.workspace` in discovery, shown at pairing.
- The app re-routes when a chosen session goes `gone` before `started`.
- 5.3 `text` content rule raised to MUST.
- Tool results SHOULD mark content other people wrote.

**From Machine:**

- A `state` event with no `message_id`, sent when any turn starts, and governed by the person's sharing setting.
- `capabilities.settings` carries `{ id, name, value, choices }`.
- Pi's idle gate includes `!ctx.hasPendingMessages()`. Claude Code's busy state ignores `agentId` turns.
- The conformance seeds are named.
- Correction: Machine's prose stays in the terminal because it has no delta channel, not by choice.

## Still open after the review

- **Scoping one app's turn to its own tools.** Decided 2026-10-21: not in 0.1. Cross-app use is allowed and the host's permission prompts are the control (README, Decisions 3).
- **A durable "any matching session may claim" primitive** (AppNotes, and Plannotator's claim-once). 0.1 handles routing in the app, and handles claim-once across processes in the connector. A cross-machine claim is not covered.
- **Re-checking before delivery whether the agent already read the item through MCP** (Plannotator). 0.1 relies on the app sending `interrupt` to withdraw it. A race remains between that withdraw and the connector's delivery.

## Round 2: simplicity votes (2026-10-21)

The owner asked: "avoid overengineering; test every assumption and decision with your colleagues so the design works, works well, has no bottlenecks and no unnecessary complexity." Each of the four implementers voted keep, cut or change on every decision, from their own code. One assumption was measured directly in a real host.

| Decision | Workspaces | Plannotator | AppNotes | Machine | Result |
| --- | --- | --- | --- | --- | --- |
| A. N concurrent held polls in one Claude Code mod | untested | works: several at once from one tick | no evidence | one poll plus tool calls, no blocking | **Kept. Measured:** 6 concurrent 15 s holds from one mod, plus a quick fetch not delayed (Claude Code 2.1.306, `research/30-fetch-concurrency-probe.md`) |
| B. Long-poll 20 s | keep | free on loopback | allow a hold of 0 (serverless host) | keep | **Kept**, and a hold of 0 with `poll_interval_seconds` is allowed |
| C. On-disk lease and claim for two processes | backoff only, no exactly-once | the claim gives "once", the lease is about which process | the atomic claim plus a report-on-timeout is enough | last poller wins; add a claim once a duplicate is seen | **Cut.** Last poller wins, plus backoff and act-once by id |
| D. `upgrade` / send now | later | wanted, 0.2 is fine | later | later | **Cut** to 0.2, along with steer |
| E. Per-app rate limit | cut | cut | cut | cut | **Cut** |
| F. Connector policy | cut steer, keep interrupt | cut to `share`, plus a tool off switch | cut to `share` and required fields | cut to `share` | **`share` only.** Interrupt is a session capability. Disconnecting an app removes its tool |
| G. App tools | native mount works (restart gap) | proxied, cache-stable, under 2,048 characters | proxied | proxied, worked on all hosts | **One proxied tool per app** |
| H. UI stream | one stream per send | one per tab; cross-tab sharing needs leader election | no evidence | one stream (`/events`) | **One multiplexed stream per tab**, not shared across tabs |
| I. Loopback grant | device grant on loopback proven | keep a separate path | no evidence | cut; one code path | **Cut.** The device grant everywhere |
| J. `state` event, settings with choices | neither exists | keep `state` | no evidence | keep choices (value may be empty); a re-poll at once can replace the event | **Settings kept** with a nullable value. **`state` event replaced** by an immediate re-poll |
| K. Connector provenance line | triple prefix on Claude Code | cut if the app names itself | keep, the connector's wins | cut, double prefix | **Kept, and apps drop their own prefix.** Claude Code's own label names only the `byoa` plugin, so something unforgeable has to name the app |
| L. Other | DELETE sessions and tool phases unused | none | none | none | **Cut** both |

# BYOA Wire, draft 0.1

Status: draft, 2026-10-21. The types and parsers in `packages/protocol/src/` are the source of truth wherever this prose differs from them. Every shape here comes from one of four working implementations on this machine (Workspaces, Plannotator Inbox, AppNotes, Machine), and the implementation is named where it matters. After the first draft, the four implementers voted on every decision, and what they cut is listed in section 11 ([REVIEW.md](REVIEW.md) has the votes).

MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Roles

- **App.** A web application, hosted or on loopback. It owns the people and their sign-in, its tools, and the chat UI. It implements the doors in this document; the server SDK (`@plannotator/byoa-server`) implements them for it.
- **Connector.** Code that runs inside a running agent session: a Claude Code mod, a Pi extension, or an OpenCode 2 plugin. One connector per agent host serves every app the person paired. It dials out and never listens.
- **Host.** The agent program the person already runs.
- **Person.** The signed-in user of the app, who also owns the machine the host runs on.

A **connection** is one pairing: one person's account in one app, bound to one host on one machine. A **session** is one live host conversation that registered through a connection. A **message** is one thing the app asks a session to do, and it becomes at most one turn.

## 2. Transport

- JSON over HTTPS. Plain `http` is allowed only to a loopback origin (`127.0.0.1`, `::1`, `localhost`).
- Every connector request carries `Authorization: Bearer <connection token>`. The two pairing calls are the only exception, because they run before a token exists.
- Long-poll is the only transport. Claude Code mods, the most constrained host, have `$.http.fetch` only: it returns whole bodies, aborts at 30 s, and cannot listen.
  - An app holds a poll for at most `poll_hold_seconds`, from 0 to 25. 20 is recommended, and an app MUST answer within 25 s.
  - An app MAY use 0, which means answer every poll at once. It then advertises `poll_interval_seconds` (default 5), and the connector polls that often. This suits an app on a serverless platform, where holding a request open is costly.
  - A connector holds one poll per app per session at the same time. This was measured: one Claude Code 2.1.306 mod held six 15 s fetches at once, all arrived together, and a quick fetch sent mid-hold was not delayed.
- Errors have one shape, `{ "error": "<code>", "error_description": "<text>" }`. The pairing doors use RFC 8628's codes.
- No path on the wire is percent-encoded: endpoint paths are fixed and every id is URL-safe. An app MUST answer 404 to a BYOA path that contains `%`, and MUST NOT decode it. Otherwise a check the app keys on the literal path, such as a rate limit or a CSRF rule, can be skipped with an encoded spelling (`/byoa/pair/%73tart`).

## 3. Discovery

`GET <origin>/.well-known/byoa`, with no credential:

```json
{
  "byoa": "0.1",
  "app": { "id": "workspaces", "name": "Workspaces", "icon": "https://…/icon.svg", "origin": "https://workspaces.example" },
  "endpoints": {
    "pair_start": "/byoa/pair/start",
    "pair_poll": "/byoa/pair/poll",
    "verification_uri": "/byoa/connect",
    "revoke": "/byoa/revoke",
    "sessions": "/byoa/sessions",
    "mcp": "/mcp"
  },
  "poll_hold_seconds": 20,
  "accepts": { "interrupt": true, "stream": true, "settings": ["model", "effort"] },
  "requires": { "workspace": ["git_remote"] }
}
```

- Endpoints are paths on `origin`.
- `endpoints.mcp` is OPTIONAL. When present, it is an MCP server (Streamable HTTP) that MUST accept the connection token as its bearer (section 7).
- `requires.workspace` names the session fields (5.1) the app cannot work without, for example `git_remote`, which AppNotes uses to route work to the right repo. The connector shows this when pairing. If the person's sharing setting withholds a required field, the connector says so instead of registering silently.

## 4. Pairing

### 4.1 Device grant

The grant uses RFC 8628 field names and error codes, with JSON bodies (from Workspaces). It is the same for hosted and local apps. A local app serves the approval page on its loopback origin, so pressing Connect there is the person's confirmation (Workspaces proved this against a local stack). Before pairing with an origin the person did not type themselves, the connector names that origin and asks.

A local app with no accounts at all (Machine's local server) MAY approve at `pair_start`: the first `pair_poll` then returns the token, with no page and no click. This is only for a server on a loopback origin that has no users to protect; it keeps `machine login http://localhost:7420` a single command (machine-ops). The code path stays the same.

`POST pair_start`, with no credential:

```json
{ "client": { "host": "claude-code", "host_version": "2.1.306", "connector": "byoa", "connector_version": "0.1.0", "machine_name": "ramos-mbp" } }
```

→ `200 { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`

- `user_code` has 8 characters from RFC 8628's consonant alphabet (`BCDFGHJKLMNPQRSTVWXZ`) and is shown as `XXXX-XXXX`.
- `expires_in` is 600 at most. `interval` is at least 2.

`POST pair_poll { device_code }` answers either `400` with one of `authorization_pending`, `slow_down`, `access_denied` or `expired_token`, or exactly once:

```json
{ "access_token": "…", "token_type": "bearer", "connection_id": "conn_…", "account": { "display_name": "Ramos" } }
```

The approval page at `verification_uri` belongs to the app. It MUST:

- require the app's own signed-in human session;
- do nothing on GET (a link alone never connects);
- show the code, the host, the machine name as declared (marked unverified), the account it will act as, and how long ago the request was made;
- state what connecting grants: "<Host> on <machine> can use <App> as you, and <App> can start turns in that agent's sessions."

The app mints the token when the poll collects it, not at approval, so the raw token never rests on the server. There is one token per connection, so two hosts on one laptop are two connections.

### 4.2 Revocation

- `POST revoke` with the token as bearer answers `204` and is idempotent. The connector calls it on disconnect. As in RFC 7009, it answers `204` for a token that is unknown, already revoked or not a BYOA token at all, so the door never tells a caller which tokens are valid.
- The app MAY revoke a connection at any time. After that, every door answers `401 unauthorized`, held polls end at once with `401`, and that connection's open UI messages end with `gone` (reason `disconnected`).

## 5. Sessions

### 5.1 Register

`POST sessions`

```json
{
  "host_session_id": "6f0c…",
  "host": "claude-code",
  "host_version": "2.1.306",
  "connector_version": "0.1.0",
  "workspace": { "folder_name": "byoa", "git_remote": "github.com/acme/app" },
  "started_at": "2026-10-21T14:02:11Z",
  "capabilities": {
    "interrupt": true,
    "stream": true,
    "settings": [
      { "id": "model", "name": "Model", "value": null, "choices": [{ "value": "opus", "name": "Opus" }, { "value": "sonnet", "name": "Sonnet" }] },
      { "id": "effort", "name": "Effort", "value": "high", "choices": [{ "value": "low", "name": "Low" }, { "value": "high", "name": "High" }] }
    ]
  }
}
```

→ `200 { "session": { "id": "ses_…", … }, "poll_hold_seconds": 20, "minimum_connector_version": "0.1.0" }`

- A connector registers only **interactive** sessions: Claude Code `isInteractive`, Pi `ctx.mode === "tui"`, OpenCode with its TUI half loaded. `-p`, RPC and SDK runs never register; all four implementations learned this. Subagent sessions never register either.
- `settings` lists what the app may set before a turn (5.3 `set`), with the choices and the value in force, so the app can draw a picker (from Machine). `value` is null when the host does not report it; Claude Code does not report the model in force.
- `workspace` fields are each OPTIONAL. The person's `share` setting decides which are sent; the default is `folder_name` and `git_remote`, and never `path`. `git_remote` is normalised to `host/path` (for example `github.com/acme/app`), with any user name or token in the URL removed, so apps can match sessions by repo across hosts.
- `session.id` SHOULD be derived from the connection's credential id and `host_session_id`. A re-register after an app restart then gets the same id, and open conversations and stored choices keep pointing at it.
- `host` MUST equal the host the connection was paired as: the person approved that host on the consent page, and each host keeps its own credential. An app answers a different one with `422 validation_error`.
- An app MAY cap live sessions per connection (Workspaces: 64).

### 5.2 Poll

`POST sessions/{id}/poll`

```json
{ "state": "ready", "idle_since": "2026-10-21T14:05:40Z" }
```

- `state` is `ready` (idle), `busy` (any turn is running), or `blocked` (a permission prompt is waiting, with `cause: "permission"`). `settings` is included when a value changed since register.
- **The poll body is the only presence signal.** When the state or a setting changes, the connector sends a new poll at once, and the app answers the older held poll with `{ "commands": [] }`. So the app sees a turn start at the moment it starts, without a separate event (Machine's review).
- The app derives `gone` when no poll has arrived for 60 s. There is no end-of-session call.
- Busy comes from the host's own main-loop turn events, never from subagents:
  - Claude Code: `turn.start` and `turn.complete` without `agentId`;
  - Pi: `agent_start` and `agent_settled`, plus `!ctx.hasPendingMessages()`;
  - OpenCode: `session.status` and `session.idle` for sessions without `parentID`.

  Plannotator and Machine both had sessions stuck "busy forever" because of subagents.

→ `200 { "commands": [ … ] }`, held until a command exists or `poll_hold_seconds` passes, in which case the list is empty.

- `404 session_not_found` means the app forgot the session, for example after a restart. The connector registers again.
- A command can arrive twice when a poll answer was lost. The app SHOULD offer an unanswered message again after 30 s, and the connector MUST act on each `message_id` once.
- **Two processes, one session.** `claude --continue` in a second terminal gives two processes the same `host_session_id`. The newest poll wins on the server, and a connector whose polls keep being superseded backs off from 1 to 30 s with jitter. Each message is handed to one poll. Exactly-once delivery across processes is not promised. A per-process lease and claim, as Plannotator has, is left for when a duplicate is actually seen (Machine and AppNotes reviews).
- **A gone session still takes messages.** A message sent to it waits on the app until the session polls again; its id is stable across restarts. Only a message a poll already took is ended `gone` when its session goes. The app may still withdraw a waiting message and offer it to another matching session (AppNotes). Machine asked for this so apps need not hold messages themselves.

### 5.3 Commands

**message**

```json
{
  "type": "message",
  "message_id": "msg_…",
  "kind": "chat",
  "from": { "display_name": "Ramos" },
  "text": "…",
  "interrupt_first": false,
  "stream": true,
  "set": { "model": "opus" }
}
```

- `kind` is one of:
  - `chat`: the person is watching a chat;
  - `task`: a hand-off, whose outcome the agent reports through the app's tools;
  - `reply`: the person's answer to something this session asked;
  - `notice`.

  The connector uses `kind` only for the provenance line; every kind becomes the same kind of turn.
- `text` is composed by the app's server only, never by a browser. It MUST carry only the person's own words and ids, never content other people wrote: titles, paths, comment bodies, or a guest's note. The agent reads those through tools. Otherwise a document path a teammate named could carry an injection.
- **Delivery is always when idle.** The connector holds the message until the host has been idle for two ticks (about 2 s), then starts a turn. It never puts a message into a running turn. The grace lets a prompt the person typed, or a `/clear`, go first. On Claude Code, `$.prompt.submit` cannot be taken back, so the message waits in the connector, not in the host's queue.
- `interrupt_first` aborts the running turn first, but only if that turn was started by a message from this app. A connector never aborts the person's own turn or another app's. It needs `capabilities.interrupt`.
- `stream` says whether to send `delta` events. When false, only lifecycle and `tool` events go back.
- `set` is OPTIONAL: settings applied before the turn, only from those the session declared (from Machine).

**interrupt**

```json
{ "type": "interrupt", "message_id": "msg_…" }
```

Stop this message wherever it is. If it is held, drop it (event `withdrawn`). If its turn is running, abort that turn (event `interrupted`, reason `stopped`; the same reason when the person stops the app's turn in the terminal). It has no effect on any turn the message did not start.

### 5.4 Events

`POST sessions/{id}/events { "events": [ … ] }` → `204`

Each event is `{ message_id, seq, type, … }`. `seq` starts at 0 for each message and goes up by 1. The app drops duplicates by `seq`. A `seq` too far ahead gets `422 seq_gap { expected }`, and the connector resends from `expected`.

| type | fields | meaning |
| --- | --- | --- |
| `queued` | | Held in the connector because the session is busy. |
| `started` | | The turn began. |
| `delta` | `text` | Answer text, in order. Sent only if `stream` is true. |
| `tool` | `name`, `title` | A tool step began. Its input and output are never sent. |
| `done` | | The turn ended normally. |
| `error` | `reason` | The host refused or failed. `reason` is a fixed phrase. |
| `interrupted` | `reason: stopped \| taken_over \| session_ended` | `taken_over`: the person typed into this turn in the terminal, and nothing more streams. |
| `withdrawn` | `reason?` | Dropped before it started. |

Exactly one of `done`, `error`, `interrupted` or `withdrawn` ends a message. An app ends its own view of a message from these events (plus the UI's `gone`), never from the session's busy/idle state: a message stopped while the connector still held it never starts a turn, so the session's state never changes (Machine, wiring Stop). The fixed `reason` phrases are listed in `EVENT_REASONS` in `packages/protocol/src/wire.ts`. A connector skips a command it cannot parse instead of failing the whole poll answer, because the app would offer it again forever.

**What leaves the machine:** only events of turns that this app's messages started. Never another turn, never thinking, never a tool's input or output, and never a subagent's steps. A connector MUST stop streaming a turn once a prompt it did not submit joins it, and end the message `interrupted` with reason `taken_over`. Otherwise a prompt the person typed into an app turn would stream its answer to the app.

## 6. The turn the agent sees

The app's server writes the turn's text. The connector adds one line above it, which the app cannot forge:

```
[BYOA] Workspaces (workspaces.example) · chat from Ramos · msg_7Hc2
<the app's text, verbatim>
```

- The name and origin come from the connector's own pairing record, not from anything the app sends. Claude Code's own label names only the `byoa` plugin, so this line is what tells the person, and the model, which app a turn came from.
- An app SHOULD NOT add its own prefix (such as Workspaces' `Workspaces:` or Machine's `Machine designer (<id>):`). The connector's line replaces it, so the person sees one label, not two or three; Plannotator, Machine and Workspaces all flagged the stacked prefixes. The asking person's name stays visible, which is how a wrongly approved pairing shows itself.
- The connector recognises its own turns by the text it submitted, matching on "contains", because Claude Code wraps a plugin's prompt in its own frame. It never matches by a host's framing sentence.
- Claude Code: the turn is submitted with `$.prompt.submit({ text })`, never with `asUser`.
- A text that starts with `/` is refused (`error`, reason `refused_slash_command`), because on Claude Code it would run a command.

## 7. Tools

Tools stay MCP. BYOA adds no tool protocol.

- If discovery lists `endpoints.mcp`, the connector registers **one proxied tool per app**, named after `app.id`. Its `action` enum is built from the app's `tools/list` once at session start. Calls go to the app's MCP endpoint with the connection token, which is sent only to that exact origin. This is what worked unchanged on Claude Code, Pi and OpenCode for Plannotator and Machine. It needs no host restart, and the tool list stays fixed for the session, which keeps the prompt cache stable. Claude Code cuts tool descriptions at 2,048 characters, so descriptions stay short.
- One credential covers the doors and the tools, so the app can tie every tool call to the connection. Two credentials in one session can break run state.
- On every `tools/call`, the connector sets `_meta["dev.byoa/session"]` to the session id. While a message's turn runs, it also sets `_meta["dev.byoa/message"]`, and always sets `_meta["dev.byoa/wakes"] = true`. With these, the app can tie a tool call to the message that caused it, and word its results as "end your turn; the answer arrives by itself".
- A tool that returns content other people wrote SHOULD mark it as data, not instructions (AppNotes). The host's permission prompts don't cover reads.
- Any app's tools may be used in any turn (owner's decision). The host's permission prompts are the control.

## 8. The UI side (SDK profile, not wire)

The browser never talks to the connector. These doors run between the app's own browser and its own server, and they are listed here so `@plannotator/byoa-react` can be reused across apps. Every one requires the app's signed-in human session and CSRF protection. No bearer token may call them, the connection token included.

- `GET /byoa/ui/events` → `text/event-stream`, one per browser tab. It carries the person's session list changes, presence included, and every message's events, each with its `message_id`. A keep-alive comment goes out every 15 s. One stream per send would hit Chrome's limit of six connections per host. Plannotator measured this: the seventh tab stalled for 8 s. Sharing one stream across tabs needs leader election, and that is not in 0.1.
- `GET /byoa/ui/sessions` → `{ connections: [{ id, host, machine_name, created_at, last_seen_at, sessions: [SessionInfo & { machine_name }] }] }`. A connection with no live session is still listed, so a lost laptop can be disconnected.
- `POST /byoa/ui/sessions/{id}/messages { text, kind?, interrupt_first?, stream?, set?, context? }` → `202 { message_id }`. The answer arrives on the events stream.
- `POST /byoa/ui/sessions/{id}/messages/{message_id}/interrupt` → `{ outcome: withdrawn | interrupt_sent | already_finished }`.
- `DELETE /byoa/ui/connections/{id}` → disconnect.

## 9. Security requirements

1. **Only a person starts a turn.** An app creates a message only from an action by a person in their own signed-in session: typing in the chat, pressing Send on a hand-off, tagging an agent, or answering a question. No bearer credential, no agent (9.2), and no scheduled automation can cause a message. That person is the paired person, unless the app lets teammates wake the agent. An app MAY let other people who share a team or organization with the paired person start turns in that person's agent, for example by tagging it, only when:
   - the paired person has a switch for it on that connection, can see its state, and can turn it off at any time, and no one else can turn it on (the app chooses the default; Workspaces has it on);
   - while the switch is off, no other person's action creates a message for that connection. When it is turned off, the app SHOULD withdraw other people's messages that have not yet started a turn (the UI's interrupt, or `byoa.interrupt`, answers `withdrawn` for them);
   - the message's `from` names the person who acted, so the turn's first line (8) names them and not the paired person.

   The approval page SHOULD say that teammates can start turns in this agent, and where to turn that off. A teammate's turn runs on the paired person's machine with that person's files and permissions, so 9.4 applies to it: a session that runs without permission prompts acts on a teammate's words without asking.
2. **No loops.** A connection token can never send a message, so no agent can start a turn in its own session or anyone else's.
3. **Frames, not content** (5.3 `text`).
4. **The host's permission prompts are the control.** A connector never answers a permission prompt and never hooks the host's permission check. A session that runs without prompts acts on whatever it reads, and connector setup says so. Pi asks no permission by default.
5. **Sharing.** The person chooses, per app, which `workspace` fields are sent. The connector enforces it, and the app cannot widen it. This is the only connector setting in 0.1.
6. **Several apps, one session.** A connector runs one app turn at a time per session, in arrival order across apps. It attributes a take-over or an interrupt to the app whose turn it was. Each session's tool list is fixed at session start: an app paired mid-session can start turns at once, but its tool arrives with the next session.
7. **Bounded resources.** The app bounds sessions per connection, events per request, buffered events per message, and how far ahead `seq` may run. Without bounds, one key could fill its owner's memory.
8. **Credentials.** Tokens live in a 0600 file in a 0700 folder, one per origin, written atomically. They never go in a host's plain settings store; Claude Code's `$.store` is 0644. A token is sent only to the exact origin it was paired with, and never follows a redirect to another origin.
9. **Pairing phishing.** A person talked into approving someone else's code connects that someone's agent to their account. The controls are the approval page's wording, the code's age, and a connection list that is always visible, with Disconnect. In the reverse case, the person's own code approved on someone else's account, two things show it: the connector prints the account name after pairing, and every turn's first line names the asking person.

## 10. Conformance

A connector conforms if it passes the suite (`@plannotator/byoa-conformance`) against the reference app, driven through a fake host with a scripted clock. An app conforms if the reference connector passes the suite against it.

The suite covers at least:

- pairing errors;
- re-register after a 404;
- a duplicate command;
- a held message withdrawn;
- interrupting the connector's own turn only;
- a take-over;
- a `/clear` that changes the session id;
- a subagent turn not counting as busy;
- an immediate re-poll on a state change;
- recovery from a `seq` gap;
- revocation mid-poll;
- two apps sending to one session;
- a hold of 0 with interval polling.

It also checks the needs Machine raised:

- the `say`, `draft_machine` and `get_draft` actions through the proxied tool;
- "waiting for <agent>" until the first poll;
- a stored settings choice that survives a reconnect.

## 11. Not in 0.1

Cut after the implementers' votes, with the reason:

- **Steer and "send now" (`upgrade`).** Three of four never used them. Plannotator needs them, and they can come in 0.2. They are the most host-specific code there is.
- **The loopback grant.** The device grant covers local apps with one code path (Workspaces proved it; Machine voted to cut).
- **A `state` event.** An immediate re-poll does the same job.
- **An on-disk lease and claim per message.** Add them when a duplicate delivery is actually seen.
- **Per-app rate limits.** Only a person's action starts a turn.
- **Connector policy beyond `share`.**
- **An end-of-session call.** Sessions go `gone` after 60 s. Reopened for 0.2: with the real Claude Code plugin on Workspaces staging, a `/clear` left the old session `ready` for about a minute, and a team tab listed two identical agents; a message sent to the old session waited with no end, since that session never polls again.
- **Tool start and end phases.**
- **Sharing one UI stream across tabs.**

Not designed yet:

- starting a new session from the app;
- waking a closed terminal;
- an "any matching session may claim" primitive (AppNotes);
- push transports;
- messages between apps or between agents;
- hosts without a plugin system (Codex, Cursor, Gemini), which get the app's tools over plain MCP and never a wake.

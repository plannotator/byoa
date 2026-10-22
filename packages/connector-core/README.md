# @plannotator/byoa-connector-core

The host-free core of the BYOA connector. One connector runs in each agent host the person uses (a Claude Code mod, a Pi extension, an OpenCode 2 plugin). It serves every app the person paired. This package holds everything that does not depend on the host:

- the pairing client (RFC 8628 device grant against an app's `pair_start` and `pair_poll`);
- the credential files;
- the session doors (register, poll, events) for each app and each session;
- the turn scheduler (one app turn at a time per session, in arrival order across apps);
- the provenance line;
- the proxied MCP tool, one per app;
- the `/byoa` commands.

A host adapter is thin. It supplies the ports, reports its host's turn events, and does what the core asks. The wire is in [docs/SPEC.md](../../docs/SPEC.md); its types and parsers are in `@plannotator/byoa-protocol`.

## Copying into a host

A Claude Code mod can import only its own folder and has no Node. So:

- `src/` imports nothing outside itself except `@plannotator/byoa-protocol`, and only `src/protocol.ts` does that, with one line: `export * from "@plannotator/byoa-protocol";`. A sync script copies `connector-core/src/*` and `protocol/src/*` into the mod. It then rewrites that one line to the copied protocol, for example `export * from "../protocol/index.ts";` (see `connectors/claude-code/scripts/sync-core.mjs`).
- No file uses a Node module or a global beyond the language, `URL` and `JSON`. That means no `fetch`, timers, `TextEncoder` or `crypto`. All I/O goes through the ports. `test/purity.test.ts` enforces both rules.

## The adapter interface

These are in `src/host.ts`.

```ts
interface HostAdapter {                 // one per host process
  host: HostId; hostVersion?: string; machineName?: string;
  isInteractive(): boolean;             // false for -p / RPC / SDK runs: nothing registers
  display(d: { band: string | null; toast?: { text; level } }): void;
}

interface HostSession {                 // one per live conversation (OpenCode: one per session)
  hostSessionId(): string | null;       // re-read every tick; a change (/clear) retires and re-registers
  workspace(): Workspace | Promise<Workspace>;   // all it knows; sharing filters per app
  busy(): boolean;                      // a main-loop turn runs or a prompt waits; never subagents
  blocked(): boolean;                   // a permission prompt waits
  submit(text: string): Promise<void>;  // resolves when the host took it
  abort?(): Promise<void>;              // abort the running turn (only ever ours)
  settings?(): SessionSetting[];        // { id, name, value | null, choices }
  applySetting?(id: string, value: string): Promise<void>;
}

interface SessionHandle {               // returned by connector.attach(session)
  turnStarted(prompt: string): boolean; // true when the prompt is (or wraps) our submitted text
  delta(text: string): void;
  tool(name: string, title?: string): void;     // at tool start; title is a fixed label, never input
  turnEnded(outcome: "done" | "error" | "interrupted", reason?: string): void;
  foreignPrompt(prompt?: string): boolean;      // a prompt was announced (Enter): silences our turn
  takenOver(): void;                    // that prompt joined our turn: interrupted, taken_over
  isOurs(prompt: string): boolean;
  tools(): Promise<ProxiedTool[]>;      // one per app with MCP; built once, fixed for the handle
  detach(): void;                       // the conversation ended for good
}
```

The adapter reports every main-loop turn. The core keeps only the turns it started, matched by the text it submitted ("contains", because Claude Code wraps a plugin prompt in its own frame). Deltas and tool steps of any other turn are dropped.

## Ports

These are in `src/ports.ts`.

- `HttpPort(request) → { status, text, headers, url? }`: whole bodies. It may abort at 30 s, as Claude Code's `$.http.fetch` does. It MUST NOT follow redirects. Several requests run at once: one held poll per app per session, plus events and tool calls. The core never chooses a hold. It relies on the app's `poll_hold_seconds` (at most 25), or polls every `poll_interval_seconds` when the hold is 0.
- `FilePort`: `read(path) → { text, mode } | null`, `writePrivate(path, text)` (0700 folder, 0600 file, temporary name, then rename), `remove(path)`, `list(dir)`.
- `Clock`: milliseconds since the epoch.
- The tick: the core holds no timer. The adapter calls `connector.tick()` about every second. A Claude Code mod does all background work from one `$.clock.every`.

## Files under ~/.byoa

| Path | What | Rules |
| --- | --- | --- |
| `credentials/<host>/<origin-key>.json` | One per agent host and paired app origin: Claude Code and Pi on one machine are two connections (SPEC 4.1). It holds the token, the connection id, the account name, the app's id and name from pairing, and its discovery document. `<origin-key>` is the origin with `://` and other non-name characters replaced by `_`, for example `https_workspaces.example` or `http_127.0.0.1_4100`. | Written 0600 in a 0700 folder, atomically. A file with any group or other bits is refused and named in status. The origin inside must match the file name. |
| `policy.json` | The one setting: which workspace fields each app is sent. `{ "share": { "<app id>": ["folder_name", "git_remote", "branch", "path"], "*": [...] } }`. The default is `["folder_name", "git_remote"]`. | A file other users can write, or one that does not parse, shares nothing, and status says so. It is read again every 30 s and on `status`. |

## Commands

`connector.command(args)` returns the text to show. It is the same as `connect(address)`, `disconnect(app)` and `status()`.

- `connect <address>`: `workspaces.example`, `https://…`, or `127.0.0.1:4100` (plain http only to 127.0.0.1, localhost or [::1]). It fetches `/.well-known/byoa`, starts the device grant, and polls once at once. If the app approved immediately (a local app), it answers just "connected to <app> as <name>". Otherwise it shows the link and code, and names the origin.
- `disconnect <app id | name | origin>`: stops the app's links, revokes the token, and removes the file. If the app cannot be reached, the token stays, and the text says so.
- `status`: one line per app, with this session's state, pairings in progress, and file problems.

## Wiring an adapter (sketch)

```ts
import { Connector, COMMAND } from "./byoa/core/index.ts";

const connector = new Connector({ host: adapter, http, files, now: () => Date.now(), home });
await connector.start();

const handle = connector.attach({
  hostSessionId: () => $.session.id ?? null,
  workspace: async () => ({ folder_name: basename(cwd), path: cwd, git_remote: await gitRemote(cwd), branch: await gitBranch(cwd) }),
  busy: () => mainTurnRunning || $.prompt.queued() > 0,
  blocked: () => permissionPromptOpen,
  submit: (text) => $.prompt.submit({ text }),       // never asUser
  abort: () => $.turn.abort(),
});

for (const tool of await handle.tools()) $.tool.register(tool.name, tool.description, tool.inputSchema, (input) => tool.call(input));
$.command.register(COMMAND.slice(1), (args) => connector.command(args));
$.clock.every(1_000, () => connector.tick());

$.on("prompt.submit", (e) => { if (handle.foreignPrompt(e.text)) pendingForeign = true; });
$.on("turn.start", (e) => { if (!e.agentId) mainTurnRunning = true, handle.turnStarted(e.prompt); });
$.on("turn.step", (e) => {
  if (e.agentId) return;
  if (pendingForeign && e.promptJoined) { pendingForeign = false; handle.takenOver(); }
  for (const part of e.text ?? []) handle.delta(part);
  for (const t of e.toolStarts ?? []) handle.tool(t.name, t.label);
});
$.on("turn.complete", (e) => { if (!e.agentId) mainTurnRunning = false, handle.turnEnded(e.aborted ? "interrupted" : e.error ? "error" : "done"); });
$.on("session.end", () => handle.detach());
```

The event names above are illustrative. Each host has its own; see `docs/design.md` for the per-host calls.

## Not in 0.1

These follow SPEC 11: steer and `upgrade`, the loopback grant, `state` events, the on-disk lease and claims, per-app rate limits, policy beyond `share`, the `DELETE` session call, and tool phases.

Two processes on one session rely on the app handing each message to one poll. Polls that keep being superseded back off from 1 to 30 s, and status says why.

## Tests

`node --test packages/connector-core/test/*.test.ts` and `npx tsc -p packages/connector-core`, from the repo root. They use a fake host, fake apps on an in-memory network, an in-memory FilePort and a scripted clock. There are no sleeps and no sockets.

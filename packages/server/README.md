# @plannotator/byoa-server

The app side of BYOA (Bring Your Own Agent). Mount it on a web app's server so that the person's own coding agent (Claude Code, Pi or OpenCode, through a BYOA connector) can pair with the app, receive the app's messages as turns, and stream the turn's events back to the app's chat UI.

It is a single fetch-API handler. It uses only Web standard APIs (`Request`, `Response`, `ReadableStream`, Web Crypto), so it runs on Node, Bun, Deno and Cloudflare Workers. Its only dependency is `@plannotator/byoa-protocol`. The wire is in [docs/SPEC.md](../../docs/SPEC.md).

## Usage

```ts
import { createByoa } from "@plannotator/byoa-server";

const byoa = createByoa({
  app: { id: "acme", name: "Acme", origin: "https://acme.example" },
  // The app's own signed-in person. BYOA never accepts a bearer token here.
  authenticate: async (req) => {
    const user = await getSignedInUser(req);
    return user ? { userId: user.id, displayName: user.name } : null;
  },
  mcpPath: "/mcp", // optional: advertised in discovery
});
```

`byoa.handle(req)` answers `/.well-known/byoa` and everything under `/byoa/`. It returns `null` for any other path.

Hono:

```ts
app.all("/.well-known/byoa", (c) => byoa.handle(c.req.raw));
app.all("/byoa/*", async (c) => (await byoa.handle(c.req.raw)) ?? c.notFound());
```

Bun or Deno:

```ts
Bun.serve({ fetch: async (req) => (await byoa.handle(req)) ?? new Response("Not found", { status: 404 }) });
```

Node `http`: convert the request to a `Request`, or use an adapter such as `@hono/node-server`, which does that for you:

```ts
import { serve } from "@hono/node-server";
serve({ fetch: async (req) => (await byoa.handle(req)) ?? new Response("Not found", { status: 404 }), port: 3000 });
```

## The doors

| Who | Door | |
| --- | --- | --- |
| anyone | `GET /.well-known/byoa` | Discovery. |
| connector | `POST /byoa/pair/start`, `POST /byoa/pair/poll` | The device grant (RFC 8628). |
| person | `GET /byoa/connect`, `POST /byoa/connect` | The approval page. |
| connector | `POST /byoa/revoke` | The token ends itself. |
| connector | `POST /byoa/sessions`, `.../{id}/poll`, `.../{id}/events` | Register, long-poll, events. |
| person | `GET /byoa/ui/events` | One SSE stream per tab: the session list and every message's events. |
| person | `GET /byoa/ui/sessions` | The person's connections and their sessions. |
| person | `POST /byoa/ui/sessions/{id}/messages` | `{ text, kind?, interrupt_first?, stream?, set? }` → `202 { message_id }`. |
| person | `POST /byoa/ui/sessions/{id}/messages/{mid}/interrupt` | `{ outcome: withdrawn \| interrupt_sent \| already_finished }`. |
| person | `DELETE /byoa/ui/connections/{id}` | Disconnect. |

- Connector doors accept only a BYOA connection token. They refuse any request that has an `Origin` header, because a connector is never a browser page.
- UI doors accept only the person's session. A POST or DELETE needs a CSRF check. By default, `Origin` must equal `app.origin`. You can replace the check with `checkCsrf`.
- UI doors refuse any request that has an `Authorization` header, the connection's own token included. So no token can start a turn (SPEC 9.1, 9.2).

## Server-side calls

- `byoa.send(userId, sessionId, { text, kind?, interruptFirst?, stream?, set?, from? })` queues a message from your own server code, for example a hand-off. It follows the same rules as the UI door, and `kind` defaults to `task`. Call it only from an action of that person (SPEC 9.1). Use it also when your app writes the turn's text itself, for example from ids in your own UI.
- `byoa.subscribe(userId, listener)` gives the events the UI stream carries. First you get the session list and every open message so far, then live events. `ui/events` is a thin SSE wrapper over it. A per-send stream could be one too.
- `byoa.sessions(userId)` gives the person's connections, each with its sessions.
- `byoa.revoke(connectionId)` disconnects a connection. Its held polls answer 401 at once, and its open messages end `gone` with reason `disconnected`.
- `byoa.verifyBearer(req, { sessionId? })` is for your MCP server. The connector mounts your MCP endpoint with the same connection token (SPEC 7), so your MCP server calls this to accept that token and learn the person and the connection. If you pass `_meta["dev.byoa/session"]`, it returns the `sessionId` only when that session belongs to this connection.

## Options

- `pollHoldSeconds` defaults to 20. Set it to 0 to answer every poll at once, for platforms that bill held requests. Discovery then names a 5 s poll interval.
- `limits` sets `sessionsPerConnection` (default 64), `bufferedEventsPerMessage` (default 4096) and `seqLookAhead` (default 256).
- `clock` replaces time and timers. Tests use it.
- `renderPage(page, req)` draws the approval page in your own layout. See "Your own approval page".
- `autoApprove(client)` is only for a local app that has no accounts and runs on a loopback origin. It approves every pairing at once as the person it returns, with no page, so the connector's first `pair_poll` collects the token (Machine's `machine login http://localhost:7420`). `createByoa` refuses it on any other origin. Any process that runs as the person on that machine can then pair. Do not use it on a server that has users.

## Your own approval page

The approval page at `/byoa/connect` has seven states: `entry`, `invalid`, `signIn`, `expired`, `consent`, `connected` and `cancelled`. To draw them in your own layout, pass `renderPage`. It gets the state as data and the request, and returns a `Response`. Return `null` or `undefined` to use the built-in page for that state.

```ts
import { createByoa, grantSentence } from "@plannotator/byoa-server";

const byoa = createByoa({
  // ...
  renderPage: (page, req) => {
    if (page.state !== "consent") return null; // the built-in page
    return new Response(renderConsent(page), {
      status: page.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
});
```

The hook only draws. Every check stays in the SDK: the signed-in session, the Origin check, the CSRF token and its timing-safe compare, the one decision that wins, and the one `invalid` state for unknown, expired, cancelled and used codes. Its data is the same whichever it is.

Your page must:

- escape everything in `page`: the values are raw, as the person or the agent supplied them;
- on `consent`, POST to `page.formAction` with exactly the fields in `page.form`: `code` = `page.userCode`, `csrf` = `page.csrfToken`, and `decision` = `connect` or `cancel`;
- keep the controls against pairing phishing (SPEC 9.9): show the code and its age (`ageSeconds`), the account (`accountName`), the machine marked unverified (`machineName`, `machineVerified: false`), and the sentence that says what connecting grants (`page.grant`, or `grantSentence(page)` for the same words);
- send `page.status`.

If your response lacks the built-in pages' security headers (`Content-Security-Policy`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`), the SDK adds the missing ones. It never replaces a header you set. The added CSP is `default-src 'none'` with inline style only, so set your own if the page loads stylesheets or fonts.

## Storage, and running more than one instance

The store has two halves (`store.ts`):

- **Durable records:** pairings and connections. A connection is its id, the person, the host, the machine name, the token's SHA-256 hash, and the created, revoked and last-seen times. Put these in your database. `memoryStore()` keeps them in process memory, which suits a local app or tests. With `memoryStore()`, a restart disconnects every agent.
- **The live hub, one per person:** registered sessions, waiting messages, held polls, event buffers and listeners. It is memory only by design. After a restart, the connector's next poll gets `404`, and the connector registers again under the same session id.

A hub needs **a single writer per person**: every request for one person must reach the same hub. One process meets that by itself. A multi-instance deployment must route each person to one place. Examples are a Cloudflare Durable Object per person, as Workspaces' `AgentSessionsDO` does, or sticky routing by user id. The `Hub` interface takes and returns plain data and one listener callback. So a Durable Object adapter is a thin wrapper: the object holds a `SessionHub`, and `store.hub(userId)` returns a stub that forwards each call over RPC. Workers RPC can pass the listener as a function stub. This package does not include that adapter.

## Testing your store

`@plannotator/byoa-server/conformance` is a suite of cases you run against your own `ByoaStore`, for example your database plus a Durable Object per person. Each case builds a real app with `createByoa` and drives it through `byoa.handle`: it pairs through the real doors, registers, polls, posts events, sends, interrupts and revokes. It also calls the store directly where a method promises something the doors cannot show, such as one `decide` winning or `collect` being atomic. It uses no Node API and no test runner, so it runs in Node, Bun, Deno and workerd.

```ts
// node:test
import { test } from "node:test";
import { storeConformance } from "@plannotator/byoa-server/conformance";

for (const c of storeConformance(make)) test(c.name, c.run);
```

```ts
// vitest
import { test } from "vitest";
import { storeConformance } from "@plannotator/byoa-server/conformance";

for (const c of storeConformance(make)) test(c.name, c.run);
```

`make` is called once per case:

```ts
const make = async () => ({
  store: await myStore(),
  // Optional: a store over the same durable data. Its hubs may or may not
  // have kept live state (a restart, an eviction, a fresh stub).
  restart: () => myStore(),
  // Optional: runs after the case, pass or fail.
  cleanup: () => dropTestRows(),
});
```

- **The clock.** Cases script time with a `FakeClock`, which `createByoa` passes to `store.hub(userId, config)` as `config.clock`. Your hub must take all time and timers from `config.clock`, and its poll hold from `config.pollHoldMs`, so a Durable Object adapter has to pass the clock through in tests. If your hub uses real time, pass `{ timing: false }` to leave out the cases that need scripted time.
- **Restart.** With `restart`, the suite checks that connections and pairings survive, that the token still authenticates, and that re-register returns the same session id. The hub may have forgotten the session (the next poll answers `404 session_not_found`) or kept it. Without `restart`, those cases check nothing.
- Each case uses its own user ids, so a shared test database works.
- Do not fake the runner's global timers (`vi.useFakeTimers()`). The suite yields to zero-delay timers so that requests in flight can finish.

## What the app still owns

- Rate limits on `pair/start` (no credential) and on looking up codes on `/byoa/connect`.
- The text of a turn. It carries only the person's own words and ids, never content other people wrote (SPEC 5.3).
- A visible list of connections with Disconnect (SPEC 9.9).

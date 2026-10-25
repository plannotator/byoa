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
| person | `POST /byoa/ui/sessions/{id}/messages` | `{ text, kind?, interrupt_first?, stream?, set? }` → `202 { message_id }`. With `prepareSend`, any JSON body your hook reads. |
| person | `POST /byoa/ui/sessions/{id}/messages/{mid}/interrupt` | `{ outcome: withdrawn \| interrupt_sent \| already_finished }`. |
| person | `DELETE /byoa/ui/connections/{id}` | Disconnect. |

- Connector doors accept only a BYOA connection token. They refuse any request that has an `Origin` header, because a connector is never a browser page.
- UI doors accept only the person's session. A POST or DELETE needs a CSRF check. By default, `Origin` must equal `app.origin`. You can replace the check with `checkCsrf`.
- UI doors refuse any request that has an `Authorization` header, the connection's own token included. So no token can start a turn (SPEC 9.1, 9.2).

## Server-side calls

- `byoa.send(userId, sessionId, { text, kind?, interruptFirst?, stream?, set?, from? })` queues a message from your own server code, for example a hand-off. It follows the same rules as the UI door, and `kind` defaults to `task`. Call it only from an action of that person (SPEC 9.1). Use it also when your app writes the turn's text itself, for example from ids in your own UI.
- `byoa.subscribe(userId, listener, onEnd?)` gives the events the UI stream carries. First you get the session list and every open message so far, then live events. It returns the unsubscribe function. `onEnd` is called once if the hub can no longer deliver (see the Durable Object note below); subscribe again to get a fresh list. `ui/events` is a thin SSE wrapper over it, and closes the tab's stream on `onEnd`, so the browser's `EventSource` reconnects. A per-send stream could be one too.
- `byoa.sessions(userId)` gives the person's connections, each with its sessions.
- `byoa.revoke(connectionId)` disconnects a connection. Its held polls answer 401 at once, and its open messages end `gone` with reason `disconnected`.
- `byoa.verifyBearer(req, { sessionId? })` is for your MCP server. The connector mounts your MCP endpoint with the same connection token (SPEC 7), so your MCP server calls this to accept that token and learn the person and the connection. If you pass `_meta["dev.byoa/session"]`, it returns the `sessionId` only when that session belongs to this connection.

## Options

- `pollHoldSeconds` defaults to 20. Set it to 0 to answer every poll at once, for platforms that bill held requests. Discovery then names a 5 s poll interval.
- `limits` sets `sessionsPerConnection` (default 64), `bufferedEventsPerMessage` (default 4096) and `seqLookAhead` (default 256).
- `clock` replaces time and timers. Tests use it.
- `renderPage(page, req)` draws the approval page in your own layout. See "Your own approval page".
- `prepareSend(input)` writes the turn's text on your server for the UI send door. See "Writing the turn on your server".
- `onError(error, req)` is called with every caught failure before the 500 answer: a door that threw, and a throw in `renderPage`, `prepareSend` or `onRegistered`. You get your own `req`; the SDK sends the request's body and headers nowhere else. A throw inside `onError` is caught and ignored. Without `onError`, the SDK writes the error's message with `console.error`.
- `onRegistered(userId, session)` is called after the hub accepts a register, re-registers included. `session` is the session as `byoa.sessions` shows it (with `machine_name`), as a copy. The register answer is decided and serialised first, so the hook cannot change it, and the SDK then awaits the hook before answering: on Workers the SDK has no `waitUntil`, and work left running after the answer may be cut off. So keep it quick, or hand slow work to your own `ctx.waitUntil`. A throw goes to `onError` and never fails the register.
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

## Writing the turn on your server

By default the send door reads `{ text, kind?, interrupt_first?, stream?, set? }` from the browser. To write the turn's text on your server instead, for example from ids the page sends, pass `prepareSend`:

```ts
const byoa = createByoa({
  // ...
  prepareSend: async ({ userId, displayName, sessionId, body, req }) => {
    const { docId, question } = body as { docId?: unknown; question?: unknown };
    if (typeof docId !== "string" || typeof question !== "string") return new Response("Bad request", { status: 400 });
    if (!(await canRead(userId, docId))) return new Response("Not found", { status: 404 });
    return { text: `${question}\n\nDocument: ${docId}`, kind: "chat" };
  },
});
```

- The door first makes every check it makes today: the person's session, CSRF, no `Authorization` header, the 128 KiB body limit and the JSON parse. Only then does it call the hook, with the parsed body, which nothing else has checked.
- Return a `PreparedSend` (`{ text, kind?, interruptFirst?, stream?, set?, from? }`, the shape of `byoa.send`). The door checks it under its usual rules (the text limits, `kind`, the session's settings) and sends it as it sends any message. `kind` defaults to `chat` and `from` to the person's name.
- Return a `Response` to answer yourself. It is sent as is, and nothing is queued.
- A throw goes to `onError` and answers `500 server_error`.
- You own what the text says: only the person's own words and ids, never content other people wrote, such as titles, paths or comment bodies (SPEC 5.3). The agent reads those through your tools.

## Storage, and running more than one instance

The store has two halves (`store.ts`):

- **Durable records:** pairings and connections. A connection is its id, the person, the host, the machine name, the token's SHA-256 hash, and the created, revoked and last-seen times. Put these in your database. The last-seen time is written at register and at most once a minute per connection on poll, also when you build `createByoa` and your store for each request: the throttle is per isolate, keyed by `app.origin` and the connection id. `memoryStore()` keeps them in process memory, which suits a local app or tests. With `memoryStore()`, a restart disconnects every agent.
- **The live hub, one per person:** registered sessions, waiting messages, held polls, event buffers and listeners. It is memory only by design. After a restart, the connector's next poll gets `404`, and the connector registers again under the same session id.

A hub needs **a single writer per person**: every request for one person must reach the same hub. One process meets that by itself. A multi-instance deployment must route each person to one place. Examples are a Cloudflare Durable Object per person, or sticky routing by user id. The `Hub` interface takes and returns plain data and one listener callback. So a Durable Object adapter is a thin wrapper: the object holds a `SessionHub`, and `store.hub(userId)` returns a stub that forwards each call over RPC.

For `subscribe`, have the object return a `ReadableStream` of events over RPC, and read it in the Worker, calling the listener for each event. When the read fails or ends (the object was reset or evicted), call `onEnd`, the second argument of `Hub.subscribe`. The SDK then closes that tab's UI stream, and the browser reconnects and gets a fresh session list. Prefer this to passing the listener as a function stub: a stub held by an object that was reset just stops being called, with no signal to either side. This package does not include that adapter.

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
- The text of a turn, whether `byoa.send`, `prepareSend` or the browser writes it. It carries only the person's own words and ids, never content other people wrote (SPEC 5.3).
- A visible list of connections with Disconnect (SPEC 9.9).

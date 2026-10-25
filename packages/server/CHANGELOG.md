# Changelog


## 0.1.2

- Fix: pressing Connect on the approval page failed in real browsers. The built-in page sent `Referrer-Policy: no-referrer`, so a browser posted the form with `Origin: null`, and the default CSRF check, which wanted `Origin` equal to `app.origin`, refused every press. The pages now send `Referrer-Policy: same-origin`, and the default check also passes a POST or DELETE whose `Origin` is `null` or missing when the browser says `Sec-Fetch-Site: same-origin`. A custom page that keeps `no-referrer` works too. Both paths are proven by pressing Connect in Chromium.
- `storeConformance(factory, { settle })`: how to let a store's pending I/O finish before scripted time moves. The default suits an in-memory store; a store with a database round trip passes a longer one. `FakeClock` takes the same function as its second argument.
- Fix: the router decoded each path segment, so `/byoa/pair/%73tart` reached the start door while skipping any check the host keyed on the literal path (a rate limit, a CSRF rule). No BYOA path needs percent-encoding, so a path under `/byoa/` with a `%` now answers 404 and is never decoded. SPEC 2 says so.
- The approval page names a declared host only from its own table. A connector that declared `constructor` showed Object's function as its name; it now shows `constructor`.
- The conformance suite no longer compares `user_code_hash` on a read-back pairing. The server never reads it back, so a store may keep it hashed under its own pepper or clear it on decide.

## 0.1.1

Every change is additive. An app written for 0.1.0 works unchanged.

- `renderPage(page, req)`: draw the approval page at `/byoa/connect` in your own layout. It gets each of the seven states as raw data and returns a `Response`, or null for the built-in page. Every check stays in the SDK, and missing security headers are added.
- `grantSentence(page)`: the words that say what connecting grants, for your own consent page.
- `@plannotator/byoa-server/conformance`: `storeConformance(factory, { timing? })`, cases you run against your own `ByoaStore` in any test runner, in Node or workerd.
- `prepareSend(input)`: the UI send door hands its parsed body to your server after its own checks. Return a `PreparedSend`, which is checked and sent under the door's rules, or a `Response` to send as is.
- `Hub.subscribe(listener, onEnd?)` and `byoa.subscribe(userId, listener, onEnd?)`: a hub calls `onEnd` when it can no longer deliver. The UI stream then closes cleanly, so the browser reconnects and gets a fresh session list. A hub whose `subscribe` throws or rejects now ends the stream the same way.
- The last-seen throttle is module level, keyed by `app.origin` and the connection id, so an app that builds `createByoa` per request still writes `connections.touch` at most once a minute per connection. The map is pruned past 4096 entries.
- `onError(error, req)`: every caught failure, before the 500, including a throw in `renderPage`, `prepareSend` or `onRegistered`. `console.error` is used only without it.
- `onRegistered(userId, session)`: called after every accepted register, awaited before the answer, with errors sent to `onError`.
- The dependency on `@plannotator/byoa-protocol` is now a caret range (`^0.1.0`).

## 0.1.0

- First release.

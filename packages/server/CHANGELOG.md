# Changelog

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

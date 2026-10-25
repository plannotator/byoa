# Changelog

## 0.1.2

- Fix: the sharing settings were a plain object keyed by app id. An app whose id names an `Object.prototype` member (`constructor`, `toString`) got a function back, and its sessions failed to register. A `"__proto__"` key in `~/.byoa/policy.json` replaced the table's prototype. They are a `Map` now, so every id is just a key. Neither case could widen what is shared.
- `connector_version` is now `0.1.2`.

## 0.1.1

- The tools/list cache. Each app's last successful `tools/list` is kept in `~/.byoa/tools/<host>/<origin-key>.json` (0600 in a 0700 folder). If the list fails at session start after one quick retry, as during an app deploy, the session uses the cached list instead of having no tool for that app, and status says "tools from cache". Calls still go to the live app, and the tool is byte for byte the one a fresh equal list gives. The file is removed on disconnect and when the token is revoked.
- `connector_version` is now `0.1.1`.
- `@plannotator/byoa-connector-core/testing`: a test kit to drive the real connector against a real app with no agent. A fake host and session that can play a turn (`startTurn`, `text`, `tool`, `end`, `takeOver`), an in-memory `FilePort`, `fetchHttp` (an `HttpPort` over any fetch-like function, such as a Worker's `SELF.fetch`), a scripted and a real clock, and `pairByPage`, which pairs through the approval page. It uses no Node API, so it runs in workerd. The Claude Code plugin does not copy it.
- The dependency on `@plannotator/byoa-protocol` is now a caret range (`^0.1.0`).

## 0.1.0

- First release.

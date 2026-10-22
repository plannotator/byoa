# @plannotator/byoa-opencode

The BYOA (Bring Your Own Agent) connector for OpenCode 2. It connects your running OpenCode sessions to every BYOA app you pair. Once you connect an app, its chat can start turns in a session your terminal UI shows, and OpenCode can use the app's tools as you. The wire is in [docs/SPEC.md](../../docs/SPEC.md).

It is an OpenCode 2 plugin in two halves:

- `@plannotator/byoa-opencode` (also `@plannotator/byoa-opencode/server`): the server plugin. It holds the connector, one per project folder.
- `@plannotator/byoa-opencode/tui`: the TUI plugin. It binds `/byoa`, shows the connector's band and toasts, and tells the server half which sessions are on screen.

Only sessions that a terminal UI shows register. `opencode run` and a bare `opencode serve` register nothing, and subagent sessions never register.

## Install

```
opencode plugin add @plannotator/byoa-opencode
```

That installs the package and adds it to the `plugins` list of your global configuration. You can also add `"@plannotator/byoa-opencode"` to `plugins` yourself. From a clone of this repository, put the folder path in `plugins` instead: `"plugins": ["/path/to/byoa/connectors/opencode"]`.

## Use

```
/byoa connect <address>      e.g. /byoa connect workspaces.example, or http://localhost:4100
/byoa status                 each app, this session's state, pairings in progress
/byoa disconnect <app>       revokes the token and removes it from this machine
```

`connect` pairs with a device code: the app shows the code on its own page, and you approve it there while signed in. The answer and the pairing code show as toasts.

## What connecting grants

- The app can start turns in the sessions your terminal UI shows. Each turn starts with a line the app cannot forge, such as `[BYOA] Notes (localhost:4100) · chat from Ramos · msg_…`.
- OpenCode can use the app's tools as you, through one tool per app.
- An app can set the model before its turn.
- The plugin never answers a permission prompt.
- It sends the app the folder name and the git remote (host and path only), and never the path, unless `~/.byoa/policy.json` says otherwise.

Tokens live in `~/.byoa/credentials/`, mode 0600 in a 0700 folder. The Claude Code and Pi connectors use the same files.

## Develop

```
node --test test/*.test.ts      # the plugin against fake apps
node scripts/live.ts            # the live proof: real OpenCode 2 in a pty, two demo apps
```

`scripts/live.transcript.txt` is the last live run. `server.ts` and `tui.ts` sit at the package root because OpenCode loads a plugin folder by path as `<folder>/server` and `<folder>/tui`.

## Licence

MIT OR Apache-2.0.

# @plannotator/byoa-pi

The BYOA (Bring Your Own Agent) connector for Pi. It connects your running Pi session to every BYOA app you pair. Once you connect an app, its chat can start turns in your interactive Pi session, and Pi can use the app's tools as you. The wire is in [docs/SPEC.md](../../docs/SPEC.md).

It is a Pi extension. It runs only in the interactive TUI. A print, JSON or RPC run (`pi -p` and the like) never pairs, registers or polls.

## Install

```
pi install npm:@plannotator/byoa-pi
```

For one run only: `pi -e npm:@plannotator/byoa-pi`. From a clone of this repository: `pi -e ./connectors/pi/src/index.ts`.

## Use

```
/byoa connect <address>      e.g. /byoa connect workspaces.example, or http://localhost:4100
/byoa status                 each app, this session's state, pairings in progress
/byoa disconnect <app>       revokes the token and removes it from this machine
```

`connect` pairs with a device code: the app shows the code on its own page, and you approve it there while signed in. A `byoa` widget names the connected apps, or shows the code while a pairing waits.

## What connecting grants

- The app can start turns in your interactive Pi session. Each turn starts with a line the app cannot forge, such as `[BYOA] Notes (localhost:4100) · chat from Ramos · msg_…`.
- Pi can use the app's tools as you, through one tool per app.
- An app can set the model and the thinking level before its turn.
- The extension never answers a permission prompt and never steers a turn.
- It sends the app the folder name and the git remote (host and path only), and never the path, unless `~/.byoa/policy.json` says otherwise.

Tokens live in `~/.byoa/credentials/`, mode 0600 in a 0700 folder. The Claude Code and OpenCode connectors use the same files.

## Develop

```
node --test test/*.test.ts      # the extension against fake apps
node scripts/live.ts            # the live proof: real Pi in a pty, two demo apps
```

`scripts/live.transcript.txt` is the last live run.

## Licence

MIT OR Apache-2.0.

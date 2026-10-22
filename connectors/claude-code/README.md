# byoa: the BYOA connector for Claude Code

BYOA ("Bring Your Own Agent") lets a web app use the coding agent you already run. This plugin connects Claude Code to any number of BYOA apps. Once you connect an app, its chat can start turns in your interactive Claude Code session, and Claude can use the app's tools as you. The wire is in [docs/SPEC.md](../../docs/SPEC.md).

It is a Claude Code mod: a hooks module, for Claude Code 2.1.306 or later, in interactive sessions only. A `-p` run or an Agent SDK host gets nothing from it.

## Install

From a clone of this repository:

```
/plugin marketplace add <path or git URL of connectors/claude-code>
/plugin install byoa@byoa
```

For one session only: `claude --plugin-dir connectors/claude-code`.

## Use

```
/byoa connect <address>      e.g. /byoa connect workspaces.example, or http://localhost:4100
/byoa status                 each app, this session's state, pairings in progress
/byoa disconnect <app>       revokes the token and removes it from this machine
```

`connect` pairs with a device code: the app shows the code on its own page, and you approve it there while signed in. A local app with no accounts may approve at once. The band above the prompt names the connected apps, or shows the code while a pairing waits.

An app connected during a session can start turns at once. Its tool arrives with the next session (after `/clear`, or a new `claude`), because each session's tool list is fixed when it starts.

## What connecting grants

- The app can start turns in this agent's interactive sessions. Each turn starts with a line the app cannot forge: `[BYOA] Notes (localhost:4100) · chat from Ramos · msg_…`.
- Claude can use the app's tools as you, through one tool per app (`mcp__byoa__<app id>`). Every call goes through your permission rules and prompts like any other tool. A session in auto mode, or one that skips prompts, acts on whatever the apps return, and one app's tool results can steer Claude into another app's tools.
- The plugin never answers a permission prompt and never aborts a turn it did not start.
- It sends the app the folder name and the git remote (as `host/path`, without any user or password in the URL), and never the path, unless `~/.byoa/policy.json` says otherwise. Only the app's own turns stream back: visible text and tool names, never thinking, tool input or output, or a subagent's steps. If you type into an app's turn, nothing more streams and the app sees `interrupted` (`taken_over`).

Tokens live in `~/.byoa/credentials/<origin>.json`, mode 0600 in a 0700 folder, written atomically by a `/bin/sh` child under `umask 077`. They are never put in Claude Code's plugin store, which is a 0644 file.

## Layout

| Path | What |
| --- | --- |
| `hooks/register.ts` | The adapter: the core's ports, Claude Code's turn events, the `/byoa` command, the band, the proxied tools. Every `$` call is here. |
| `hooks/turns-match.ts` | Which turn is ours, and which prompts take it over. |
| `hooks/permission.ts` | How a proxied tool call learns that the permission check allowed it. |
| `hooks/shell.ts` | The credential file shell-outs. |
| `hooks/workspace.ts`, `hooks/settings.ts` | The workspace fields; the model and effort settings (through `/model` and `/effort`). |
| `hooks/core/` | Generated: copies of `packages/protocol/src` and `packages/connector-core/src`. A mod can import only its own folder. Run `node scripts/sync-core.mjs`; never edit the copies. |
| `tests/*.test.ts` | `claude plugin test`: the adapter against a scripted app, and the pure helpers. |
| `tests/node/*.test.mjs` | `node --test`: the shell-outs run for real, and the sync check. |
| `scripts/live.py` | The live proof: real Claude Code in a pty, two demo apps (`scripts/live-transcript.txt` is the last run). |

## Develop

```
node scripts/sync-core.mjs            # after any change to packages/protocol or packages/connector-core
node --test tests/node/*.test.mjs     # shell-outs, sync --check
claude plugin test .                  # the adapter, under Claude Code's test kit
claude plugin validate --strict .
python3 scripts/live.py               # from the repo root: the live proof (moves ~/.byoa aside, then restores it)
```

Type-checking (`tsc -p .`) needs the declarations Claude Code writes into `.claude-plugin/types/` the first time it loads the plugin with `--plugin-dir` in an interactive session.

## Limits of the Claude Code API

- `$.http.fetch` follows redirects and cannot be told not to. On a redirect to another origin it drops `Authorization`, so the token does not follow, but the final URL is not reported, so the core cannot check it.
- A hook that answers a registered tool skips the permission check. This plugin calls `next(e)` first and reads the outcome from core's answer (`hooks/permission.ts`). If a newer Claude Code words that answer differently, proxied tools refuse every call (they fail closed) until the plugin is updated.
- Claude Code raises its `permission_prompt` notification a few seconds after the prompt appears, so the app sees `blocked` a few seconds late.
- No hook reports the choice made in the bare `/model` picker, so a setting's value is `null` unless this plugin set it or you typed `/model <name>`.
- A registered tool stays registered for the life of the process. The tool of an app that was disconnected answers with a refusal.

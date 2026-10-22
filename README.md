# BYOA: Bring Your Own Agent

A protocol and SDK toolkit that lets any web app use the coding agent you already run (Claude Code, Pi or OpenCode) as that app's agent. You connect your agent once. The app's chat then talks to your running session, your agent uses the app's tools, and the app can hand it work. The app runs no model and pays for no inference.

Status: draft 0.1. The packages are on npm as `@plannotator/byoa-*` 0.1.0. Every piece below has been run against real hosts (see [docs/PROOF.md](docs/PROOF.md)). Machine is the first product to run on it. The 70-second launch film is attached to the [v0.1.0 release](https://github.com/plannotator/byoa/releases/tag/v0.1.0).

## The pieces

| Path | What it is |
| --- | --- |
| [`docs/design.md`](docs/design.md) | Why BYOA exists, what four earlier implementations taught, the decisions |
| [`docs/SPEC.md`](docs/SPEC.md) | The wire, draft 0.1 |
| [`docs/REVIEW.md`](docs/REVIEW.md) | Two review rounds with the four implementers, and what each changed |
| [`packages/protocol`](packages/protocol) | The wire's types and parsers. Pure TypeScript, no dependencies |
| [`packages/server`](packages/server) | `@plannotator/byoa-server`: what an app mounts. One fetch handler for Node, Bun, Deno or Workers |
| [`packages/connector-core`](packages/connector-core) | The host-free connector: pairing, credentials, turns, proxied tools |
| [`connectors/claude-code`](connectors/claude-code) | The `byoa` Claude Code plugin (a mod) |
| [`connectors/pi`](connectors/pi) | `@plannotator/byoa-pi` |
| [`connectors/opencode`](connectors/opencode) | `@plannotator/byoa-opencode` (OpenCode 2) |
| [`packages/conformance`](packages/conformance) | The real server and the real connector over the wire |
| [`examples/demo`](examples/demo) | A small app: a notes MCP server and a chat page |

## Try it locally

```sh
pnpm install
PORT=4100 APP_ID=notes APP_NAME=Notes node examples/demo/src/server.ts
# open http://localhost:4100 (it signs you in), then in your agent:
claude --plugin-dir ./connectors/claude-code      # or: pi -e ./connectors/pi/src/index.ts
/byoa connect http://localhost:4100              # approve the code on the page it opens
```

Type in the page's chat; the message becomes a turn in your session and the answer streams back.

To install the Claude Code connector from GitHub instead of a clone (this works once the repository is public), run these in Claude Code:

```sh
/plugin marketplace add plannotator/byoa
/plugin install byoa@byoa
```

## Tests

```sh
pnpm test                                    # protocol, server, connector-core, conformance
(cd connectors/claude-code && claude plugin test . && node --test tests/node/*.test.mjs)
(cd connectors/pi && node --test test/*.test.ts)
(cd connectors/opencode && node --test test/*.test.ts)
```

## Build and pack

```sh
pnpm build                                   # tsc: each package's dist/ (ESM .js and .d.ts)
(cd packages/server && pnpm pack)            # prepack builds the package and the BYOA packages it depends on first
```

In this repository, each package's `exports` point at `src/*.ts`, so the tests, the live scripts and apps that link these folders run the sources. `publishConfig.exports` points at `dist/`. pnpm swaps it in, and turns `workspace:*` into the real version, when it packs. So pack and publish with pnpm, not npm. Pi reads only the `pi.extensions` field, which pnpm does not swap, so in `@plannotator/byoa-pi` that field names `./dist/index.js` directly.

## Licence

MIT OR Apache-2.0. An open-source project from Plannotator.

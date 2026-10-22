# @plannotator/byoa-protocol

The BYOA (Bring Your Own Agent) wire, draft 0.1, as TypeScript types and parsers. It has every shape that crosses between an app and a connector: discovery, pairing, sessions, the long-poll, commands and message events. The prose is in [docs/SPEC.md](../../docs/SPEC.md).

It has no dependencies and uses no runtime API beyond the language. `@plannotator/byoa-server` and `@plannotator/byoa-connector-core` both build on it. Use it directly only if you write your own app side or your own connector.

## Usage

```ts
import { WELL_KNOWN_PATH, parseDiscovery, type Discovery } from "@plannotator/byoa-protocol";

const res = await fetch(new URL(WELL_KNOWN_PATH, "https://acme.example"));
const parsed = parseDiscovery(await res.json());
if (!parsed.ok) throw new Error(parsed.reason);
const discovery: Discovery = parsed.value;
```

## What it has

- `BYOA_VERSION`, `WELL_KNOWN_PATH`, `KNOBS` (the timings every party agrees on), `LIMITS` (the size limits), `META` (the `_meta` keys) and `END_EVENTS`.
- The wire types: `Discovery`, `PairStartRequest`, `PairStartResponse`, `PairPollApproved`, `RegisterRequest`, `PollRequest`, `PollResponse`, `Command`, `MessageEvent`, `WireError` and the rest.
- One parser per body: `parseDiscovery`, `parsePairStart`, `parsePairStartResponse`, `parsePairApproved`, `parseRegister`, `parseRegisterResponse`, `parsePoll`, `parsePollResponse`, `parseCommand` and `parseEvents`. Each takes `unknown` and returns `{ ok: true, value }` or `{ ok: false, reason }`. `parseWireError` returns the error or `null`, and `parseJson` returns `undefined` for bad JSON. None of them throws.
- `provenanceLine`, the line a connector puts before an app's turn text (SPEC 6).

## Licence

MIT OR Apache-2.0.

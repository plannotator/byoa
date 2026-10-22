# Probe: concurrent held $.http.fetch from one Claude Code mod (2026-10-21)

Question: can ONE connector mod hold one long-poll per connected app at the same time, or do fetches queue?

Setup:
- Claude Code 2.1.306, interactive, in a pty, with `--plugin-dir /tmp/byoa-probe/plugin`.
- A hooks module that, on its first `$.clock.every(1000)` tick, fires 6 `$.http.fetch` POSTs to a local server that holds each one for 15 s. On the third tick it fires one quick fetch.
- Gotcha: hooks modules load only after workspace trust is accepted. Answer the prompt with Down then Enter.

Server log (seconds from server start):
```
 3.23 arrive /hold?i=1 … /hold?i=6   (all six at once)
 5.24 arrive /quick, 5.24 /quickdone (not delayed by the six holds)
18.24 answer /hold?i=1..6           (15 s later, all together)
```
Debug log: `$.http.fetch (byoa-fetch-probe): 200 in 15004ms`.

Result: no per-mod serialisation, at least up to 6 concurrent fetches. A universal connector can hold one poll per app.
Files: /tmp/byoa-probe/{plugin,server.mjs,run.py}

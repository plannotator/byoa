// Under Node: hooks/core is an exact copy of packages/protocol and
// packages/connector-core (scripts/sync-core.mjs --check). Catches: the
// plugin shipping a core older or newer than the one the repo tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

test("hooks/core matches its sources", () => {
	const script = join(import.meta.dirname, "../../scripts/sync-core.mjs");
	const r = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
});

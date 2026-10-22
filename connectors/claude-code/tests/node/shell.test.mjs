// Under Node (`node --test tests/node`): the credential shell-outs, run for
// real in a temporary folder, as `$.process.run` runs them. What each test
// catches is named on it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SHELL_INIT, listArgv, parseList, parseRead, readArgv, removeArgv, writeArgv } from "../../hooks/shell.ts";

function run(argv, stdin) {
	const r = spawnSync(argv[0], argv.slice(1), { cwd: SHELL_INIT.cwd, env: { ...process.env, ...SHELL_INIT.env }, input: stdin ?? "", encoding: "utf8" });
	return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

const mode = (path) => statSync(path).mode & 0o777;

test("writePrivate: 0700 folders, a 0600 file, no temporary file left", () => {
	const home = mkdtempSync(join(tmpdir(), "byoa-shell-"));
	try {
		const path = join(home, ".byoa/credentials/http_127.0.0.1_4100.json");
		assert.equal(run(writeArgv(path), '{"token":"t"}\n').exitCode, 0);
		assert.equal(mode(path), 0o600);
		assert.equal(mode(join(home, ".byoa/credentials")), 0o700);
		assert.equal(mode(join(home, ".byoa")), 0o700);
		assert.deepEqual(readdirSync(join(home, ".byoa/credentials")), ["http_127.0.0.1_4100.json"]);
		// Catches: a rewrite keeping wider bits from an earlier file.
		chmodSync(path, 0o644);
		assert.equal(run(writeArgv(path), '{"token":"u"}\n').exitCode, 0);
		assert.equal(mode(path), 0o600);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("writePrivate: an existing folder is set to 0700", () => {
	const home = mkdtempSync(join(tmpdir(), "byoa-shell-"));
	try {
		const dir = join(home, ".byoa/credentials");
		mkdirSync(dir, { recursive: true, mode: 0o755 });
		chmodSync(dir, 0o755);
		assert.equal(run(writeArgv(join(dir, "x.json")), "{}").exitCode, 0);
		assert.equal(mode(dir), 0o700);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// Catches: a 0644 credential read as safe (the core refuses wide bits, but
// only if the mode it gets is right), and a missing file read as an error.
test("read: the mode and the text, or null", () => {
	const home = mkdtempSync(join(tmpdir(), "byoa-shell-"));
	try {
		const path = join(home, "c.json");
		assert.equal(parseRead(run(readArgv(path)).stdout), null);
		writeFileSync(path, "line one\nline two\n");
		chmodSync(path, 0o644);
		assert.deepEqual(parseRead(run(readArgv(path)).stdout), { mode: 0o644, text: "line one\nline two\n" });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("list and remove", () => {
	const home = mkdtempSync(join(tmpdir(), "byoa-shell-"));
	try {
		assert.deepEqual(parseList(run(listArgv(join(home, "none"))).stdout), []);
		writeFileSync(join(home, "a.json"), "{}");
		writeFileSync(join(home, ".hidden.json"), "{}");
		assert.deepEqual(parseList(run(listArgv(home)).stdout).sort(), [".hidden.json", "a.json"]);
		assert.equal(run(removeArgv(join(home, "a.json"))).exitCode, 0);
		assert.equal(run(removeArgv(join(home, "a.json"))).exitCode, 0);
		assert.deepEqual(parseList(run(listArgv(home)).stdout), [".hidden.json"]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// Catches: a path with spaces or quotes breaking out of the script.
test("paths are arguments, never script text", () => {
	const home = mkdtempSync(join(tmpdir(), "byoa shell '$(x)' "));
	try {
		const path = join(home, "c.json");
		assert.equal(run(writeArgv(path), "ok").exitCode, 0);
		assert.deepEqual(parseRead(run(readArgv(path)).stdout), { mode: 0o600, text: "ok" });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

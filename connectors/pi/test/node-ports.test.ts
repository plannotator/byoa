// The Node ports on a real temp folder: private files, atomic writes, and a
// git remote that never carries a user name or a token.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nodeFiles, nodeWorkspace, remoteLabel } from "../src/node-ports.ts";

test("writePrivate makes a 0700 folder and a 0600 file, with no temporary file left", async () => {
	const root = mkdtempSync(join(tmpdir(), "byoa-ports-"));
	try {
		const path = join(root, ".byoa", "credentials", "http_127.0.0.1_4100.json");
		await nodeFiles.writePrivate(path, "{}");
		await nodeFiles.writePrivate(path, '{"a":1}');
		assert.equal(statSync(join(root, ".byoa", "credentials")).mode & 0o777, 0o700);
		assert.deepEqual(await nodeFiles.read(path), { text: '{"a":1}', mode: 0o600 });
		assert.deepEqual(readdirSync(join(root, ".byoa", "credentials")), ["http_127.0.0.1_4100.json"]);
		assert.deepEqual(await nodeFiles.list(join(root, ".byoa", "credentials")), ["http_127.0.0.1_4100.json"]);
		assert.equal(await nodeFiles.read(join(root, "missing")), null);
		assert.deepEqual(await nodeFiles.list(join(root, "missing")), []);
		await nodeFiles.remove(path);
		await nodeFiles.remove(path);
		assert.equal(await nodeFiles.read(path), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("remoteLabel keeps host and path, and drops users, tokens and .git", () => {
	assert.equal(remoteLabel("git@github.com:acme/app.git"), "github.com/acme/app");
	assert.equal(remoteLabel("https://user:ghp_secret@github.com/acme/app.git"), "github.com/acme/app");
	assert.equal(remoteLabel("ssh://git@gitlab.example:2222/team/app"), "gitlab.example:2222/team/app");
	assert.equal(remoteLabel("not a url"), null);
});

test("nodeWorkspace reads the folder, its origin remote and its branch", async () => {
	const root = mkdtempSync(join(tmpdir(), "byoa-ws-"));
	try {
		const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
		git("init", "-q", "-b", "main");
		git("remote", "add", "origin", "https://dana:tok@github.com/acme/northstar.git");
		const ws = await nodeWorkspace(root);
		assert.equal(ws.git_remote, "github.com/acme/northstar");
		assert.equal(ws.path, root);
		assert.equal(ws.folder_name, root.split("/").at(-1));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// Sharing is looked up by an id the app chose, in a file the person wrote:
// both must be plain keys, never Object.prototype's.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SHARE, readSharing } from "../src/sharing.ts";
import { MemoryFiles } from "../src/testing.ts";

const PATH = "/home/p/.byoa/policy.json";

test("an app id that names an Object.prototype member gets the default, not a function", async () => {
	const files = new MemoryFiles();
	files.put(PATH, JSON.stringify({ share: { notes: ["folder_name"] } }));
	const s = await readSharing(files, PATH);
	assert.ok(s.ok);
	for (const id of ["constructor", "toString", "__proto__", "hasOwnProperty"]) assert.deepEqual(s.fieldsFor(id), [...DEFAULT_SHARE], id);
	assert.deepEqual(s.fieldsFor("notes"), ["folder_name"]);
});

test('a "__proto__" key in the file is just another app id', async () => {
	const files = new MemoryFiles();
	files.put(PATH, '{ "share": { "__proto__": ["path"], "*": ["folder_name"] } }');
	const s = await readSharing(files, PATH);
	assert.ok(s.ok);
	assert.deepEqual(s.fieldsFor("__proto__"), ["path"]);
	assert.deepEqual(s.fieldsFor("length"), ["folder_name"], "the table's prototype is untouched");
	assert.deepEqual(s.fieldsFor("anything"), ["folder_name"]);
});

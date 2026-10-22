// The copy rule: connector-core is copied into a Claude Code mod, which can
// import only its own folder and has no Node. So src imports nothing but its
// own files, only src/protocol.ts imports @plannotator/byoa-protocol (by one line a sync
// script rewrites), and no file uses a Node or web global.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const SRC = join(import.meta.dirname, "../src");
const FORBIDDEN = /\b(process|Buffer|require|setTimeout|setInterval|setImmediate|clearTimeout|fetch|TextEncoder|TextDecoder|crypto|globalThis|window|document|AbortSignal|structuredClone|queueMicrotask)\b/;

test("src imports only its own files, and protocol only through src/protocol.ts", () => {
	for (const name of readdirSync(SRC)) {
		const source = readFileSync(join(SRC, name), "utf8");
		for (const m of source.matchAll(/^(?:import|export)[^"']*from\s+["']([^"']+)["']/gm)) {
			const spec = m[1] as string;
			if (name === "protocol.ts") assert.equal(spec, "@plannotator/byoa-protocol");
			else assert.match(spec, /^\.\/[a-z-]+\.ts$/, `${name} imports ${spec}`);
		}
	}
});

test("src uses no Node or web global beyond URL and JSON", () => {
	for (const name of readdirSync(SRC)) {
		const code = readFileSync(join(SRC, name), "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "")
			.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
		const hit = FORBIDDEN.exec(code);
		assert.equal(hit, null, `${name} uses ${hit?.[0]}`);
	}
});

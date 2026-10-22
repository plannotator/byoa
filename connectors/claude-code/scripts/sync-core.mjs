// Copies packages/protocol/src and packages/connector-core/src into
// hooks/core/, because a Claude Code mod imports only files inside its own
// folder. The copies are what the plugin ships; tests run this with --check
// and fail on any drift.
//
//   node scripts/sync-core.mjs           write the copies
//   node scripts/sync-core.mjs --check   exit 1 when a copy differs
//
// The one rewrite: connector-core's src/protocol.ts imports "@plannotator/byoa-protocol",
// which in the copy is "../protocol/index.ts".
// A source file that names a Node module or global is refused here, before
// it can reach a mod, which has neither (connector-core's purity test checks
// the same at its source).
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(PLUGIN, "../..");
const PROTOCOL_IMPORT = 'export * from "@plannotator/byoa-protocol";';
const PROTOCOL_IMPORT_COPY = 'export * from "../protocol/index.ts";';
const SOURCES = [
	{ from: "packages/protocol/src", to: "hooks/core/protocol" },
	{ from: "packages/connector-core/src", to: "hooks/core/connector" },
];
const NODE = /from\s+["']node:|\brequire\(|\bprocess\.|\bBuffer\b|\bfetch\(/;
const check = process.argv.includes("--check");
const problems = [];

for (const { from, to } of SOURCES) {
	const src = join(REPO, from);
	const dir = join(PLUGIN, to);
	const want = new Map();
	for (const name of readdirSync(src).filter((f) => f.endsWith(".ts")).sort()) {
		let text = readFileSync(join(src, name), "utf8");
		const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		if (NODE.test(code)) problems.push(`${from}/${name} uses Node or global fetch; a Claude Code mod has neither.`);
		if (from.includes("connector-core") && name === "protocol.ts") {
			if (!text.includes(PROTOCOL_IMPORT)) problems.push(`${from}/protocol.ts no longer has the line ${PROTOCOL_IMPORT}; update scripts/sync-core.mjs.`);
			text = text.replace(PROTOCOL_IMPORT, PROTOCOL_IMPORT_COPY);
		}
		want.set(name, `// GENERATED from ${from}/${name} by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.\n${text}`);
	}
	let have = [];
	try {
		have = readdirSync(dir).filter((f) => f.endsWith(".ts"));
	} catch {}
	if (check) {
		for (const [name, text] of want) {
			let current = null;
			try {
				current = readFileSync(join(dir, name), "utf8");
			} catch {}
			if (current !== text) problems.push(`${to}/${name} differs from ${from}/${name}; run node scripts/sync-core.mjs`);
		}
		for (const name of have) if (!want.has(name)) problems.push(`${to}/${name} has no source; run node scripts/sync-core.mjs`);
	} else {
		mkdirSync(dir, { recursive: true });
		for (const name of have) if (!want.has(name)) rmSync(join(dir, name));
		for (const [name, text] of want) writeFileSync(join(dir, name), text);
	}
}

if (problems.length > 0) {
	for (const p of problems) console.error(p);
	process.exit(1);
}
console.log(check ? "sync-core: copies match" : "sync-core: copied protocol and connector-core into hooks/core");

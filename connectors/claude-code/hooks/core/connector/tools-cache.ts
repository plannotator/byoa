// GENERATED from packages/connector-core/src/tools-cache.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// The last tools/list each app answered, kept on disk so that a session that
// starts while the app is down (a deploy) still gets that app's tool:
// ~/.byoa/tools/<host>/<origin-key>.json, the same key as the credential, mode
// 0600 in a 0700 folder. It only describes the actions: every call still goes
// to the live app. The file holds the app's tools exactly as read, so a tool
// built from it is byte for byte the tool built from a fresh, equal list
// (the prompt cache stays warm). It is removed with the credential.
//   - A file whose mode grants anything to group or others is not used: its
//     descriptions reach the model's prompt.

import { parseJsonText } from "./clean.ts";
import { originKey } from "./credentials.ts";
import type { McpTool } from "./mcp.ts";
import type { FilePort } from "./ports.ts";
import { isRecord } from "./protocol.ts";

const WIDE_BITS = 0o077;

export function toolsCachePath(home: string, host: string, origin: string): string {
	return `${home.replace(/\/+$/, "")}/.byoa/tools/${host.replace(/[^A-Za-z0-9.-]/g, "_")}/${originKey(origin)}.json`;
}

/** The cached list for this origin, or null when there is none it can use. */
export async function readToolsCache(files: FilePort, path: string, origin: string): Promise<McpTool[] | null> {
	const raw = await files.read(path);
	if (raw === null || (raw.mode & WIDE_BITS) !== 0) return null;
	const v = parseJsonText(raw.text);
	if (!isRecord(v) || v.version !== 1 || v.origin !== origin || !Array.isArray(v.tools)) return null;
	const tools: McpTool[] = [];
	for (const t of v.tools) {
		if (!isRecord(t) || typeof t.name !== "string" || typeof t.description !== "string" || !isRecord(t.inputSchema)) return null;
		tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
	}
	return tools;
}

export async function writeToolsCache(files: FilePort, path: string, origin: string, tools: readonly McpTool[], now: number): Promise<void> {
	const file = { version: 1, origin, saved_at: new Date(now).toISOString(), tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
	await files.writePrivate(path, `${JSON.stringify(file, null, 2)}\n`);
}

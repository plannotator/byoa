// GENERATED from packages/connector-core/src/tools.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// The proxied tool (SPEC 7): ONE host tool per app, whose `action` is one of
// the app's MCP tools, built from its `tools/list` once at session start
// (Plannotator Inbox's and Machine's shape). The list stays fixed for the
// session, which keeps the prompt cache stable; an app paired mid-session
// reaches the next session. When tools/list fails, the last list the app
// answered is used (tools-cache.ts).
//   - Name: the app id, cut to the characters every host accepts.
//   - Description: the app's name and origin, then one short line per
//     action, within 2,048 characters (Claude Code cuts there).
//   - Input schema: `action` plus the union of every action's fields; a
//     field several actions share is described once, naming them.
//   - A call carries only the chosen action's own fields; anything else is
//     refused before a request is made.

import { shown } from "./clean.ts";
import type { McpTool } from "./mcp.ts";
import { isRecord } from "./protocol.ts";

export const MAX_DESCRIPTION = 2_048;

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export function toolName(appId: string): string {
	return appId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

export function buildToolDefinition(app: { id: string; name: string; origin: string }, tools: readonly McpTool[]): ToolDefinition | null {
	const usable = tools.filter((t) => /^[A-Za-z0-9_.-]{1,128}$/.test(t.name));
	if (usable.length === 0) return null;
	const head = `${shown(app.name, 80)} (${app.origin}), an app connected as the person. Set "action" to one of its tools and pass that tool's fields.`;
	const lines: string[] = [];
	let length = head.length;
	for (const [i, tool] of usable.entries()) {
		const line = `- ${tool.name}: ${shown(firstSentence(tool.description), 160)}`;
		const rest = `\n(and ${usable.length - i} more, listed in "action")`;
		if (length + line.length + 1 + rest.length > MAX_DESCRIPTION) {
			lines.push(rest.trim());
			break;
		}
		lines.push(line);
		length += line.length + 1;
	}
	const properties: Record<string, Record<string, unknown>> = {
		action: { type: "string", enum: usable.map((t) => t.name), description: `Which ${shown(app.name, 80)} tool to call.` },
	};
	const users = new Map<string, string[]>();
	for (const tool of usable) {
		for (const [field, schema] of Object.entries(propertiesOf(tool))) {
			if (field === "action") continue;
			const list = users.get(field);
			if (list !== undefined) list.push(tool.name);
			else {
				users.set(field, [tool.name]);
				properties[field] = schema;
			}
		}
	}
	for (const [field, names] of users) {
		const schema = properties[field] as Record<string, unknown>;
		const own = typeof schema.description === "string" ? schema.description : "";
		properties[field] = { ...schema, description: `(${names.join(", ")}) ${own}`.trim() };
	}
	return {
		name: toolName(app.id),
		description: [head, ...lines].join("\n"),
		inputSchema: { type: "object", properties, required: ["action"], additionalProperties: false },
	};
}

/** The MCP call a proxied tool call stands for, or why it is refused. */
export function toolCall(input: unknown, tools: readonly McpTool[]): { name: string; arguments: Record<string, unknown> } | { error: string } {
	if (!isRecord(input)) return { error: "Expected an object with an action." };
	const { action, ...rest } = input;
	const tool = tools.find((t) => t.name === action);
	if (tool === undefined) return { error: `action must be one of ${tools.map((t) => t.name).join(", ")}.` };
	const own = propertiesOf(tool);
	const args: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(rest)) {
		if (value === undefined) continue;
		if (!(name in own)) return { error: `${tool.name} takes no "${name}" (its fields: ${Object.keys(own).join(", ") || "none"}).` };
		args[name] = value;
	}
	return { name: tool.name, arguments: args };
}

function propertiesOf(tool: McpTool): Record<string, Record<string, unknown>> {
	const p = tool.inputSchema.properties;
	if (!isRecord(p)) return {};
	const out: Record<string, Record<string, unknown>> = {};
	for (const [k, v] of Object.entries(p)) if (isRecord(v)) out[k] = v;
	return out;
}

function firstSentence(description: string): string {
	const line = description.split("\n", 1)[0] ?? "";
	const stop = line.search(/\.\s/);
	return (stop >= 0 ? line.slice(0, stop + 1) : line).trim();
}

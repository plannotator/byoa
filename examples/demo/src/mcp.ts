// The demo's MCP server: three tools over stateless JSON-RPC, answered as
// plain JSON. Calls are attributed to the BYOA connection and session that
// made them, which is what one token for doors and tools buys (SPEC 7).

export interface Activity {
	notes: { text: string; session: string | null; at: string }[];
	says: { text: string; session: string | null; at: string }[];
}

export const activity: Activity = { notes: [], says: [] };

const TOOLS = [
	{ name: "add_note", description: "Save a note in the app.", inputSchema: { type: "object", properties: { text: { type: "string", description: "The note." } }, required: ["text"] } },
	{ name: "list_notes", description: "List the notes saved in the app.", inputSchema: { type: "object", properties: {} } },
	{ name: "say", description: "Show a short note to the person in the app's chat.", inputSchema: { type: "object", properties: { text: { type: "string", description: "What to show." } }, required: ["text"] } },
];

type Rpc = { id?: unknown; method?: string; params?: Record<string, unknown> } | null;

export function handleMcp(body: Rpc, who: { sessionId?: string }): unknown {
	const id = body?.id ?? null;
	const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
	switch (body?.method) {
		case "initialize":
			return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "byoa-demo", version: "0.1.0" } });
		case "tools/list":
			return reply({ tools: TOOLS });
		case "tools/call": {
			const name = body.params?.name;
			const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
			const session = who.sessionId ?? null;
			const at = new Date().toISOString();
			if (name === "add_note" && typeof args.text === "string") {
				activity.notes.push({ text: args.text, session, at });
				return reply({ content: [{ type: "text", text: `Saved note ${activity.notes.length}.` }] });
			}
			if (name === "list_notes") {
				const text = activity.notes.map((n, i) => `${i + 1}. ${n.text}`).join("\n") || "No notes yet.";
				return reply({ content: [{ type: "text", text }] });
			}
			if (name === "say" && typeof args.text === "string") {
				activity.says.push({ text: args.text, session, at });
				return reply({ content: [{ type: "text", text: "Shown." }] });
			}
			return reply({ content: [{ type: "text", text: `Unknown or bad call: ${String(name)}` }], isError: true });
		}
		default:
			return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(body?.method)}` } };
	}
}

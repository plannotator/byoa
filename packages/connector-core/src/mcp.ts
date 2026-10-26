// A minimal MCP client over Streamable HTTP, for the proxied tools: JSON-RPC
// POSTs to the app's MCP endpoint with the connection token as bearer.
//   - The token goes only to the app's exact origin, and no redirect is
//     followed (doors.ts).
//   - An answer may be `application/json` or a `text/event-stream` carrying
//     the response as `data:` lines; both are read.
//   - Both MCP eras: `tools/list` is sent as it is first; when the server
//     says it needs a session (a 4xx, or an error naming initialize or a
//     session), the client sends `initialize` and `notifications/initialized`
//     once, keeps `mcp-session-id`, and asks again. Later calls reuse that.
//     A `tools/call` is retried after initializing only when the server
//     refused it for that reason, so a tool never runs twice.

import { errorText, parseJsonText, shown } from "./clean.ts";
import { door } from "./doors.ts";
import type { HttpPort } from "./ports.ts";
import { isRecord } from "./protocol.ts";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./version.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Pages of `tools/list` read at most. Plumbing against a looping cursor. */
const MAX_PAGES = 10;

export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

type RpcAnswer = { result: unknown } | { error: string; needsSession: boolean };

export class McpClient {
	readonly #d: { http: HttpPort; origin: string; url: string; token: string };
	#sessionId: string | null = null;
	#protocol: string | null = null;
	#initialized = false;
	#id = 0;

	constructor(deps: { http: HttpPort; origin: string; url: string; token: string }) {
		this.#d = deps;
	}

	/** Every tool the server lists. Throws with a one-line reason. */
	async listTools(): Promise<McpTool[]> {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const result = await this.#call("tools/list", cursor === undefined ? {} : { cursor }, true);
			const list = isRecord(result) && Array.isArray(result.tools) ? result.tools : [];
			for (const item of list) {
				if (!isRecord(item) || typeof item.name !== "string" || item.name.length === 0) continue;
				tools.push({
					name: item.name,
					description: typeof item.description === "string" ? item.description : "",
					inputSchema: isRecord(item.inputSchema) ? item.inputSchema : { type: "object" },
				});
			}
			cursor = isRecord(result) && typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : undefined;
			if (cursor === undefined) break;
		}
		return tools;
	}

	/** One `tools/call`, as the text the agent reads. */
	async callTool(name: string, args: Record<string, unknown>, meta: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
		let result: unknown;
		try {
			result = await this.#call("tools/call", { name, arguments: args, _meta: meta }, true);
		} catch (error) {
			return { text: errorText(error), isError: true };
		}
		return resultText(result);
	}

	async #call(method: string, params: Record<string, unknown>, mayInitialize: boolean): Promise<unknown> {
		const answer = await this.#rpc(method, params);
		if ("result" in answer) return answer.result;
		if (answer.needsSession && mayInitialize && !this.#initialized) {
			await this.#initialize();
			return this.#call(method, params, false);
		}
		throw new Error(answer.error);
	}

	async #initialize(): Promise<void> {
		this.#initialized = true;
		const answer = await this.#rpc("initialize", {
			protocolVersion: MCP_PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: CONNECTOR_NAME, version: CONNECTOR_VERSION },
		});
		if (!("result" in answer)) throw new Error(answer.error);
		const version = isRecord(answer.result) ? answer.result.protocolVersion : undefined;
		this.#protocol = typeof version === "string" ? version : MCP_PROTOCOL_VERSION;
		await this.#send({ jsonrpc: "2.0", method: "notifications/initialized" });
	}

	async #rpc(method: string, params: Record<string, unknown>): Promise<RpcAnswer> {
		const id = ++this.#id;
		const res = await this.#send({ jsonrpc: "2.0", id, method, params });
		if (res.kind === "network") return { error: `${this.#d.origin} did not answer (${res.message})`, needsSession: false };
		const sid = res.headers["mcp-session-id"];
		if (sid !== undefined && sid !== "") this.#sessionId = sid;
		if (res.status === 401) return { error: `${this.#d.origin} refused this connection's token (401)`, needsSession: false };
		const message = jsonRpcMessage(res.text, res.headers["content-type"] ?? "", id);
		if (message !== null && "result" in message) return { result: message.result };
		const said = message !== null ? shown(message.error, 300) : "";
		const needsSession = (res.status >= 400 && res.status < 500) || /initiali[sz]|session/i.test(said);
		return { error: said !== "" ? `${this.#d.origin}: ${said}` : `${this.#d.origin} answered ${res.status}`, needsSession };
	}

	#send(body: Record<string, unknown>) {
		const headers: Record<string, string> = { accept: "application/json, text/event-stream" };
		if (this.#sessionId !== null) headers["mcp-session-id"] = this.#sessionId;
		if (this.#protocol !== null) headers["mcp-protocol-version"] = this.#protocol;
		return door(this.#d.http, { origin: this.#d.origin, url: this.#d.url, method: "POST", token: this.#d.token, body, headers });
	}
}

/** The JSON-RPC response with `id` in a JSON body or an SSE body. */
export function jsonRpcMessage(text: string, contentType: string, id: number): { result: unknown } | { error: string } | null {
	const candidates = /text\/event-stream/i.test(contentType) || /^\s*(event:|data:|id:|:)/m.test(text) ? sseData(text) : [text];
	for (const candidate of candidates) {
		const value = parseJsonText(candidate);
		if (!isRecord(value) || (value.id !== id && value.id !== String(id))) continue;
		if ("result" in value) return { result: value.result };
		if (isRecord(value.error)) return { error: typeof value.error.message === "string" ? value.error.message : "error" };
	}
	return null;
}

function sseData(text: string): string[] {
	return text
		.split(/\r?\n\r?\n/)
		.map((block) =>
			block
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).replace(/^ /, ""))
				.join("\n"),
		)
		.filter((data) => data.trim() !== "");
}

/** A `tools/call` result as text: the text parts, then the structured
 * content as JSON unless the text already holds every value in it. A server
 * may put only a summary in the text and the data in `structuredContent`;
 * the host shows the model this text alone, so dropping either loses
 * something, and repeating data the text carries only costs tokens. */
export function resultText(result: unknown): { text: string; isError: boolean } {
	const value = isRecord(result) ? result : {};
	const parts = Array.isArray(value.content) ? value.content : [];
	const text = parts
		.map((part) => (isRecord(part) ? (typeof part.text === "string" ? part.text : `[${String(part.type ?? "content")} omitted]`) : ""))
		.filter((t) => t !== "")
		.join("\n");
	if (!isRecord(value.structuredContent) || holds(text, value.structuredContent)) return { text, isError: value.isError === true };
	const structured = JSON.stringify(value.structuredContent);
	return { text: text === "" ? structured : `${text}\n${structured}`, isError: value.isError === true };
}

/** True when every string, number and boolean in `data` appears in `text`,
 * as written or JSON-escaped (pretty JSON, a document body verbatim). */
function holds(text: string, data: unknown): boolean {
	if (text === "") return false;
	if (typeof data === "string") return text.includes(data) || text.includes(JSON.stringify(data).slice(1, -1));
	if (typeof data === "number" || typeof data === "boolean") return text.includes(String(data));
	if (Array.isArray(data)) return data.every((item) => holds(text, item));
	if (isRecord(data)) return Object.values(data).every((item) => holds(text, item));
	return true;
}

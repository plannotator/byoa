// A fake model for the live runs: an OpenAI-compatible chat-completions
// server (streaming) that both Pi and OpenCode 2 can use offline, so the
// proof is about the connect, turn and events loop, not a model login.
//   - `TOOL:<tool>:<words>` in the newest user text makes the model call the
//     host tool <tool> (a proxied BYOA tool) with { action: "add_note",
//     text: <words> }; after the tool result it answers "ECHO: the tool ran".
//   - `SLOW` streams a long answer, 8 characters every 700 ms (about 10 s),
//     so a test can send while the session is busy, or stop a turn.
//   - Anything else answers "ECHO: <the last line, cut to 60 characters>".
// Every request is appended to $ECHO_LOG (jsonl) when set.
//   PORT=4599 ECHO_LOG=/tmp/echo.jsonl node connectors/pi/scripts/echo-model.ts

import { appendFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";

type Msg = { role: string; content?: unknown; tool_calls?: unknown };
type Body = { model?: string; stream?: boolean; messages?: Msg[]; tools?: { function?: { name?: string } }[] };

const port = Number(process.env.PORT ?? 4599);
const logFile = process.env.ECHO_LOG;
let n = 0;

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n");
	return "";
}

/** The user text after the model's last answer, and whether a tool result came last. */
function newest(messages: Msg[]): { text: string; afterTool: boolean } {
	if (messages.at(-1)?.role === "tool") return { text: "", afterTool: true };
	const texts: string[] = [];
	for (let i = messages.length - 1; i >= 0 && messages[i]?.role !== "assistant"; i--) {
		if (messages[i]?.role === "user") texts.unshift(textOf(messages[i]?.content));
	}
	return { text: texts.join("\n"), afterTool: false };
}

function plan(body: Body): { text: string; slow: boolean; tool?: { name: string; args: Record<string, unknown> } } {
	const { text, afterTool } = newest(body.messages ?? []);
	if (afterTool) return { text: "ECHO: the tool ran, turn done.", slow: false };
	const offered = (body.tools ?? []).map((t) => t.function?.name ?? "");
	const call = /TOOL:([A-Za-z0-9_-]+):([^\n]+)/.exec(text);
	if (call) {
		const name = call[1] as string;
		if (!offered.includes(name)) return { text: `ECHO: no tool ${name} is offered (offered: ${offered.join(", ")}).`, slow: false };
		return { text: "", slow: false, tool: { name, args: { action: "add_note", text: (call[2] as string).trim() } } };
	}
	if (/SLOW/.test(text)) return { text: "ECHO: a slow answer, a few characters at a time, so the session stays busy for a while.", slow: true };
	const last = text.trim().split("\n").at(-1) ?? "";
	return { text: `ECHO: ${last.slice(0, 60)}`, slow: false };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function complete(res: ServerResponse, body: Body): Promise<void> {
	const p = plan(body);
	const id = `chatcmpl-echo-${++n}`;
	const created = Math.floor(Date.now() / 1000);
	if (logFile) appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), id, tools: (body.tools ?? []).map((t) => t.function?.name), plan: p.tool ? `tool ${p.tool.name}` : p.slow ? "slow" : "text", last: newest(body.messages ?? []).text.slice(0, 300) })}\n`);
	if (!body.stream) {
		const message = p.tool
			? { role: "assistant", content: null, tool_calls: [{ id: `call_${n}`, type: "function", function: { name: p.tool.name, arguments: JSON.stringify(p.tool.args) } }] }
			: { role: "assistant", content: p.text };
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ id, object: "chat.completion", created, model: body.model, choices: [{ index: 0, message, finish_reason: p.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
		return;
	}
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
	const chunk = (o: Record<string, unknown>) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: body.model, ...o })}\n\n`);
	if (p.tool) {
		chunk({ choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: p.tool.name, arguments: "" } }] }, finish_reason: null }] });
		chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(p.tool.args) } }] }, finish_reason: null }] });
		chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
	} else {
		chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
		const size = p.slow ? 8 : 64;
		for (let i = 0; i < p.text.length; i += size) {
			if (res.destroyed) return;
			chunk({ choices: [{ index: 0, delta: { content: p.text.slice(i, i + size) }, finish_reason: null }] });
			await pause(p.slow ? 700 : 10);
		}
		chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
	}
	chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
	res.end("data: [DONE]\n\n");
}

createServer(async (req, res) => {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	const path = new URL(req.url ?? "/", "http://x").pathname;
	try {
		if (req.method === "POST" && path.endsWith("/chat/completions")) return await complete(res, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Body);
		if (req.method === "GET" && path.endsWith("/models")) {
			res.writeHead(200, { "content-type": "application/json" });
			return void res.end(JSON.stringify({ object: "list", data: [{ id: "echo-1", object: "model", owned_by: "byoa" }] }));
		}
		res.writeHead(404).end();
	} catch (error) {
		if (!res.headersSent) res.writeHead(500);
		res.end(String(error));
	}
}).listen(port, "127.0.0.1", () => console.log(`echo model on http://127.0.0.1:${port}/v1`));

// A tiny BYOA app. One person ("Ramos") signs in with a cookie; the app has a
// notes MCP server and a chat page that talks to the person's own agent.
// Run two on different ports to see one agent serve two apps:
//   PORT=4100 APP_ID=notes APP_NAME=Notes node examples/demo/src/server.ts
//   PORT=4200 APP_ID=tasks APP_NAME=Tasks node examples/demo/src/server.ts
// DEMO_AUTO_APPROVE=1 approves pairings with no page (scripted runs only).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createByoa } from "@plannotator/byoa-server";
import { META } from "@plannotator/byoa-protocol";
import { handleMcp } from "./mcp.ts";
import { chatPage } from "./page.ts";

const port = Number(process.env.PORT ?? 4100);
const appId = process.env.APP_ID ?? "notes";
const appName = process.env.APP_NAME ?? "Notes";
const origin = `http://localhost:${port}`;
const person = { userId: "u_ramos", displayName: "Ramos" };
const SESSION_COOKIE = "demo_session=signed-in";

function signedIn(req: Request): boolean {
	return (req.headers.get("cookie") ?? "").split(/;\s*/).includes(SESSION_COOKIE);
}

const byoa = createByoa({
	app: { id: appId, name: appName, origin },
	authenticate: async (req) => (signedIn(req) ? person : null),
	mcpPath: "/mcp",
	...(process.env.DEMO_AUTO_APPROVE === "1" ? { autoApprove: () => person } : {}),
});

async function route(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const handled = await byoa.handle(req);
	if (handled) return handled;
	if (url.pathname === "/login") {
		return new Response(null, { status: 303, headers: { location: url.searchParams.get("next") ?? "/", "set-cookie": `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Lax` } });
	}
	if (url.pathname === "/mcp" && req.method === "POST") {
		const body = (await req.json().catch(() => null)) as { id?: unknown; method?: string; params?: Record<string, unknown> } | null;
		const meta = (body?.params?._meta ?? {}) as Record<string, unknown>;
		const sessionId = typeof meta[META.session] === "string" ? (meta[META.session] as string) : undefined;
		const who = await byoa.verifyBearer(req, sessionId ? { sessionId } : {});
		if (!who) return Response.json({ error: "unauthorized" }, { status: 401 });
		return Response.json(handleMcp(body, who));
	}
	if (url.pathname === "/api/activity") {
		if (!signedIn(req)) return Response.json({ error: "login_required" }, { status: 401 });
		const { activity } = await import("./mcp.ts");
		return Response.json(activity);
	}
	if (url.pathname === "/") {
		if (!signedIn(req)) return Response.redirect(`${origin}/login?next=/`, 303);
		return new Response(chatPage(appName), { headers: { "content-type": "text/html; charset=utf-8" } });
	}
	return new Response("Not found", { status: 404 });
}

// ── Node http ⇄ fetch API ──────────────────────────────────────────────────

async function toRequest(req: IncomingMessage): Promise<Request> {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (Array.isArray(value)) for (const v of value) headers.append(key, v);
		else if (value !== undefined) headers.set(key, value);
	}
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	const body = chunks.length > 0 && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
	const controller = new AbortController();
	req.on("close", () => controller.abort());
	return new Request(`http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`, { method: req.method, headers, body, signal: controller.signal });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
	res.writeHead(response.status, Object.fromEntries(response.headers));
	if (!response.body) return void res.end();
	const reader = response.body.getReader();
	res.on("close", () => void reader.cancel().catch(() => {}));
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			res.write(value);
		}
	} catch {
		// the client went away
	}
	res.end();
}

createServer(async (req, res) => {
	try {
		await send(res, await route(await toRequest(req)));
	} catch (err) {
		res.writeHead(500).end(String(err));
	}
}).listen(port, "127.0.0.1", () => console.log(`${appName} (${appId}) on ${origin}`));

// The UI doors (SPEC 8): between the app's own browser and its own server.
// Every one needs the app's signed-in human session, the mutating ones a
// CSRF check, and every one refuses a request that carries Authorization at
// all, so no token (a connection's own included) can start a turn (SPEC 9.1).
// The events door is a thin SSE wrapper over subscribe(): one stream per
// tab carrying the session list and every message's events.

import { KNOBS } from "@plannotator/byoa-protocol";
import type { Ctx } from "./context.ts";
import { json, noContent, readJson, unauthorized, wireError } from "./http.ts";
import { parseSend } from "./send.ts";
import type { ByoaUser } from "./types.ts";

const KEEP_ALIVE_MS = KNOBS.keepAliveSeconds * 1000;
/** Bytes a tab may leave unread. Past it the stream closes; the browser's
 * EventSource reconnects and is replayed every open message. */
const STREAM_BUFFER_BYTES = 1024 * 1024;

export async function person(ctx: Ctx, req: Request, mutating: boolean): Promise<ByoaUser | Response> {
	if (req.headers.has("authorization")) return unauthorized("UI doors take the person's own session, never a bearer token.");
	const user = await ctx.authenticate(req);
	if (user === null) return unauthorized("Sign in first.");
	if (mutating && !ctx.checkCsrf(req)) return wireError(403, "forbidden", "Cross-site request refused.");
	return user;
}

export function eventStream(ctx: Ctx, userId: string): Response {
	const encoder = new TextEncoder();
	let close = () => {};
	const body = new ReadableStream<Uint8Array>(
		{
			start(controller) {
				let closed = false;
				let unsubscribe: (() => void) | null = null;
				let timer: unknown = null;
				close = () => {
					if (closed) return;
					closed = true;
					unsubscribe?.();
					ctx.clock.clearTimeout(timer);
					try {
						controller.close();
					} catch {
						// Already cancelled by the reader.
					}
				};
				const write = (text: string) => {
					if (closed) return;
					const bytes = encoder.encode(text);
					if ((controller.desiredSize ?? 0) < bytes.length) return close();
					controller.enqueue(bytes);
				};
				const tick = () => {
					write(": keep-alive\n\n");
					if (!closed) timer = ctx.clock.setTimeout(tick, KEEP_ALIVE_MS);
				};
				timer = ctx.clock.setTimeout(tick, KEEP_ALIVE_MS);
				const off = ctx.subscribe(userId, (event) => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
				if (closed) off();
				else unsubscribe = off;
			},
			cancel() {
				close();
			},
		},
		new ByteLengthQueuingStrategy({ highWaterMark: STREAM_BUFFER_BYTES }),
	);
	return new Response(body, {
		headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
	});
}

export async function listSessions(ctx: Ctx, user: ByoaUser): Promise<Response> {
	return json({ connections: await ctx.sessions(user.userId) });
}

export async function sendMessage(ctx: Ctx, req: Request, user: ByoaUser, sessionId: string): Promise<Response> {
	const body = await readJson(req, 128 * 1024);
	if (body instanceof Response) return body;
	const parsed = parseSend(body.value, { kind: "chat", from: user.displayName });
	if (!parsed.ok) return wireError(422, "validation_error", parsed.reason);
	const outcome = await ctx.hub(user.userId).send(sessionId, parsed.value);
	if (outcome.kind === "refused") return wireError(outcome.status, outcome.error, outcome.description);
	return json({ message_id: outcome.message_id }, 202);
}

export async function interruptMessage(ctx: Ctx, user: ByoaUser, sessionId: string, messageId: string): Promise<Response> {
	const outcome = await ctx.hub(user.userId).interrupt(sessionId, messageId);
	if (outcome === null) return wireError(404, "session_not_found", "No such session.");
	return json({ outcome });
}

export async function disconnect(ctx: Ctx, user: ByoaUser, connectionId: string): Promise<Response> {
	const connection = await ctx.store.connections.get(connectionId);
	if (connection === null || connection.user_id !== user.userId) return wireError(404, "not_found", "No such connection.");
	await ctx.revoke(connectionId);
	return noContent();
}

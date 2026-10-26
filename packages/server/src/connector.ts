// The connector's doors (SPEC 4.2, 5): register, poll, events and revoke.
// They take ONLY a BYOA connection token; a person's session cookie means
// nothing here, and no door on this side can create a message (SPEC 9.2).
// A request carrying `Origin` is refused before anything else: a connector
// is never a browser page, so a page must not reach these doors.

import { parseEvents, parsePoll, parseRegister, type PollResponse, type RegisterResponse } from "@plannotator/byoa-protocol";
import type { Ctx } from "./context.ts";
import { sessionIdFor, sha256Hex } from "./crypto.ts";
import { bearer, json, noContent, readJson, unauthorized, wireError } from "./http.ts";

export const MINIMUM_CONNECTOR_VERSION = "0.1.0";

/** last_seen_at is written at register and at most this often on poll, so a
 * polling session costs one durable write a minute, not one per poll. */
const TOUCH_EVERY_MS = 60_000;
/** Past this many entries, the ones older than TOUCH_EVERY_MS are dropped. */
const TOUCHED_PRUNE_AT = 4096;
// Keyed by app origin and connection id, not by ctx or store: an app may build createByoa and its store per request.
const touched = new Map<string, number>();

export function refuseBrowser(req: Request): Response | null {
	return req.headers.has("origin") ? wireError(403, "forbidden", "Connector doors do not take browser requests.") : null;
}

async function touch(ctx: Ctx, connectionId: string, force: boolean): Promise<void> {
	const key = `${ctx.app.origin} ${connectionId}`;
	const now = ctx.clock.now();
	if (!force && now - (touched.get(key) ?? -Infinity) < TOUCH_EVERY_MS) return;
	// Delete first, so the map stays in the order of the last touch.
	touched.delete(key);
	touched.set(key, now);
	if (touched.size > TOUCHED_PRUNE_AT)
		for (const [k, at] of touched) {
			if (now - at < TOUCH_EVERY_MS) break;
			touched.delete(k);
		}
	await ctx.store.connections.touch(connectionId, now);
}

const sessionNotFound = () => wireError(404, "session_not_found", "No such session. Register again.");

export async function register(ctx: Ctx, req: Request): Promise<Response> {
	const connection = await ctx.connectionOf(req);
	if (connection === null) return unauthorized();
	const body = await readJson(req, 64 * 1024);
	if (body instanceof Response) return body;
	const parsed = parseRegister(body.value);
	if (!parsed.ok) return wireError(422, "validation_error", parsed.reason);
	// The person approved one host on the consent page; a session that says
	// another is not that connection's (each host keeps its own credential).
	if (parsed.value.host !== connection.host)
		return wireError(422, "validation_error", `host: this connection was paired as ${connection.host}, not ${parsed.value.host}.`);
	const sessionId = await sessionIdFor(connection.id, parsed.value.host_session_id);
	const outcome = await ctx.hub(connection.user_id).register(connection.id, sessionId, parsed.value);
	if (outcome.kind === "too_many_sessions")
		return wireError(429, "too_many_sessions", `This connection already has ${outcome.limit} live sessions.`);
	await touch(ctx, connection.id, true);
	const answer: RegisterResponse = { session: outcome.session, poll_hold_seconds: ctx.pollHoldSeconds, minimum_connector_version: MINIMUM_CONNECTOR_VERSION };
	// Serialised now, so nothing the hook does can change the answer.
	const response = json(answer);
	if (ctx.onRegistered !== undefined) {
		// Awaited before answering, so it finishes on a runtime that may stop
		// work once the answer is sent (Workers, where the SDK has no
		// waitUntil). Its failure is the app's, never the connector's.
		try {
			// A copy: the hook must not reach into the hub's own state.
			await ctx.onRegistered(connection.user_id, structuredClone({ ...outcome.session, machine_name: connection.machine_name }));
		} catch (error) {
			ctx.reportError(error, req);
		}
	}
	return response;
}

export async function poll(ctx: Ctx, req: Request, sessionId: string): Promise<Response> {
	const connection = await ctx.connectionOf(req);
	if (connection === null) return unauthorized();
	const body = await readJson(req, 16 * 1024);
	if (body instanceof Response) return body;
	const parsed = parsePoll(body.value);
	if (!parsed.ok) return wireError(422, "validation_error", parsed.reason);
	const outcome = await ctx.hub(connection.user_id).poll(connection.id, sessionId, parsed.value);
	if (outcome.kind === "not_found") return sessionNotFound();
	// Revoked while held: the poll ends at once, 401.
	if (outcome.kind === "revoked") return unauthorized("This connection was revoked.");
	await touch(ctx, connection.id, false);
	const answer: PollResponse = { commands: outcome.commands };
	return json(answer);
}

export async function events(ctx: Ctx, req: Request, sessionId: string): Promise<Response> {
	const connection = await ctx.connectionOf(req);
	if (connection === null) return unauthorized();
	const body = await readJson(req, 1024 * 1024);
	if (body instanceof Response) return body;
	const parsed = parseEvents(body.value);
	if (!parsed.ok) return wireError(422, "validation_error", parsed.reason);
	const outcome = await ctx.hub(connection.user_id).postEvents(connection.id, sessionId, parsed.value.events);
	if (outcome.kind === "not_found") return sessionNotFound();
	if (outcome.kind === "seq_gap")
		return wireError(422, "seq_gap", `Resend ${outcome.message_id} from seq ${outcome.expected}.`, { message_id: outcome.message_id, expected: outcome.expected });
	return noContent();
}

/** Idempotent: an unknown or already revoked token also answers 204, so a
 * repeated disconnect is quiet and the door is no oracle for dead tokens. */
export async function revoke(ctx: Ctx, req: Request): Promise<Response> {
	const token = bearer(req);
	if (token === null) return unauthorized();
	const connection = await ctx.store.connections.byTokenHash(await sha256Hex(token));
	if (connection !== null && connection.revoked_at === null) await ctx.revoke(connection.id);
	return noContent();
}

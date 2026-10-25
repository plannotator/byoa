// createByoa: the options in, one fetch-API handler and a few server calls
// out. This file routes requests to the door modules, resolves who is
// calling, and builds the person's connection list; the rules live in the
// doors and the hub.

import { BYOA_VERSION, KNOBS, WELL_KNOWN_PATH, type Discovery } from "@plannotator/byoa-protocol";
import * as connector from "./connector.ts";
import type { Ctx } from "./context.ts";
import { sha256Hex } from "./crypto.ts";
import { bearer, json, wireError } from "./http.ts";
import { memoryStore } from "./memory-store.ts";
import { connectDecide, connectPage, pairPoll, pairStart } from "./pairing.ts";
import { parseSend } from "./send.ts";
import type { HubConfig } from "./store.ts";
import type { Awaitable, Byoa, ByoaLimits, ByoaOptions, Clock, HubEvent, UiConnection, UiEvent } from "./types.ts";
import * as ui from "./ui.ts";

const DEFAULT_LIMITS: ByoaLimits = { sessionsPerConnection: 64, bufferedEventsPerMessage: 4096, seqLookAhead: 256 };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const systemClock: Clock = {
	now: () => Date.now(),
	setTimeout(fn, ms) {
		const timer = setTimeout(fn, ms);
		// A gone or prune timer must not keep a Node process alive.
		(timer as { unref?: () => void }).unref?.();
		return timer;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createByoa(options: ByoaOptions): Byoa {
	const origin = new URL(options.app.origin);
	if (origin.origin !== options.app.origin) throw new Error("byoa: app.origin must be a bare origin, like https://app.example");
	if (origin.protocol !== "https:" && !(origin.protocol === "http:" && LOOPBACK.has(origin.hostname)))
		throw new Error("byoa: app.origin must be https, or http on a loopback address (SPEC 2)");
	const base = options.basePath ?? "/byoa";
	if (!/^\/[^?#]*[^/?#]$/.test(base)) throw new Error('byoa: basePath must start with "/" and not end with one');
	const pollHoldSeconds = options.pollHoldSeconds ?? KNOBS.pollHoldSeconds;
	if (!(pollHoldSeconds >= 0 && pollHoldSeconds <= KNOBS.pollHoldSeconds))
		throw new Error(`byoa: pollHoldSeconds must be 0 to ${KNOBS.pollHoldSeconds}`);

	if (options.autoApprove !== undefined && !LOOPBACK.has(origin.hostname))
		throw new Error("byoa: autoApprove is only for a local app with no accounts, on a loopback origin");

	const store = options.store ?? memoryStore();
	const clock = options.clock ?? systemClock;
	const hubConfig: HubConfig = { clock, limits: { ...DEFAULT_LIMITS, ...options.limits }, pollHoldMs: pollHoldSeconds * 1000 };
	const hub = (userId: string) => store.hub(userId, hubConfig);
	const checkCsrf = options.checkCsrf ?? ((req: Request) => sameOrigin(req, options.app.origin));

	async function sessions(userId: string): Promise<UiConnection[]> {
		const connections = (await store.connections.listByUser(userId)).filter((c) => c.revoked_at === null);
		const live = await hub(userId).list();
		return connections.map((c) => {
			const own = live.filter((s) => s.connection_id === c.id).map((s) => ({ ...s, machine_name: c.machine_name }));
			const seen = Math.max(c.last_seen_at ?? -Infinity, ...own.map((s) => Date.parse(s.last_seen_at)));
			return {
				id: c.id,
				host: c.host,
				machine_name: c.machine_name,
				created_at: new Date(c.created_at).toISOString(),
				last_seen_at: Number.isFinite(seen) ? new Date(seen).toISOString() : null,
				sessions: own,
			};
		});
	}

	/** The hub's events in order, with each list-changed signal turned into
	 * the list itself (it needs the durable connections, an async read).
	 * When the hub ends the subscription, or fails to make it, `onEnd` runs
	 * once, after the events already on their way. */
	function subscribe(userId: string, listener: (event: UiEvent) => void, onEnd?: () => void): () => void {
		let closed = false;
		let off: (() => void) | null = null;
		let chain = Promise.resolve();
		const forward = (event: HubEvent) => {
			chain = chain
				.then(async () => {
					if (closed) return;
					const out: UiEvent = event.type === "sessions_changed" ? { type: "sessions", connections: await sessions(userId) } : event;
					if (!closed) listener(out);
				})
				.catch(() => undefined);
		};
		const ended = () => {
			chain = chain
				.then(() => {
					if (closed) return;
					closed = true;
					off?.();
					onEnd?.();
				})
				.catch(() => undefined);
		};
		let subscribed: Awaitable<() => void>;
		try {
			subscribed = hub(userId).subscribe(forward, ended);
		} catch (error) {
			subscribed = Promise.reject(error);
		}
		void Promise.resolve(subscribed).then((unsubscribe) => {
			if (closed) unsubscribe();
			else off = unsubscribe;
		}, ended);
		return () => {
			closed = true;
			off?.();
		};
	}

	async function revoke(connectionId: string): Promise<void> {
		const connection = await store.connections.revoke(connectionId, clock.now());
		if (connection !== null) await hub(connection.user_id).dropConnection(connectionId);
	}

	async function connectionOf(req: Request) {
		const token = bearer(req);
		if (token === null) return null;
		const connection = await store.connections.byTokenHash(await sha256Hex(token));
		return connection !== null && connection.revoked_at === null ? connection : null;
	}

	/** Never the request's body or headers: they may hold a token or a code.
	 * The app's own onError gets its own request object, and nothing more. */
	function reportError(error: unknown, req: Request): void {
		if (options.onError === undefined) {
			console.error("byoa: door failed", error instanceof Error ? error.message : error);
			return;
		}
		try {
			options.onError(error, req);
		} catch {
			// The app's handler failed; the answer still goes out.
		}
	}

	const ctx: Ctx = {
		app: options.app,
		base,
		store,
		clock,
		pollHoldSeconds,
		autoApprove: options.autoApprove,
		renderPage: options.renderPage,
		prepareSend: options.prepareSend,
		onRegistered: options.onRegistered,
		reportError,
		authenticate: options.authenticate,
		checkCsrf,
		hub,
		connectionOf,
		revoke,
		sessions,
		subscribe,
	};

	const discovery: Discovery = {
		byoa: BYOA_VERSION,
		app: { id: options.app.id, name: options.app.name, origin: options.app.origin, ...(options.app.icon !== undefined ? { icon: options.app.icon } : {}) },
		endpoints: {
			pair_start: `${base}/pair/start`,
			pair_poll: `${base}/pair/poll`,
			verification_uri: `${base}/connect`,
			revoke: `${base}/revoke`,
			sessions: `${base}/sessions`,
			...(options.mcpPath !== undefined ? { mcp: options.mcpPath } : {}),
		},
		poll_hold_seconds: pollHoldSeconds,
		...(pollHoldSeconds === 0 ? { poll_interval_seconds: KNOBS.pollIntervalSeconds } : {}),
		accepts: { interrupt: true, stream: true, settings: options.settings ?? [] },
		...(options.requires !== undefined ? { requires: options.requires } : {}),
	};

	async function route(req: Request): Promise<Response | null> {
		const path = new URL(req.url).pathname;
		if (path === WELL_KNOWN_PATH) return req.method === "GET" ? json(discovery) : notAllowed("GET");
		if (!path.startsWith(`${base}/`)) return null;
		let parts: string[];
		try {
			parts = path.slice(base.length + 1).split("/").map(decodeURIComponent);
		} catch {
			return notFound();
		}
		const [a, b, c, d, e, f] = parts;
		const n = parts.length;
		const method = req.method;

		// The connector's side.
		const connectorDoor =
			(n === 2 && a === "pair" && (b === "start" || b === "poll")) || (n === 1 && (a === "revoke" || a === "sessions")) || (n === 3 && a === "sessions" && (c === "poll" || c === "events"));
		if (connectorDoor) {
			if (method !== "POST") return notAllowed("POST");
			const refused = connector.refuseBrowser(req);
			if (refused !== null) return refused;
			if (a === "pair") return b === "start" ? pairStart(ctx, req) : pairPoll(ctx, req);
			if (a === "revoke") return connector.revoke(ctx, req);
			if (n === 1) return connector.register(ctx, req);
			return c === "poll" ? connector.poll(ctx, req, b as string) : connector.events(ctx, req, b as string);
		}
		if (n === 1 && a === "connect") {
			if (method === "GET") return connectPage(ctx, req);
			if (method === "POST") return connectDecide(ctx, req);
			return notAllowed("GET, POST");
		}

		// The person's side.
		if (a !== "ui") return notFound();
		const door =
			n === 2 && b === "events" ? "GET events"
			: n === 2 && b === "sessions" ? "GET sessions"
			: n === 4 && b === "sessions" && d === "messages" ? "POST send"
			: n === 6 && b === "sessions" && d === "messages" && f === "interrupt" ? "POST interrupt"
			: n === 3 && b === "connections" ? "DELETE connection"
			: null;
		if (door === null) return notFound();
		const [allowed] = door.split(" ");
		if (method !== allowed) return notAllowed(allowed as string);
		const user = await ui.person(ctx, req, allowed !== "GET");
		if (user instanceof Response) return user;
		switch (door) {
			case "GET events":
				return ui.eventStream(ctx, user.userId);
			case "GET sessions":
				return ui.listSessions(ctx, user);
			case "POST send":
				return ui.sendMessage(ctx, req, user, c as string);
			case "POST interrupt":
				return ui.interruptMessage(ctx, user, c as string, e as string);
			default:
				return ui.disconnect(ctx, user, c as string);
		}
	}

	return {
		async handle(req) {
			try {
				return await route(req);
			} catch (error) {
				reportError(error, req);
				return wireError(500, "server_error", "Something failed on the app's side.");
			}
		},
		async send(userId, sessionId, message) {
			const session = (await hub(userId).list()).find((s) => s.id === sessionId);
			const connection = session === undefined ? null : await store.connections.get(session.connection_id);
			const parsed = parseSend(
				{ text: message.text, kind: message.kind ?? "task", interrupt_first: message.interruptFirst ?? false, stream: message.stream ?? true, set: message.set },
				{ kind: "task", from: message.from ?? connection?.display_name ?? "" },
			);
			if (!parsed.ok) return { error: "validation_error", error_description: parsed.reason };
			const outcome = await hub(userId).send(sessionId, parsed.value);
			return outcome.kind === "sent" ? { message_id: outcome.message_id } : { error: outcome.error, error_description: outcome.description };
		},
		async interrupt(userId, sessionId, messageId) {
			return await hub(userId).interrupt(sessionId, messageId);
		},
		sessions,
		subscribe,
		async verifyBearer(req, opts) {
			const connection = await connectionOf(req);
			if (connection === null) return null;
			const identity = { userId: connection.user_id, connectionId: connection.id };
			if (opts?.sessionId === undefined) return identity;
			const session = (await hub(connection.user_id).list()).find((s) => s.id === opts.sessionId);
			return session?.connection_id === connection.id ? { ...identity, sessionId: session.id } : identity;
		},
		revoke,
	};
}

/** The default CSRF check: a POST or DELETE must come from the app's own
 * pages. `Origin` equal to the app's origin passes. A browser sends
 * `Origin: null` (or none) when the page's referrer policy is no-referrer,
 * so then the browser's own `Sec-Fetch-Site: same-origin`, which no page
 * script can set, passes too. Anything else is refused. */
export function sameOrigin(req: Request, appOrigin: string): boolean {
	if (req.method !== "POST" && req.method !== "DELETE") return true;
	const origin = req.headers.get("origin");
	if (origin === appOrigin) return true;
	return (origin === null || origin === "null") && req.headers.get("sec-fetch-site") === "same-origin";
}

function notFound(): Response {
	return wireError(404, "not_found", "No such BYOA door.");
}

function notAllowed(allow: string): Response {
	const response = wireError(405, "method_not_allowed", `Use ${allow}.`);
	response.headers.set("allow", allow);
	return response;
}

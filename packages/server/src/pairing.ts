// The device grant (SPEC 4.1, RFC 8628 with JSON bodies), from Workspaces'
// /connect. The connector starts it with no credential and polls with the
// device code; the person approves on a page in their own signed-in session.
//
// Threat posture: the user code is never a credential by itself (approving
// needs the session, the Origin check and a CSRF token bound to the person
// and the pairing; collecting needs the 256-bit device code). Both codes are
// stored as hashes. The token is minted when a poll COLLECTS, in one
// conditional store write, so the raw token never rests on the server and
// exactly one poll gets it. Unknown, expired, cancelled and used codes all
// get one constant page. The one exception is `autoApprove`, for a local
// app with no accounts on a loopback origin (createByoa refuses it elsewhere).

import { KNOBS, parsePairStart, type PairPollApproved, type PairStartResponse } from "@plannotator/byoa-protocol";
import type { Ctx } from "./context.ts";
import { formatUserCode, hmac, mintDeviceCode, mintToken, mintUserCode, normalizeUserCode, randomId, sha256Hex, timingSafeEqual, userCodeHash } from "./crypto.ts";
import { json, readJson, readText, wireError } from "./http.ts";
import { cancelledPage, connectedPage, consentPage, entryPage, expiredPage, invalidPage, signInPage } from "./pages.ts";
import type { PairingRecord } from "./store.ts";

const LIFETIME_MS = KNOBS.pairingLifetimeSeconds * 1000;
const INTERVAL_MS = KNOBS.pairingIntervalSeconds * 1000;
/** A host on a fixed timer can land two polls a little under the interval apart. */
const EARLY_GRACE_MS = 500;
/** Shown on the page as the agent declared them, so no invisible or direction-changing characters. */
const HIDDEN = /[​-‏‪-‮⁠-⁩﻿]/;

export async function pairStart(ctx: Ctx, req: Request): Promise<Response> {
	const body = await readJson(req, 16 * 1024);
	if (body instanceof Response) return body;
	const parsed = parsePairStart(body.value);
	if (!parsed.ok) return wireError(400, "invalid_request", parsed.reason);
	const client = parsed.value.client;
	if ([client.host, client.connector, client.machine_name ?? ""].some((s) => HIDDEN.test(s)))
		return wireError(400, "invalid_request", "client: no invisible or text-direction characters");
	// A local app with no accounts approves here, so the same start and poll
	// path pairs it in one command with no page (Machine's `machine login`).
	const approver = ctx.autoApprove?.(client) ?? null;
	const now = ctx.clock.now();
	for (let draw = 0; draw < 3; draw++) {
		const deviceCode = mintDeviceCode();
		const userCode = mintUserCode();
		const pairing: PairingRecord = {
			id: randomId("conn_"),
			device_code_hash: await sha256Hex(deviceCode),
			user_code_hash: await userCodeHash(userCode),
			client,
			created_at: now,
			expires_at: now + LIFETIME_MS,
			last_poll_at: null,
			status: approver === null ? "pending" : "approved",
			approved_by: approver === null ? null : { user_id: approver.userId, display_name: approver.displayName },
		};
		if (!(await ctx.store.pairings.insert(pairing))) continue;
		const uri = `${ctx.app.origin}${ctx.base}/connect`;
		const shown = formatUserCode(userCode);
		const answer: PairStartResponse = {
			device_code: deviceCode,
			user_code: shown,
			verification_uri: uri,
			verification_uri_complete: `${uri}?code=${shown}`,
			expires_in: KNOBS.pairingLifetimeSeconds,
			interval: KNOBS.pairingIntervalSeconds,
		};
		return json(answer);
	}
	throw new Error("byoa pair/start: no free user code after three draws");
}

export async function pairPoll(ctx: Ctx, req: Request): Promise<Response> {
	const body = await readJson(req, 4 * 1024);
	if (body instanceof Response) return body;
	const deviceCode = (body.value as { device_code?: unknown } | null)?.device_code;
	if (typeof deviceCode !== "string" || deviceCode === "" || deviceCode.length > 128)
		return wireError(400, "invalid_request", "Send the device_code from pair/start.");
	// One answer for unknown, expired and already collected: start again.
	const expired = () => wireError(400, "expired_token", "This pairing expired or was already collected. Start again.");
	const now = ctx.clock.now();
	const pairing = await ctx.store.pairings.findByDeviceCode(await sha256Hex(deviceCode));
	if (pairing === null || pairing.status === "collected" || pairing.expires_at <= now) return expired();
	const previous = await ctx.store.pairings.notePoll(pairing.id, now);
	if (previous !== null && now - previous < INTERVAL_MS - EARLY_GRACE_MS)
		return wireError(400, "slow_down", `Poll every ${KNOBS.pairingIntervalSeconds} seconds or slower.`);
	if (pairing.status === "pending") return wireError(400, "authorization_pending", "Waiting for the person to press Connect.");
	if (pairing.status === "denied" || pairing.approved_by === null) return wireError(400, "access_denied", "The person pressed Cancel. Nothing was connected.");

	const token = mintToken();
	const won = await ctx.store.pairings.collect(
		pairing.id,
		{
			id: pairing.id,
			user_id: pairing.approved_by.user_id,
			display_name: pairing.approved_by.display_name,
			host: pairing.client.host,
			machine_name: pairing.client.machine_name ?? null,
			token_hash: await sha256Hex(token),
			created_at: now,
			revoked_at: null,
			last_seen_at: null,
		},
		now,
	);
	// A racing poll collected it first: this one gets no token.
	if (!won) return expired();
	const answer: PairPollApproved = {
		access_token: token,
		token_type: "bearer",
		connection_id: pairing.id,
		account: { display_name: pairing.approved_by.display_name },
	};
	return json(answer);
}

/** The approval token: bound to the person and the pairing, keyed by the
 * pairing's device-code hash, which never leaves the server. No secret to
 * configure, and the GET writes nothing. */
function approvalToken(pairing: PairingRecord, userId: string): Promise<string> {
	return hmac(pairing.device_code_hash, `byoa-approve\n${userId}\n${pairing.id}`);
}

async function signedIn(ctx: Ctx, req: Request) {
	// A bearer is never a person, here as on the UI doors.
	return req.headers.has("authorization") ? null : ctx.authenticate(req);
}

/** GET: no side effect, ever. A link alone never connects. */
export async function connectPage(ctx: Ctx, req: Request): Promise<Response> {
	const action = `${ctx.base}/connect`;
	const user = await signedIn(ctx, req);
	if (user === null) return signInPage(ctx.app.name);
	const raw = new URL(req.url).searchParams.get("code");
	if (raw === null || raw.trim() === "") return entryPage(ctx.app.name, action, user.displayName);
	const now = ctx.clock.now();
	const normalized = normalizeUserCode(raw);
	const pairing = normalized === null ? null : await ctx.store.pairings.findByUserCode(await userCodeHash(normalized), now);
	if (normalized === null || pairing === null) return invalidPage(ctx.app.name, action);
	return consentPage({
		app: ctx.app.name,
		action,
		host: pairing.client.host,
		machine: pairing.client.machine_name ?? null,
		account: user.displayName,
		userCode: formatUserCode(normalized),
		ageSeconds: Math.max(0, Math.round((now - pairing.created_at) / 1000)),
		csrf: await approvalToken(pairing, user.userId),
	});
}

/** POST: the person's Connect or Cancel. */
export async function connectDecide(ctx: Ctx, req: Request): Promise<Response> {
	const action = `${ctx.base}/connect`;
	const user = await signedIn(ctx, req);
	if (user === null) return signInPage(ctx.app.name);
	if (!ctx.checkCsrf(req)) return expiredPage();
	const text = await readText(req, 4 * 1024);
	if (text === null) return expiredPage();
	const form = new URLSearchParams(text);
	const now = ctx.clock.now();
	const normalized = normalizeUserCode(form.get("code") ?? "");
	const pairing = normalized === null ? null : await ctx.store.pairings.findByUserCode(await userCodeHash(normalized), now);
	if (pairing === null) return invalidPage(ctx.app.name, action);
	if (!timingSafeEqual(form.get("csrf") ?? "", await approvalToken(pairing, user.userId))) return expiredPage();
	const decision = form.get("decision");
	if (decision !== "connect" && decision !== "cancel") return expiredPage();
	const approver = decision === "connect" ? { user_id: user.userId, display_name: user.displayName } : null;
	const won = await ctx.store.pairings.decide(pairing.id, decision === "connect" ? "approved" : "denied", approver, now);
	// Decided in another tab, or expired since the page rendered.
	if (!won) return invalidPage(ctx.app.name, action);
	return decision === "connect" ? connectedPage(pairing.client.host) : cancelledPage();
}

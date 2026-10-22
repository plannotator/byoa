// The pairing client, RFC 8628 sections 3.4 and 3.5, forked from Workspaces'
// connect-core: POST pair_start, then POST pair_poll at the app's interval
// until the person presses Connect or Cancel, the code expires, or something
// fails. It holds no timer: the connector calls `poll()` from its tick when
// `due()` says so, because a Claude Code mod cannot keep a promise sleeping
// after its hook returns.
//   - The approval link must be on the app's own origin: the person is sent
//     there, never to another site.
//   - The FIRST poll goes out at once: an app on this machine may approve
//     the moment pairing starts, and then the person sees "Connected" with no
//     link or code. A slow_down to that one early poll does not widen the
//     interval. After it, an early call sends nothing, so a timer that fires
//     early cannot earn a slow_down; slow_down adds five seconds for good
//     (RFC 8628 3.5).
//   - Network failures, 5xx and 429 back off from the interval, capped.

import { errorText, retryAfter, shown } from "./clean.ts";
import type { AppDiscovery } from "./discovery.ts";
import { door } from "./doors.ts";
import { sameOrigin } from "./origin.ts";
import type { Clock, HttpPort } from "./ports.ts";
import { KNOBS, parsePairApproved, parsePairStartResponse, parseWireError, type ClientInfo } from "./protocol.ts";

export const SLOW_DOWN_STEP_MS = 5_000;
export const MAX_PAIRING_BACKOFF_MS = 30_000;

export interface PairedCredential {
	token: string;
	connectionId: string;
	account: string;
}

export type StartOutcome =
	| { kind: "started"; pairing: Pairing }
	| { kind: "rate_limited"; retryAfterSeconds: number }
	| { kind: "rejected"; message: string }
	| { kind: "unreachable"; message: string };

export type PollStep =
	| { kind: "pending"; nextPollAt: number }
	| { kind: "retrying"; nextPollAt: number; message: string }
	| { kind: "approved"; credential: PairedCredential }
	| { kind: "denied" }
	| { kind: "expired" }
	| { kind: "failed"; message: string };

export type TerminalStep = Extract<PollStep, { kind: "approved" | "denied" | "expired" | "failed" }>;

interface Deps {
	http: HttpPort;
	now: Clock;
	app: AppDiscovery;
}

export async function startPairing(deps: Deps, client: ClientInfo): Promise<StartOutcome> {
	const { origin } = deps.app;
	const res = await door(deps.http, { origin, url: deps.app.endpoints.pairStart, method: "POST", body: { client } });
	if (res.kind === "network") return { kind: "unreachable", message: res.message };
	if (res.status === 200) {
		const start = parsePairStartResponse(res.json);
		if (!start.ok) return { kind: "rejected", message: `the answer to pair_start was not readable (${start.reason})` };
		const link = (value: string) => (value.startsWith("/") ? origin + value : value);
		const uri = link(start.value.verification_uri);
		const complete = link(start.value.verification_uri_complete);
		if (!sameOrigin(uri, origin) || !sameOrigin(complete, origin)) return { kind: "rejected", message: "the app sent an approval link on another site" };
		return { kind: "started", pairing: new Pairing(deps, { ...start.value, verification_uri: uri, verification_uri_complete: complete }) };
	}
	if (res.status === 429) return { kind: "rate_limited", retryAfterSeconds: retryAfter(res.headers) ?? 60 };
	if (res.status >= 500) return { kind: "unreachable", message: `the app answered ${res.status}` };
	const err = parseWireError(res.json);
	return { kind: "rejected", message: err?.error_description ?? err?.error ?? `the app answered ${res.status}` };
}

export class Pairing {
	readonly userCode: string;
	readonly verificationUri: string;
	readonly verificationUriComplete: string;
	readonly expiresAt: number;
	readonly #deviceCode: string;
	readonly #d: Deps;
	#intervalMs: number;
	#nextPollAt: number;
	#failures = 0;
	#terminal: TerminalStep | null = null;
	#inFlight = false;
	#first = true;

	constructor(
		deps: Deps,
		start: { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number },
	) {
		const t = deps.now();
		this.#d = deps;
		this.#deviceCode = start.device_code;
		this.userCode = shown(start.user_code, 32);
		this.verificationUri = start.verification_uri;
		this.verificationUriComplete = start.verification_uri_complete;
		this.expiresAt = t + Math.min(start.expires_in, KNOBS.pairingLifetimeSeconds) * 1000;
		this.#intervalMs = Math.max(start.interval, KNOBS.pairingIntervalSeconds) * 1000;
		this.#nextPollAt = t;
	}

	get intervalMs(): number {
		return this.#intervalMs;
	}

	get done(): TerminalStep | null {
		return this.#terminal;
	}

	due(): boolean {
		if (this.#terminal !== null || this.#inFlight) return false;
		const t = this.#d.now();
		return t >= this.#nextPollAt || t >= this.expiresAt;
	}

	async poll(): Promise<PollStep> {
		if (this.#terminal !== null) return this.#terminal;
		const t = this.#d.now();
		if (t >= this.expiresAt) return this.#finish({ kind: "expired" });
		if (this.#inFlight || t < this.#nextPollAt) return { kind: "pending", nextPollAt: this.#nextPollAt };
		this.#inFlight = true;
		try {
			return await this.#pollOnce();
		} catch (error) {
			return this.#backoff(null, errorText(error));
		} finally {
			this.#inFlight = false;
		}
	}

	async #pollOnce(): Promise<PollStep> {
		const { app } = this.#d;
		const res = await door(this.#d.http, { origin: app.origin, url: app.endpoints.pairPoll, method: "POST", body: { device_code: this.#deviceCode } });
		if (res.kind === "network") {
			this.#first = false;
			return this.#backoff(null, `could not reach ${app.origin} (${res.message})`);
		}
		if (res.status === 200) {
			const approved = parsePairApproved(res.json);
			if (!approved.ok) return this.#finish({ kind: "failed", message: "the answer to pair_poll was not readable" });
			const name = approved.value.account.display_name;
			return this.#finish({
				kind: "approved",
				credential: {
					token: approved.value.access_token,
					connectionId: approved.value.connection_id,
					account: (name === null ? "" : shown(name, 120)) || `your ${shown(app.name, 60)} account`,
				},
			});
		}
		if (res.status === 429 || res.status >= 500) return this.#backoff(retryAfter(res.headers), `the app answered ${res.status}`);
		const err = parseWireError(res.json);
		this.#failures = 0;
		const first = this.#first;
		this.#first = false;
		switch (err?.error) {
			case "authorization_pending":
				return this.#schedule(this.#intervalMs);
			case "slow_down":
				if (!first) this.#intervalMs += SLOW_DOWN_STEP_MS;
				return this.#schedule(this.#intervalMs);
			case "access_denied":
				return this.#finish({ kind: "denied" });
			case "expired_token":
				return this.#finish({ kind: "expired" });
			default:
				return this.#finish({ kind: "failed", message: err?.error_description ?? err?.error ?? `the app answered ${res.status}` });
		}
	}

	#schedule(waitMs: number): PollStep {
		this.#nextPollAt = this.#d.now() + waitMs;
		return { kind: "pending", nextPollAt: this.#nextPollAt };
	}

	#backoff(retryAfterSeconds: number | null, message: string): PollStep {
		this.#failures += 1;
		const exp = Math.min(this.#intervalMs * 2 ** this.#failures, MAX_PAIRING_BACKOFF_MS);
		this.#nextPollAt = this.#d.now() + Math.max(exp, (retryAfterSeconds ?? 0) * 1000);
		return { kind: "retrying", nextPollAt: this.#nextPollAt, message };
	}

	#finish(step: TerminalStep): TerminalStep {
		this.#terminal = step;
		return step;
	}
}

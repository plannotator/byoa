// GENERATED from packages/connector-core/src/discovery.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// `GET <origin>/.well-known/byoa`: who the app is and where its doors are.
// Checked beyond the protocol parser, because everything here steers where a
// token goes and what the person is shown:
//   - `app.origin` must be the origin the person typed (an app cannot claim
//     to be another site);
//   - every endpoint resolves onto that origin (origin.ts);
//   - `app.id` is a short plain id: it names the proxied tool and is what the
//     person types after `disconnect`.

import { door } from "./doors.ts";
import { resolveEndpoint } from "./origin.ts";
import type { HttpPort } from "./ports.ts";
import { KNOBS, parseDiscovery, WELL_KNOWN_PATH, type Discovery, type WorkspaceField } from "./protocol.ts";

export interface AppDiscovery {
	id: string;
	name: string;
	origin: string;
	endpoints: { pairStart: string; pairPoll: string; verification: string; revoke: string; sessions: string; mcp: string | null };
	/** 0: the app answers every poll at once; poll every `pollIntervalSeconds`. */
	pollHoldSeconds: number;
	pollIntervalSeconds: number;
	requires: WorkspaceField[];
	/** The document as fetched, kept in the credential file. */
	raw: Discovery;
}

export type DiscoveryResult = { ok: true; app: AppDiscovery } | { ok: false; unreachable: boolean; message: string };

const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FIELDS: ReadonlySet<string> = new Set(["folder_name", "path", "git_remote", "branch"]);

export async function discover(http: HttpPort, origin: string): Promise<DiscoveryResult> {
	const res = await door(http, { origin, url: origin + WELL_KNOWN_PATH, method: "GET" });
	if (res.kind === "network") return { ok: false, unreachable: true, message: res.message };
	if (res.status !== 200) return { ok: false, unreachable: res.status >= 500 || res.status === 429, message: `${origin}${WELL_KNOWN_PATH} answered ${res.status}` };
	return checkDiscovery(origin, res.json);
}

/** Also used for the copy kept in a credential file. */
export function checkDiscovery(origin: string, body: unknown): DiscoveryResult {
	const parsed = parseDiscovery(body);
	if (!parsed.ok) return { ok: false, unreachable: false, message: `${origin} is not a BYOA app (${parsed.reason})` };
	const d = parsed.value;
	if (d.app.origin.replace(/\/+$/, "") !== origin) return { ok: false, unreachable: false, message: `${origin} says it is ${d.app.origin}` };
	if (!APP_ID.test(d.app.id)) return { ok: false, unreachable: false, message: `${origin} has an app id this connector cannot use` };
	const at = (value: string | undefined) => (value === undefined ? null : resolveEndpoint(origin, value));
	const e = d.endpoints;
	const endpoints = {
		pairStart: at(e.pair_start),
		pairPoll: at(e.pair_poll),
		verification: at(e.verification_uri),
		revoke: at(e.revoke),
		sessions: at(e.sessions),
		mcp: at(e.mcp),
	};
	const { mcp, ...required } = endpoints;
	for (const [key, value] of Object.entries(required))
		if (value === null) return { ok: false, unreachable: false, message: `${origin} lists a ${key} door on another site` };
	if (e.mcp !== undefined && mcp === null) return { ok: false, unreachable: false, message: `${origin} lists an MCP server on another site` };
	const interval = d.poll_interval_seconds;
	return {
		ok: true,
		app: {
			id: d.app.id,
			name: d.app.name,
			origin,
			endpoints: endpoints as AppDiscovery["endpoints"],
			pollHoldSeconds: d.poll_hold_seconds,
			pollIntervalSeconds: typeof interval === "number" && interval >= 1 ? interval : KNOBS.pollIntervalSeconds,
			requires: (d.requires?.workspace ?? []).filter((f) => FIELDS.has(f)),
			raw: d,
		},
	};
}

// Origins. The origin a person paired with is the root of trust: the token
// goes to it and nowhere else, the provenance line names it, and the
// credential file is keyed by it.
//   - https everywhere; plain http only to 127.0.0.1, localhost or [::1]
//     (a local app pairs with the same device grant as a hosted one);
//   - no user name or password in it;
//   - an endpoint from discovery is a path on the origin, or an absolute URL
//     on the same origin; anything else is refused, never followed.

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type OriginResult = { ok: true; origin: string; loopback: boolean } | { ok: false; message: string };

/** What the person typed after `connect`: a URL, or a bare host
 * ("workspaces.example", "127.0.0.1:4000"). */
export function parseOrigin(input: string): OriginResult {
	const raw = input.trim();
	if (raw.length === 0) return { ok: false, message: "no address given" };
	const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
	const loopbackHost = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(raw);
	let url: URL;
	try {
		url = new URL(bare ? `${loopbackHost ? "http" : "https"}://${raw}` : raw);
	} catch {
		return { ok: false, message: `not a web address: ${raw}` };
	}
	if (url.username !== "" || url.password !== "") return { ok: false, message: "an address with a user name or password" };
	const loopback = LOOPBACK.has(url.hostname.toLowerCase());
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
		return { ok: false, message: `${url.origin} is not https (plain http only for 127.0.0.1, localhost or [::1])` };
	return { ok: true, origin: url.origin, loopback };
}

export function isLoopbackOrigin(origin: string): boolean {
	try {
		return LOOPBACK.has(new URL(origin).hostname.toLowerCase());
	} catch {
		return false;
	}
}

/** True when `url` is on exactly `origin` (scheme, host and port). */
export function sameOrigin(url: string, origin: string): boolean {
	try {
		return new URL(url).origin === origin;
	} catch {
		return false;
	}
}

/** An endpoint from discovery as an absolute URL on `origin`, or null. */
export function resolveEndpoint(origin: string, value: string): string | null {
	try {
		const url = value.startsWith("/") && !value.startsWith("//") ? new URL(value, origin) : new URL(value);
		if (url.origin !== origin) return null;
		return url.href.replace(/\/+$/, "");
	} catch {
		return null;
	}
}

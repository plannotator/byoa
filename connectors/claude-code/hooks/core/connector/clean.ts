// GENERATED from packages/connector-core/src/clean.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// Text that came from an app or the host, made safe to show or send.

/** Control, format and line-break characters removed, so a server cannot
 * redraw or reorder what the connector says, and cut to `max` UTF-16 units
 * by whole code points. ZWNJ and ZWJ stay (Persian and Indic names need them). */
export function shown(value: string, max = 200): string {
	const clean = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]|(?![‌‍])\p{Cf}/gu, " ").replace(/\s+/g, " ").trim();
	let out = "";
	for (const ch of clean) {
		if (out.length + ch.length > max) return `${out}…`;
		out += ch;
	}
	return out;
}

/** A label to declare (a folder, a branch): cleaned like `shown`, cut without
 * an ellipsis, or null when nothing is left. */
export function label(value: string | null | undefined, max: number): string | null {
	if (value === null || value === undefined) return null;
	const text = shown(value, max + 1);
	const cut = text.endsWith("…") ? text.slice(0, -1).trim() : text;
	return cut.length === 0 ? null : cut;
}

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Retry-After in seconds, or null. */
export function retryAfter(headers: Record<string, string>): number | null {
	const raw = headers["retry-after"];
	if (raw === undefined) return null;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseJsonText(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

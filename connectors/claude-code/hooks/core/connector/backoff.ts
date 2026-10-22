// GENERATED from packages/connector-core/src/backoff.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// Backoff after a network failure, a 5xx, a 429, or polls that keep being
// superseded (two processes on one session): exponential from one second,
// capped at thirty, with "equal jitter" (half the step fixed, half random) so
// sessions that lost the app at the same moment (a deploy) do not come back
// in step. Never sooner than a Retry-After the app named.

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;

/** The wait before attempt `failures + 1`, after `failures` (>= 1) failures
 * in a row. `random` is in [0, 1). */
export function backoffMs(failures: number, random: () => number, retryAfterSeconds: number | null = null): number {
	const n = Math.max(1, Math.floor(failures));
	const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 30));
	const half = step / 2;
	const r = Math.min(Math.max(random(), 0), 1);
	return Math.max(Math.round(half + r * half), (retryAfterSeconds ?? 0) * 1000);
}

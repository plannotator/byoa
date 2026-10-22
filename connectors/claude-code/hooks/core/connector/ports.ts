// GENERATED from packages/connector-core/src/ports.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// What the core needs from the world, and nothing else. Each host adapter
// supplies these: Pi and OpenCode from Node, Claude Code from `$`. The core
// imports no host and no Node module, because the Claude Code mod copies it
// in and a mod has no Node. It uses only the language, `URL` and `JSON`.

export interface HttpRequest {
	url: string;
	method: "GET" | "POST";
	/** Lower-case names. */
	headers: Record<string, string>;
	body?: string;
}

export interface HttpResponse {
	status: number;
	text: string;
	/** Lower-case names. */
	headers: Record<string, string>;
	/** The URL that answered, when the port knows it. A port MUST NOT follow
	 * redirects (Node: `redirect: "manual"`); if it did anyway, the core
	 * refuses an answer from another origin. */
	url?: string;
}

/** One HTTP request with a whole body. Rejects only when no answer came
 * (network, the port's own timeout, at most 30 s as Claude Code's
 * `$.http.fetch`); any status resolves. Several requests may be in flight at
 * once: one held poll per app per session, plus events and tool calls. */
export type HttpPort = (request: HttpRequest) => Promise<HttpResponse>;

/** The files under ~/.byoa. Paths are absolute, with "/" separators. */
export interface FilePort {
	/** The file's text and permission bits, or null when it does not exist.
	 * Rejects on any other failure. */
	read(path: string): Promise<{ text: string; mode: number } | null>;
	/** Writes `text` so the file is never seen with other content or other
	 * permissions: the parent folder is created 0700 (and set 0700 if it
	 * existed), the file written 0600 under a temporary name, then renamed. */
	writePrivate(path: string, text: string): Promise<void>;
	/** Removes the file; a missing file is not an error. */
	remove(path: string): Promise<void>;
	/** The names in a folder (not paths); [] when it does not exist. */
	list(dir: string): Promise<string[]>;
}

/** Milliseconds since the epoch. */
export type Clock = () => number;

// GENERATED from packages/connector-core/src/doors.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// One request to an app. The token rides only to the exact origin it was
// paired with: a URL on any other origin is refused before anything is sent,
// and an answer that came from another origin (a port that followed a
// redirect) is treated as no answer. 3xx statuses come back as they are and
// every caller treats them as failures, so no redirect is ever followed.

import { errorText, parseJsonText } from "./clean.ts";
import type { HttpPort } from "./ports.ts";
import { sameOrigin } from "./origin.ts";

export type Answer =
	| { kind: "answer"; status: number; text: string; json: unknown; headers: Record<string, string> }
	| { kind: "network"; message: string };

export interface DoorRequest {
	origin: string;
	url: string;
	method: "GET" | "POST";
	token?: string | null;
	body?: unknown;
	headers?: Record<string, string>;
}

export async function door(http: HttpPort, req: DoorRequest): Promise<Answer> {
	if (!sameOrigin(req.url, req.origin)) return { kind: "network", message: `refused to send to ${req.url}: not on ${req.origin}` };
	const headers: Record<string, string> = { accept: "application/json", ...req.headers };
	if (req.body !== undefined) headers["content-type"] = "application/json";
	if (req.token) headers.authorization = `Bearer ${req.token}`;
	let res;
	try {
		res = await http({
			url: req.url,
			method: req.method,
			headers,
			...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
		});
	} catch (error) {
		return { kind: "network", message: errorText(error) };
	}
	if (res.url !== undefined && res.url !== "" && !sameOrigin(res.url, req.origin))
		return { kind: "network", message: `the answer came from another origin (${res.url})` };
	return { kind: "answer", status: res.status, text: res.text, json: parseJsonText(res.text), headers: res.headers };
}

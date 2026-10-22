// Small Response and Request helpers shared by every door: the one error
// shape (SPEC 2), no-store on everything, a bearer parser, and a body reader
// that stops at a bound instead of buffering whatever a caller sends.

import { parseJson } from "@plannotator/byoa-protocol";

const NO_STORE = { "cache-control": "no-store" };

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" } });
}

export function wireError(status: number, error: string, description: string, extra: Record<string, unknown> = {}): Response {
	return json({ error, error_description: description, ...extra }, status);
}

export function noContent(): Response {
	return new Response(null, { status: 204, headers: NO_STORE });
}

export function unauthorized(description = "Send a valid BYOA connection token as the bearer."): Response {
	return wireError(401, "unauthorized", description);
}

export function bearer(req: Request): string | null {
	const match = /^Bearer +(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
	return match?.[1] ?? null;
}

/** The body as text, or null past `max` bytes. */
export async function readText(req: Request, max: number): Promise<string | null> {
	if (Number(req.headers.get("content-length") ?? 0) > max) return null;
	if (req.body === null) return "";
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		chunks.push(value);
	}
	const all = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		all.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(all);
}

/** A JSON body, or the error answer to return instead. */
export async function readJson(req: Request, max: number): Promise<{ value: unknown } | Response> {
	const text = await readText(req, max);
	if (text === null) return wireError(413, "validation_error", `The body is larger than ${max} bytes.`);
	const value = parseJson(text);
	if (value === undefined) return wireError(400, "invalid_request", "Send a JSON body.");
	return { value };
}

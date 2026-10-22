// Credentials, codes and ids, from Web Crypto only so the SDK runs on Node,
// Bun, Deno and Workers alike. Tokens and device codes carry 256 random bits
// and are stored only as SHA-256 hashes. The user code is short (RFC 8628's
// eight consonants, about 34.6 bits): it is never a credential by itself,
// since approving it needs a signed-in person and collecting the token needs
// the device code.

const encoder = new TextEncoder();

export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const USER_CODE_LENGTH = 8;

export function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	crypto.getRandomValues(bytes);
	return bytes;
}

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out;
}

export function randomId(prefix: string): string {
	return prefix + base64url(randomBytes(16));
}

/** `byoa_` + 256 random bits. */
export function mintToken(): string {
	return "byoa_" + base64url(randomBytes(32));
}

export function mintDeviceCode(): string {
	return base64url(randomBytes(32));
}

export async function sha256Hex(text: string): Promise<string> {
	return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

/** Purpose-prefixed so a user code's hash never equals another hash. */
export function userCodeHash(normalized: string): Promise<string> {
	return sha256Hex(`byoa-user-code\n${normalized}`);
}

/** The same (connection, host session) always gives the same id, so a
 * re-register after an app restart keeps conversations pointing at it. */
export async function sessionIdFor(connectionId: string, hostSessionId: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${connectionId}\n${hostSessionId}`)));
	return "ses_" + base64url(digest.slice(0, 18));
}

/** HMAC-SHA-256, base64url. */
export async function hmac(key: string, text: string): Promise<string> {
	const imported = await crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(text))));
}

export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Eight letters, uniform: a byte is used only below 240 (12 x 20), so
 * `byte % 20` has no bias. Normalized form, no hyphen. */
export function mintUserCode(): string {
	let out = "";
	while (out.length < USER_CODE_LENGTH) {
		for (const byte of randomBytes(16)) {
			if (byte >= 240) continue;
			out += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
			if (out.length === USER_CODE_LENGTH) break;
		}
	}
	return out;
}

export function formatUserCode(normalized: string): string {
	return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/** Case, spaces and hyphens ignored (RFC 8628 6.1). Null when what is left
 * cannot be a code. */
export function normalizeUserCode(raw: string): string | null {
	const cleaned = raw.toUpperCase().replace(/[\s-]/g, "");
	if (cleaned.length !== USER_CODE_LENGTH) return null;
	for (const letter of cleaned) if (!USER_CODE_ALPHABET.includes(letter)) return null;
	return cleaned;
}

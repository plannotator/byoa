// The credential files: ~/.byoa/credentials/<host>/<origin-key>.json, one
// per agent host and app origin (SPEC 4.1: two hosts on one machine are two
// connections), mode 0600 in a 0700 folder. Each holds a connection token, so:
//   - it is read only when its mode grants nothing to group or others;
//   - it is written whole, under a temporary name, then renamed (FilePort);
//   - the origin is stored inside and must match the file it was read for;
//   - nothing here logs or returns the token in any text.
// The app's name and id are kept from pairing: the provenance line names the
// app from this record, never from anything the app sends later.

import { parseJsonText } from "./clean.ts";
import type { FilePort } from "./ports.ts";

export interface StoredCredential {
	origin: string;
	appId: string;
	appName: string;
	token: string;
	connectionId: string;
	/** What to call the account in status text. */
	account: string;
	/** The discovery document as fetched at pairing. */
	discovery: unknown;
	savedAt: string;
}

export type ReadResult =
	| { kind: "none" }
	| { kind: "found"; credential: StoredCredential }
	| { kind: "unsafe"; message: string }
	| { kind: "corrupt"; message: string };

const WIDE_BITS = 0o077;

export function credentialsDir(home: string, host: string): string {
	return `${home.replace(/\/+$/, "")}/.byoa/credentials/${host.replace(/[^A-Za-z0-9.-]/g, "_")}`;
}

/** "https://workspaces.example" → "https_workspaces.example"; the port, if
 * any, after another "_". */
export function originKey(origin: string): string {
	return origin.replace("://", "_").replace(/[^A-Za-z0-9.-]/g, "_");
}

export function credentialPath(home: string, host: string, origin: string): string {
	return `${credentialsDir(home, host)}/${originKey(origin)}.json`;
}

export async function readCredential(files: FilePort, path: string): Promise<ReadResult> {
	const raw = await files.read(path);
	if (raw === null) return { kind: "none" };
	if ((raw.mode & WIDE_BITS) !== 0) {
		const mode = (raw.mode & 0o777).toString(8).padStart(4, "0");
		return {
			kind: "unsafe",
			message: `BYOA: ${path} has mode ${mode}, so other users on this machine may read the token in it. It must be 0600. Run: chmod 600 ${path}`,
		};
	}
	const credential = parse(raw.text);
	if (credential === null || path !== credentialPathFor(path, credential.origin))
		return { kind: "corrupt", message: `BYOA: ${path} is not a credential file this connector can read. Delete it and connect again.` };
	return { kind: "found", credential };
}

/** Every credential file under the folder, in name order. */
export async function listCredentials(files: FilePort, home: string, host: string): Promise<Array<{ path: string; result: ReadResult }>> {
	const dir = credentialsDir(home, host);
	const names = (await files.list(dir)).filter((n) => n.endsWith(".json")).sort();
	const out: Array<{ path: string; result: ReadResult }> = [];
	for (const name of names) out.push({ path: `${dir}/${name}`, result: await readCredential(files, `${dir}/${name}`) });
	return out;
}

export async function saveCredential(files: FilePort, home: string, host: string, credential: StoredCredential): Promise<string> {
	const path = credentialPath(home, host, credential.origin);
	const file = {
		version: 1,
		origin: credential.origin,
		app: { id: credential.appId, name: credential.appName },
		token: credential.token,
		connection_id: credential.connectionId,
		account: credential.account,
		discovery: credential.discovery,
		saved_at: credential.savedAt,
	};
	await files.writePrivate(path, `${JSON.stringify(file, null, 2)}\n`);
	return path;
}

function credentialPathFor(path: string, origin: string): string {
	return `${path.slice(0, path.lastIndexOf("/"))}/${originKey(origin)}.json`;
}

function parse(text: string): StoredCredential | null {
	const v = parseJsonText(text) as Record<string, unknown> | undefined;
	if (typeof v !== "object" || v === null || v.version !== 1) return null;
	const app = v.app as Record<string, unknown> | undefined;
	const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.length > 0;
	if (!nonEmpty(v.origin) || !nonEmpty(v.token) || !nonEmpty(v.connection_id)) return null;
	if (typeof app !== "object" || app === null || !nonEmpty(app.id) || !nonEmpty(app.name)) return null;
	return {
		origin: v.origin,
		appId: app.id,
		appName: app.name,
		token: v.token,
		connectionId: v.connection_id,
		account: typeof v.account === "string" ? v.account : "",
		discovery: v.discovery,
		savedAt: typeof v.saved_at === "string" ? v.saved_at : "",
	};
}

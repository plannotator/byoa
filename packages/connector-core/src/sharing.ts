// The person's one connector setting in 0.1 (SPEC 9.5): which workspace
// fields each app is sent. ~/.byoa/policy.json:
//
//   { "share": { "workspaces": ["folder_name", "git_remote", "branch"], "*": ["folder_name"] } }
//
// An app id not listed takes "*", else the default (folder name and git
// remote; never the path unless the person lists it). The connector enforces
// it; the app cannot widen it. A file other users may write, or one that does
// not parse, shares nothing and says so: a broken file never widens.

import { label, parseJsonText } from "./clean.ts";
import type { FilePort } from "./ports.ts";
import type { Workspace, WorkspaceField } from "./protocol.ts";

export const DEFAULT_SHARE: readonly WorkspaceField[] = ["folder_name", "git_remote"];

export type Sharing = { ok: true; fieldsFor: (appId: string) => WorkspaceField[] } | { ok: false; message: string };

const FIELDS: ReadonlySet<string> = new Set(["folder_name", "path", "git_remote", "branch"]);

export function policyPath(home: string): string {
	return `${home.replace(/\/+$/, "")}/.byoa/policy.json`;
}

export async function readSharing(files: FilePort, path: string): Promise<Sharing> {
	const raw = await files.read(path);
	if (raw === null) return { ok: true, fieldsFor: () => [...DEFAULT_SHARE] };
	if ((raw.mode & 0o022) !== 0)
		return { ok: false, message: `BYOA: ${path} can be changed by other users on this machine, so nothing is shared until it is fixed (chmod 644 ${path}).` };
	const v = parseJsonText(raw.text) as { share?: unknown } | undefined;
	const share = typeof v === "object" && v !== null ? v.share : undefined;
	const table: Record<string, WorkspaceField[]> = {};
	if (share !== undefined) {
		if (typeof share !== "object" || share === null || Array.isArray(share)) return broken(path);
		for (const [app, fields] of Object.entries(share)) {
			if (!Array.isArray(fields) || !fields.every((f) => typeof f === "string" && FIELDS.has(f))) return broken(path);
			table[app] = fields as WorkspaceField[];
		}
	} else if (typeof v !== "object" || v === null) return broken(path);
	return { ok: true, fieldsFor: (appId) => [...(table[appId] ?? table["*"] ?? DEFAULT_SHARE)] };
}

function broken(path: string): Sharing {
	return { ok: false, message: `BYOA: ${path} does not parse ({ "share": { "<app id>": ["folder_name", "git_remote"] } }), so nothing is shared until it is fixed.` };
}

/** The workspace with only the shared fields, each cleaned to a label. */
export function sharedWorkspace(workspace: Workspace, fields: readonly WorkspaceField[]): Workspace {
	const out: Workspace = {};
	for (const field of fields) {
		const value = label(workspace[field], field === "path" || field === "git_remote" ? 4096 : 255);
		if (value !== null) out[field] = value;
	}
	return out;
}

/** The fields an app requires that the person does not share with it. */
export function withheld(required: readonly WorkspaceField[], shared: readonly WorkspaceField[]): WorkspaceField[] {
	return required.filter((f) => !shared.includes(f));
}

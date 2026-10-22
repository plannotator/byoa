// The connector-core ports in Node, for the Pi extension and the OpenCode
// plugin (connectors/opencode/src/node-ports.ts is the same file; keep them
// identical).
//   - HTTP: whole bodies, `redirect: "manual"` (a token never follows a
//     redirect), aborted at 30 s like Claude Code's `$.http.fetch`.
//   - Files: the parent folder is created 0700 and set 0700; the file is
//     written 0600 under a temporary name, then renamed, so it is never seen
//     with other content or other permissions.
//   - The git remote is `git remote get-url origin`, cut to host and path:
//     a remote URL can carry a user name or a token, and those never leave.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { FilePort, HttpPort } from "@plannotator/byoa-connector-core";
import type { Workspace } from "@plannotator/byoa-protocol";

export const HTTP_TIMEOUT_MS = 30_000;

export const nodeHttp: HttpPort = async (request) => {
	const res = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		...(request.body !== undefined ? { body: request.body } : {}),
		redirect: "manual",
		signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
	});
	const headers: Record<string, string> = {};
	res.headers.forEach((value, key) => {
		headers[key.toLowerCase()] = value;
	});
	return { status: res.status, text: await res.text(), headers, url: res.url || request.url };
};

const missing = (error: unknown) => (error as { code?: string } | null)?.code === "ENOENT";

export const nodeFiles: FilePort = {
	async read(path) {
		try {
			const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
			return { text, mode: info.mode & 0o777 };
		} catch (error) {
			if (missing(error)) return null;
			throw error;
		}
	},
	async writePrivate(path, text) {
		const dir = dirname(path);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		await chmod(dir, 0o700);
		const temp = `${dir}/.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			await writeFile(temp, text, { mode: 0o600, flag: "wx" });
			await rename(temp, path);
		} catch (error) {
			await rm(temp, { force: true });
			throw error;
		}
	},
	async remove(path) {
		await rm(path, { force: true });
	},
	async list(dir) {
		try {
			return await readdir(dir);
		} catch (error) {
			if (missing(error)) return [];
			throw error;
		}
	},
};

function git(cwd: string, args: string[]): Promise<string | null> {
	return new Promise((resolve) => {
		execFile("git", args, { cwd, timeout: 3_000 }, (error, stdout) => resolve(error ? null : stdout.trim() || null));
	});
}

/** `git@github.com:acme/app.git`, `https://user:token@github.com/acme/app`
 * → `github.com/acme/app`. Null when it is not a remote URL we recognise. */
export function remoteLabel(url: string): string | null {
	const scp = /^[^/@:\s]+@([^/:\s]+):(.+)$/.exec(url);
	let host: string;
	let path: string;
	if (scp) {
		host = scp[1] as string;
		path = scp[2] as string;
	} else {
		try {
			const u = new URL(url);
			if (u.hostname === "") return null;
			host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
			path = u.pathname;
		} catch {
			return null;
		}
	}
	const clean = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
	return clean === "" ? host : `${host}/${clean}`;
}

/** Everything the host knows about its folder; sharing filters it per app. */
export async function nodeWorkspace(cwd: string): Promise<Workspace> {
	const [remote, branch] = await Promise.all([git(cwd, ["remote", "get-url", "origin"]), git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])]);
	const label = remote === null ? null : remoteLabel(remote);
	return {
		folder_name: basename(cwd),
		path: cwd,
		...(label !== null ? { git_remote: label } : {}),
		...(branch !== null && branch !== "HEAD" ? { branch } : {}),
	};
}

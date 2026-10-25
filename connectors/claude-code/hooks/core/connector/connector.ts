// GENERATED from packages/connector-core/src/connector.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// The connector: ONE per host process, serving every app the person paired.
// It owns the apps (one credential file per origin), the pairings in
// progress, the commands, and the attached host sessions; each session
// registers with every connected app (session.ts).
//   - Apps come only from ~/.byoa/credentials, written after a device-grant
//     pairing the person started with `connect <address>`. A local app pairs
//     the same way, on its loopback origin. The pairing text names the origin
//     every time: whoever runs it can start turns in this agent.
//   - App ids are unique across connected apps (they name tools and are
//     typed after `disconnect`); a second app claiming a taken id is refused.
//   - A 401 on any door stops that app everywhere and says so. Only its
//     tools cache is deleted: the person reconnects, and the new token
//     replaces the credential file.
//   - `disconnect` stops the app's links first, so no later request carries
//     the token, then revokes it, then removes the file. If the app cannot be
//     reached the token is still live, and the connector says so and keeps it.
//   - Commands run one at a time; `tick()` never overlaps itself and never
//     waits on the network (requests run on their own).
//   - Not interactive (print, RPC, SDK runs): `attach` returns a handle that
//     does nothing, so such a run never registers.

import { errorText, shown } from "./clean.ts";
import { listCredentials, saveCredential, type StoredCredential } from "./credentials.ts";
import { checkDiscovery, discover, type AppDiscovery } from "./discovery.ts";
import { door } from "./doors.ts";
import type { HostAdapter, HostSession, ProxiedTool, SessionHandle } from "./host.ts";
import { parseOrigin } from "./origin.ts";
import { startPairing, type Pairing, type PollStep } from "./pairing.ts";
import type { Clock, FilePort, HttpPort } from "./ports.ts";
import type { ClientInfo } from "./protocol.ts";
import { AttachedSession, type ConnectedApp } from "./session.ts";
import { policyPath, readSharing, withheld, type Sharing } from "./sharing.ts";
import { text } from "./status.ts";
import { toolsCachePath } from "./tools-cache.ts";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./version.ts";

/** How often the sharing file is read again. */
export const SHARING_EVERY_MS = 30_000;

export interface ConnectorDeps {
	host: HostAdapter;
	http: HttpPort;
	files: FilePort;
	now: Clock;
	/** The person's home folder; everything lives under `<home>/.byoa`. */
	home: string;
	/** In [0, 1); the jitter. Default Math.random. */
	random?: () => number;
}

interface AppEntry extends ConnectedApp {
	account: string;
	path: string;
	revoked: boolean;
}

interface PairingEntry {
	app: AppDiscovery;
	pairing: Pairing;
	retryShown: boolean;
}

export class Connector {
	readonly #d: ConnectorDeps;
	readonly #random: () => number;
	readonly #apps = new Map<string, AppEntry>();
	readonly #pairings = new Map<string, PairingEntry>();
	readonly #sessions = new Set<AttachedSession>();
	/** Credential files that could not be used, with why. */
	readonly #problems: string[] = [];
	#sharing: Sharing = { ok: true, fieldsFor: () => [] };
	#sharingReadAt = Number.NEGATIVE_INFINITY;
	#ticking = false;
	#queue: Promise<unknown> = Promise.resolve();
	#band: string | null | undefined = undefined;
	readonly #inflight = new Set<Promise<unknown>>();

	constructor(deps: ConnectorDeps) {
		this.#d = deps;
		this.#random = deps.random ?? Math.random;
	}

	/** Reads the credential files and the sharing setting. Call once, at
	 * the host's start, before `attach`. */
	start(): Promise<void> {
		return this.#serial(async () => {
			await this.#readSharing();
			for (const { path, result } of await listCredentials(this.#d.files, this.#d.home, this.#d.host.host)) {
				if (result.kind === "unsafe" || result.kind === "corrupt") this.#problems.push(result.message);
				else if (result.kind === "found") this.#load(path, result.credential);
			}
			this.#show();
		});
	}

	/** The host's timer, about every second. */
	async tick(): Promise<void> {
		if (this.#ticking) return;
		this.#ticking = true;
		try {
			for (const entry of this.#pairings.values()) if (entry.pairing.due()) this.#track(this.#pollPairing(entry));
			if (this.#d.now() - this.#sharingReadAt >= SHARING_EVERY_MS) await this.#readSharing();
			for (const session of this.#sessions) {
				session.tick();
				if (session.detached) this.#sessions.delete(session);
			}
		} finally {
			this.#ticking = false;
		}
	}

	/** One interactive host session. Its handle takes the host's turn events. */
	attach(host: HostSession): SessionHandle {
		if (!this.#d.host.isInteractive()) return INERT;
		const session = new AttachedSession(
			{
				host: this.#d.host,
				http: this.#d.http,
				files: this.#d.files,
				home: this.#d.home,
				now: this.#d.now,
				random: this.#random,
				apps: () => [...this.#apps.values()].filter((a) => !a.revoked),
				sharing: () => this.#sharing,
				onRevoked: (appId) => this.#revoked(appId),
				warn: (message) => this.#show({ text: message, level: "warning" }),
			},
			host,
		);
		this.#sessions.add(session);
		session.tick();
		return session;
	}

	/** The `/byoa` command: `connect <address>`, `disconnect <app>`, `status`. */
	command(args: string): Promise<string> {
		const [sub = "status", ...rest] = args.trim().split(/\s+/).filter((w) => w !== "");
		const arg = rest.join(" ");
		switch (sub.toLowerCase()) {
			case "status":
				return this.status();
			case "connect":
				return this.connect(arg);
			case "disconnect":
				return this.disconnect(arg);
			default:
				return Promise.resolve(text.help());
		}
	}

	connect(address: string): Promise<string> {
		return this.#serial(() => this.#connect(address));
	}

	disconnect(app: string): Promise<string> {
		return this.#serial(() => this.#disconnect(app));
	}

	status(): Promise<string> {
		return this.#serial(async () => {
			await this.#readSharing();
			return this.#status();
		});
	}

	/** Resolves when no request the connector itself started is in flight
	 * (pairing polls). Tests. */
	async settled(): Promise<void> {
		while (this.#inflight.size > 0) await Promise.allSettled(this.#inflight);
	}

	// ── connect ────────────────────────────────────────────────────────────

	async #connect(address: string): Promise<string> {
		if (address.trim() === "") return text.connectWhat();
		const parsed = parseOrigin(address);
		if (!parsed.ok) return text.badAddress(parsed.message);
		const origin = parsed.origin;
		const existing = [...this.#apps.values()].find((a) => a.origin === origin);
		if (existing !== undefined && !existing.revoked) return text.alreadyConnected(existing.name, existing.account, origin);
		const waiting = this.#pairings.get(origin);
		if (waiting !== undefined) return text.waiting(waiting.app.name, waiting.pairing.verificationUriComplete, waiting.pairing.userCode);
		const found = await discover(this.#d.http, origin);
		if (!found.ok) return found.unreachable ? text.unreachable(origin, found.message) : text.notAnApp(origin, found.message);
		const app = found.app;
		const other = this.#apps.get(app.id);
		if (other !== undefined && other.origin !== origin) return text.idTaken(app.id, other.origin);
		const client: ClientInfo = {
			host: this.#d.host.host,
			connector: CONNECTOR_NAME,
			connector_version: CONNECTOR_VERSION,
			...(this.#d.host.hostVersion !== undefined ? { host_version: this.#d.host.hostVersion } : {}),
			...(this.#d.host.machineName !== undefined ? { machine_name: this.#d.host.machineName } : {}),
		};
		const out = await startPairing({ http: this.#d.http, now: this.#d.now, app }, client);
		if (out.kind === "rate_limited") return text.rateLimited(out.retryAfterSeconds);
		if (out.kind === "unreachable") return text.unreachable(origin, out.message);
		if (out.kind === "rejected") return text.failed(app.name, out.message);
		const entry: PairingEntry = { app, pairing: out.pairing, retryShown: false };
		this.#pairings.set(origin, entry);
		// A local app may approve at once: then there is no link or code to show.
		const first = await this.#settlePairing(entry, await out.pairing.poll());
		if (first !== null) return first;
		const fields = this.#sharing.ok ? this.#sharing.fieldsFor(app.id) : [];
		const missing = withheld(app.requires, fields);
		const p = out.pairing;
		this.#d.host.display({
			band: text.codeBand(app.name, p.verificationUriComplete, p.userCode),
			toast: { text: text.pairing(app.name, origin, p.verificationUriComplete, p.userCode, parsed.loopback), level: "info" },
		});
		this.#band = text.codeBand(app.name, p.verificationUriComplete, p.userCode);
		const lines = [text.pairing(app.name, origin, p.verificationUriComplete, p.userCode, parsed.loopback)];
		if (missing.length > 0) lines.push(text.requiresWithheld(app.name, missing));
		return lines.join("\n");
	}

	async #pollPairing(entry: PairingEntry): Promise<void> {
		const step = await entry.pairing.poll();
		await this.#serial(async () => {
			if (this.#pairings.get(entry.app.origin) !== entry) return;
			const said = await this.#settlePairing(entry, step);
			if (said !== null) {
				const level = step.kind === "approved" ? "success" : "warning";
				this.#show({ text: said, level });
			} else if (step.kind === "retrying" && !entry.retryShown) {
				entry.retryShown = true;
				this.#show({ text: text.retrying(step.message), level: "warning" });
			} else if (step.kind === "pending") entry.retryShown = false;
		});
	}

	/** A finished pairing's text, or null while it goes on. */
	async #settlePairing(entry: PairingEntry, step: PollStep): Promise<string | null> {
		const { app } = entry;
		if (step.kind === "pending" || step.kind === "retrying") return null;
		this.#pairings.delete(app.origin);
		if (step.kind === "denied") return text.denied(app.name);
		if (step.kind === "expired") return text.expired(app.name);
		if (step.kind === "failed") return text.failed(app.name, step.message);
		const credential: StoredCredential = {
			origin: app.origin,
			appId: app.id,
			appName: app.name,
			token: step.credential.token,
			connectionId: step.credential.connectionId,
			account: step.credential.account,
			discovery: app.raw,
			savedAt: new Date(this.#d.now()).toISOString(),
		};
		let path: string;
		try {
			path = await saveCredential(this.#d.files, this.#d.home, this.#d.host.host, credential);
		} catch (error) {
			return text.saveFailed(app.name, errorText(error));
		}
		// A revoked entry for this origin is replaced, and its links restart.
		this.#apps.delete(app.id);
		this.#load(path, credential);
		this.#show();
		return text.connected(app.name, credential.account, app.origin);
	}

	// ── disconnect ─────────────────────────────────────────────────────────

	async #disconnect(what: string): Promise<string> {
		const want = what.trim();
		if (want === "") return text.disconnectWhich();
		const origin = parseOrigin(want);
		const lower = want.toLowerCase();
		const pairing = [...this.#pairings.values()].find(
			(p) => p.app.id.toLowerCase() === lower || p.app.name.toLowerCase() === lower || (origin.ok && p.app.origin === origin.origin),
		);
		if (pairing !== undefined) {
			this.#pairings.delete(pairing.app.origin);
			this.#band = undefined;
			this.#show();
			return text.pairingStopped(pairing.app.name);
		}
		const app = [...this.#apps.values()].find(
			(a) => a.id.toLowerCase() === lower || a.name.toLowerCase() === lower || (origin.ok && a.origin === origin.origin),
		);
		if (app === undefined) return text.nothingToDisconnect(want);
		// Stop its links first: no request after the revoke carries the token.
		this.#apps.delete(app.id);
		for (const session of this.#sessions) session.dropApp(app.id);
		const res = await door(this.#d.http, { origin: app.origin, url: app.discovery.endpoints.revoke, method: "POST", token: app.token });
		const revoked = res.kind === "answer" && (res.status === 204 || res.status === 200);
		const unknown = res.kind === "answer" && res.status === 401;
		if (!revoked && !unknown) {
			this.#apps.set(app.id, app);
			return text.disconnectUnreachable(app.name, res.kind === "network" ? res.message : `it answered ${res.status}`);
		}
		await this.#d.files.remove(app.path);
		await this.#removeToolsCache(app.origin);
		this.#show();
		return revoked ? text.disconnected(app.name, app.path) : text.disconnectedLocally(app.name, app.path);
	}

	// ── status ─────────────────────────────────────────────────────────────

	#status(): string {
		const lines: string[] = [];
		for (const app of this.#apps.values()) {
			if (app.revoked) {
				lines.push(text.revoked(app.name, app.origin));
				continue;
			}
			const parts = [`${shown(app.name, 80)} (${app.origin}) · connected as ${app.account}`];
			for (const session of this.#sessions) {
				const line = session.describe(app.id);
				if (line !== null) parts.push(line);
			}
			lines.push(`BYOA: ${parts.join(" · ")}`);
		}
		for (const p of this.#pairings.values()) lines.push(text.waiting(p.app.name, p.pairing.verificationUriComplete, p.pairing.userCode));
		lines.push(...this.#problems);
		if (!this.#sharing.ok) lines.push(this.#sharing.message);
		if (lines.length === 0) lines.push(text.noApps());
		return lines.join("\n");
	}

	// ── inside ─────────────────────────────────────────────────────────────

	#load(path: string, credential: StoredCredential): void {
		const checked = checkDiscovery(credential.origin, credential.discovery);
		if (!checked.ok) {
			this.#problems.push(`BYOA: ${path}: ${checked.message}. Disconnect it in the app, delete the file, and connect again.`);
			return;
		}
		const other = this.#apps.get(checked.app.id);
		if (other !== undefined) {
			this.#problems.push(text.idTaken(checked.app.id, other.origin));
			return;
		}
		this.#apps.set(checked.app.id, {
			id: checked.app.id,
			// The name from pairing, not from whatever the app says later.
			name: credential.appName,
			origin: credential.origin,
			token: credential.token,
			discovery: checked.app,
			account: credential.account || "your account",
			path,
			revoked: false,
		});
	}

	#revoked(appId: string): void {
		const app = this.#apps.get(appId);
		if (app === undefined || app.revoked) return;
		app.revoked = true;
		for (const session of this.#sessions) session.dropApp(appId);
		// The credential stays (a reconnect replaces it); the tools cache goes.
		this.#track(this.#removeToolsCache(app.origin));
		this.#show({ text: text.revoked(app.name, app.origin), level: "warning" });
	}

	/** Never fails: a cache left behind is only a stale description. */
	async #removeToolsCache(origin: string): Promise<void> {
		await this.#d.files.remove(toolsCachePath(this.#d.home, this.#d.host.host, origin)).catch(() => undefined);
	}

	async #readSharing(): Promise<void> {
		this.#sharingReadAt = this.#d.now();
		try {
			this.#sharing = await readSharing(this.#d.files, policyPath(this.#d.home));
		} catch (error) {
			this.#sharing = { ok: false, message: `BYOA: could not read ${policyPath(this.#d.home)} (${errorText(error)}); nothing is shared.` };
		}
	}

	/** The standing band: a pairing's code while one runs, else the
	 * connected apps. Drawn only when it changes, or with a toast. */
	#show(toast?: { text: string; level: "info" | "success" | "warning" | "error" }): void {
		const pairing = [...this.#pairings.values()][0];
		const live = [...this.#apps.values()].filter((a) => !a.revoked).map((a) => a.name);
		const band =
			pairing !== undefined
				? text.codeBand(pairing.app.name, pairing.pairing.verificationUriComplete, pairing.pairing.userCode)
				: live.length > 0
					? text.band(live)
					: null;
		if (band === this.#band && toast === undefined) return;
		this.#band = band;
		this.#d.host.display(toast === undefined ? { band } : { band, toast });
	}

	#serial<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	#track(p: Promise<unknown>): void {
		const tracked: Promise<unknown> = p.catch(() => undefined).finally(() => this.#inflight.delete(tracked));
		this.#inflight.add(tracked);
	}
}

const INERT: SessionHandle = {
	turnStarted: () => false,
	delta: () => undefined,
	tool: () => undefined,
	turnEnded: () => undefined,
	foreignPrompt: () => true,
	takenOver: () => undefined,
	isOurs: () => false,
	tools: () => Promise.resolve([] as ProxiedTool[]),
	detach: () => undefined,
};

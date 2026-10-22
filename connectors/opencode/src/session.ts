// One OpenCode session as the connector sees it: the HostSession the core
// drives, and OpenCode's events for that session fed into its handle.
// Rules (from Workspaces' and Machine's OpenCode 2 adapters):
//   - Registered only while a terminal UI shows it (`alive()`); otherwise
//     the host session id reads null, and the core retires it until the TUI
//     is back. Subagent sessions (with a `parentID`) are never attached.
//   - Busy: an execution runs (`session.execution.started` to its end, or
//     `session.status` busy/retry to idle), or a prompt we did not send
//     waits in the session's inbox. A missed end must not hold the app's
//     messages for good: a session that reads running with no event for
//     CROSS_CHECK_MS asks OpenCode (`session.wait`).
//   - Submit: `session.prompt({ delivery: "queue" })`, never steer: a
//     queued prompt starts its own turn, and a steer row would join a turn
//     that started in the same instant. Abort: `session.interrupt`, which
//     the core calls only for our own turn.
//   - Ours: the inbox row whose text the core submitted, from its delivery to
//     the execution's end. Another row enqueued meanwhile silences our turn,
//     and its delivery takes it over.
//   - Text goes out once per block (blocks.ts); tool steps by name only.
//   - A pending permission (`permission.asked`) is `blocked`; the connector
//     never answers it.

import type { HostSession, SessionHandle } from "@plannotator/byoa-connector-core";
import type { SessionSetting, SettingChoice, Workspace } from "@plannotator/byoa-protocol";
import { TextBlocks } from "./blocks.ts";
import type { ModelRef, OcEvent, OcSessionDomain } from "./opencode.ts";

export const CROSS_CHECK_MS = 20_000;
/** A `session.wait` still pending after this means the session runs. */
const IDLE_PROBE_MS = 300;

export interface OcSessionDeps {
	sessionID: string;
	session: OcSessionDomain;
	alive: () => boolean;
	workspace: () => Promise<Workspace>;
	models: () => SettingChoice[];
	now: () => number;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const refText = (m: ModelRef) => `${m.providerID}/${m.id}`;

export class OcSession implements HostSession {
	readonly #d: OcSessionDeps;
	#handle: SessionHandle | null = null;
	#running = false;
	#ours = false;
	/** Inbox rows enqueued and not yet delivered: id → text. */
	readonly #inbox = new Map<string, string>();
	readonly #permissions = new Set<string>();
	readonly #blocks = new TextBlocks();
	#model: ModelRef | null = null;
	#lastEventAt: number;
	/** Events seen: a check whose answer races a new event is ignored. */
	#seen = 0;
	#checking = false;

	constructor(d: OcSessionDeps) {
		this.#d = d;
		this.#lastEventAt = d.now();
	}

	/** Attached after the session may have started running (the TUI says
	 * hello every few seconds): it reads busy until OpenCode says it is idle. */
	attach(handle: SessionHandle, model?: ModelRef): void {
		this.#handle = handle;
		if (model !== undefined) this.#model = model;
		this.#running = true;
		this.#lastEventAt = Number.NEGATIVE_INFINITY;
		this.crossCheck();
	}

	get handle(): SessionHandle | null {
		return this.#handle;
	}

	// ── HostSession ────────────────────────────────────────────────────────

	hostSessionId(): string | null {
		return this.#d.alive() ? this.#d.sessionID : null;
	}
	workspace(): Promise<Workspace> {
		return this.#d.workspace();
	}
	busy(): boolean {
		if (this.#running) return true;
		for (const text of this.#inbox.values()) if (!this.#handle?.isOurs(text)) return true;
		return false;
	}
	blocked(): boolean {
		return this.#permissions.size > 0;
	}
	async submit(text: string): Promise<void> {
		await this.#d.session.prompt({ sessionID: this.#d.sessionID, text, delivery: "queue", metadata: { source: "byoa" } });
	}
	async abort(): Promise<void> {
		await this.#d.session.interrupt({ sessionID: this.#d.sessionID });
	}
	settings(): SessionSetting[] {
		const value = this.#model === null ? null : refText(this.#model);
		const choices = this.#d.models();
		if (choices.length === 0) return [];
		return [{ id: "model", name: "Model", value, choices: value !== null && !choices.some((c) => c.value === value) ? [{ value, name: value }, ...choices] : choices }];
	}
	async applySetting(id: string, value: string): Promise<void> {
		if (id !== "model") throw new Error(`unknown setting ${id}`);
		const slash = value.indexOf("/");
		if (slash <= 0) throw new Error(`not a model: ${value}`);
		const model = { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
		await this.#d.session.switchModel({ sessionID: this.#d.sessionID, model });
		this.#model = model;
	}

	// ── OpenCode's events for this session ─────────────────────────────────

	event(e: OcEvent): void {
		const data = e.data ?? {};
		const h = this.#handle;
		this.#lastEventAt = this.#d.now();
		this.#seen += 1;
		switch (e.type) {
			case "session.inbox.enqueued": {
				const id = str(data.inboxID);
				const item = data.item as { type?: string; payload?: { text?: unknown } } | undefined;
				const text = str(item?.payload?.text) ?? "";
				if (id === undefined || (item?.type !== "user" && item?.type !== "synthetic")) return;
				this.#inbox.set(id, text);
				h?.foreignPrompt(text);
				return;
			}
			case "session.inbox.cancelled":
				this.#inbox.delete(str(data.inboxID) ?? "");
				return;
			case "session.inbox.delivered": {
				const id = str(data.inboxID) ?? "";
				const text = this.#inbox.get(id);
				this.#inbox.delete(id);
				if (h === null || text === undefined) return;
				if (this.#ours && !h.isOurs(text)) {
					this.#ours = false;
					h.takenOver();
				}
				if (!this.#ours && h.turnStarted(text)) {
					this.#ours = true;
					this.#blocks.clear();
				}
				return;
			}
			case "session.execution.started":
				this.#running = true;
				return;
			case "session.status": {
				const type = (data.status as { type?: string } | undefined)?.type;
				if (type === "busy" || type === "retry") this.#running = true;
				else if (type === "idle") this.#idle();
				return;
			}
			case "session.idle":
				return this.#idle();
			case "session.execution.succeeded":
				return this.#end("done");
			case "session.execution.failed":
				return this.#end("error", "turn_failed");
			case "session.execution.interrupted":
				this.#permissions.clear();
				return this.#end("interrupted");
			case "session.text.delta":
				if (this.#ours && typeof data.delta === "string") h?.delta(this.#blocks.delta(str(data.assistantMessageID) ?? "", Number(data.ordinal ?? 0), data.delta));
				return;
			case "session.text.ended":
				if (this.#ours && typeof data.text === "string") {
					const rest = this.#blocks.ended(str(data.assistantMessageID) ?? "", Number(data.ordinal ?? 0), data.text);
					if (rest.length > 0) h?.delta(rest);
				}
				return;
			case "session.tool.input.started":
				if (this.#ours && typeof data.name === "string") h?.tool(data.name);
				return;
			case "session.model.selected":
				if (typeof data.model === "object" && data.model !== null) this.#model = data.model as ModelRef;
				return;
			case "permission.asked":
				if (typeof data.id === "string") this.#permissions.add(data.id);
				return;
			case "permission.replied":
				this.#permissions.delete(str(data.requestID) ?? "");
				return;
		}
	}

	/** Once per connector tick: a run with no event for a while is checked. */
	crossCheck(): void {
		if (!this.#running || this.#checking || this.#d.now() - this.#lastEventAt < CROSS_CHECK_MS) return;
		this.#checking = true;
		const seen = this.#seen;
		const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), IDLE_PROBE_MS));
		const idle = this.#d.session.wait({ sessionID: this.#d.sessionID }).then(
			() => true,
			() => false,
		);
		void Promise.race([idle, timeout]).then((isIdle) => {
			this.#checking = false;
			this.#lastEventAt = this.#d.now();
			if (isIdle && this.#running && this.#seen === seen) this.#end("done");
		});
	}

	#idle(): void {
		if (this.#running) this.#end("done");
	}

	#end(outcome: "done" | "error" | "interrupted", reason?: string): void {
		this.#running = false;
		if (!this.#ours) return;
		this.#ours = false;
		this.#blocks.clear();
		this.#handle?.turnEnded(outcome, reason);
	}
}

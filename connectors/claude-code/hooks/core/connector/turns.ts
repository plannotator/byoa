// GENERATED from packages/connector-core/src/turns.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// The turn scheduler for ONE host session, across every app (forked from
// Workspaces' per-message state machine). It decides when an app's message
// becomes a turn in the host, and which events that app hears about it.
//
//   message ──▶ held ──(host idle for KNOBS.idleTicks ticks, nothing of ours in flight)──▶ starting ──▶ running ──▶ done | error | interrupted
//                 └──(interrupt)──▶ withdrawn
//
// Rules (each came from a review of an earlier connector):
//   - Each (app, message_id) is acted on once: a command that arrives twice
//     (a poll answer lost on the network is handed out again) is ignored.
//     In memory only: two processes on one session rely on the app handing
//     each message to one poll (SPEC 5.2).
//   - Every message waits in the CONNECTOR, never in the host's queue, so an
//     interrupt can withdraw it (Claude Code's `$.prompt.submit` cannot be
//     taken back). It starts only after the host was idle for two ticks in a
//     row, so a prompt the person typed, or a `/clear`, goes first.
//   - One app turn at a time per session, in arrival order across apps.
//   - The text submitted is the provenance line plus the app's text verbatim
//     (turn-text.ts). A text that starts with "/" is refused: on Claude Code
//     it would run a slash command.
//   - `set` is applied through the host, before the turn, and only for
//     settings the session declared, with a value among their choices.
//   - Only our own turns are ever stopped, and only for the app that started
//     them: `interrupt`, or `interrupt_first` from the same app. The person's
//     turn and another app's turn are never aborted; a message that asks to
//     interrupt one waits for it instead.
//   - An interrupt for a message never seen (its poll answer was lost) is
//     answered `withdrawn`.
//   - A turn is ours only when the host reports it started with the exact text
//     we submitted (or a frame around it). Deltas and tools of any other turn
//     are dropped. A prompt we did not submit, announced into our turn,
//     silences it at once; joining it ends the message `interrupted`
//     (`taken_over`), and nothing of that turn is sent after.
//   - When the host session goes away (`/clear`, resume, exit), `retire` ends
//     every message: held ones `withdrawn`, ours in flight `interrupted`
//     (`session_ended`). Nothing is submitted after.

import { shown } from "./clean.ts";
import type { HostSession } from "./host.ts";
import type { Clock } from "./ports.ts";
import { KNOBS, type MessageCommand, type MessageEventBody } from "./protocol.ts";
import { isSlashCommand, matchesTurn, turnText } from "./turn-text.ts";

/** A submitted turn the host has not started after this long, while the host
 * reads idle, ends `error` so the next message is not stuck behind it. */
export const START_TIMEOUT_MS = 60_000;
/** Messages that may wait in one session. Plumbing against a misbehaving
 * app; past it a message ends `error` at once. */
export const MAX_HELD = 64;
/** Finished ids remembered per session, so a late repeat is still known. */
const REMEMBERED = 512;
/** Submitted texts remembered, so a late prompt hook still knows our own. */
const OWN_TEXTS = 32;

export type Phase = "held" | "starting" | "running";

interface Slot {
	readonly appId: string;
	readonly messageId: string;
	readonly text: string;
	readonly stream: boolean;
	readonly set: Record<string, string>;
	phase: Phase;
	stopRequested: boolean;
	startingSince: number;
	silenced: boolean;
}

export interface TurnsDeps {
	host: HostSession;
	now: Clock;
	/** The app's pairing record: the provenance line names it. Null when
	 * the app is no longer connected. */
	app: (appId: string) => { name: string; origin: string } | null;
	emit: (appId: string, messageId: string, event: MessageEventBody) => void;
	warn?: (message: string) => void;
}

export class Turns {
	readonly #d: TurnsDeps;
	readonly #slots = new Map<string, Slot>();
	readonly #held: Slot[] = [];
	readonly #finished: string[] = [];
	readonly #finishedSet = new Set<string>();
	readonly #ownTexts: string[] = [];
	#idleTicks = 0;
	#retired = false;

	constructor(deps: TurnsDeps) {
		this.#d = deps;
	}

	/** The turn of ours the host has, or is about to have. */
	get inFlight(): Slot | null {
		for (const slot of this.#slots.values()) if (slot.phase !== "held") return slot;
		return null;
	}

	get heldCount(): number {
		return this.#held.length;
	}

	/** What the poll says. Held messages do not make the session busy. */
	get state(): "ready" | "busy" | "blocked" {
		if (this.#d.host.blocked()) return "blocked";
		return this.#d.host.busy() || this.inFlight !== null ? "busy" : "ready";
	}

	/** The message whose turn runs now, if it is this app's (tool `_meta`). */
	runningMessage(appId: string): string | null {
		const slot = this.inFlight;
		return slot !== null && slot.phase === "running" && slot.appId === appId ? slot.messageId : null;
	}

	message(appId: string, cmd: MessageCommand): void {
		const key = keyOf(appId, cmd.message_id);
		if (this.#slots.has(key) || this.#finishedSet.has(key)) return;
		const app = this.#d.app(appId);
		if (app === null || this.#retired) return this.#refuse(appId, cmd.message_id, { type: "withdrawn", reason: "session_ended" });
		if (isSlashCommand(cmd.text)) return this.#refuse(appId, cmd.message_id, { type: "error", reason: "refused_slash_command" });
		if (!this.#settable(cmd.set)) return this.#refuse(appId, cmd.message_id, { type: "error", reason: "setting_not_declared" });
		if (this.#held.length >= MAX_HELD) return this.#refuse(appId, cmd.message_id, { type: "error", reason: "too_many_waiting" });
		const busy = this.#d.host.busy() || this.#d.host.blocked() || this.inFlight !== null || this.#held.length > 0;
		const slot: Slot = {
			appId,
			messageId: cmd.message_id,
			text: turnText(app, cmd),
			stream: cmd.stream,
			set: cmd.set ?? {},
			phase: "held",
			stopRequested: false,
			startingSince: 0,
			silenced: false,
		};
		this.#slots.set(key, slot);
		this.#held.push(slot);
		if (cmd.interrupt_first) {
			// Only a turn of OURS, started by this same app, is stopped for it.
			const flying = this.inFlight;
			if (flying !== null && flying.appId === appId) this.#stop(flying);
		}
		if (busy) this.#d.emit(appId, cmd.message_id, { type: "queued" });
	}

	interrupt(appId: string, messageId: string): void {
		const key = keyOf(appId, messageId);
		const slot = this.#slots.get(key);
		if (slot === undefined) {
			if (this.#finishedSet.has(key)) return;
			// Never seen: its poll answer was lost. It never reaches the host.
			return this.#refuse(appId, messageId, { type: "withdrawn" });
		}
		if (slot.phase === "held") {
			this.#unhold(slot);
			return this.#finish(slot, { type: "withdrawn" });
		}
		this.#stop(slot);
	}

	/** Once per connector tick: count idle ticks, give up on a submission
	 * the host never started, and start the next held message when due. */
	tick(): void {
		const flying = this.inFlight;
		const idle = !this.#d.host.busy() && !this.#d.host.blocked();
		if (flying?.phase === "starting" && idle && this.#d.now() - flying.startingSince > START_TIMEOUT_MS)
			this.#finish(flying, { type: "error", reason: "not_started" });
		this.#idleTicks = idle && this.inFlight === null ? this.#idleTicks + 1 : 0;
		if (this.#retired || this.inFlight !== null || this.#idleTicks < KNOBS.idleTicks) return;
		const next = this.#held.shift();
		if (next === undefined) return;
		// The count starts over with each turn of ours: one that starts and
		// ends between two ticks must not leave it at "due" for the next.
		this.#idleTicks = 0;
		void this.#start(next);
	}

	// ── what the host reports ──────────────────────────────────────────────

	turnStarted(prompt: string): boolean {
		const slot = this.inFlight;
		if (slot !== null && slot.phase === "starting" && matchesTurn(prompt, slot.text)) {
			slot.phase = "running";
			if (slot.stopRequested) this.#abort();
			return true;
		}
		this.#idleTicks = 0;
		return false;
	}

	delta(text: string): void {
		const slot = this.#live();
		if (slot !== null && slot.stream && text.length > 0) this.#d.emit(slot.appId, slot.messageId, { type: "delta", text });
	}

	tool(name: string, title?: string): void {
		const slot = this.#live();
		const n = shown(name, 255);
		if (slot === null || n.length === 0) return;
		this.#d.emit(slot.appId, slot.messageId, { type: "tool", name: n, title: shown(title ?? name, 255) || n });
	}

	turnEnded(outcome: "done" | "error" | "interrupted", reason?: string): void {
		const slot = this.inFlight;
		if (slot === null || slot.phase !== "running") return;
		if (outcome === "done") this.#finish(slot, { type: "done" });
		else if (outcome === "error") this.#finish(slot, { type: "error", reason: shown(reason ?? "", 120) || "turn_failed" });
		else this.#finish(slot, { type: "interrupted", reason: "stopped" });
	}

	foreignPrompt(prompt?: string): boolean {
		if (prompt !== undefined && this.isOurs(prompt)) return false;
		this.#idleTicks = 0;
		const slot = this.inFlight;
		if (slot !== null && slot.phase === "running") slot.silenced = true;
		return true;
	}

	takenOver(): void {
		const slot = this.inFlight;
		if (slot !== null && slot.phase === "running") this.#finish(slot, { type: "interrupted", reason: "taken_over" });
	}

	isOurs(prompt: string): boolean {
		return this.#ownTexts.some((text) => matchesTurn(prompt, text));
	}

	/** The host session is gone: every message ends here. */
	retire(): void {
		this.#retired = true;
		for (const slot of [...this.#slots.values()]) {
			this.#finish(slot, slot.phase === "held" ? { type: "withdrawn", reason: "session_ended" } : { type: "interrupted", reason: "session_ended" });
		}
		this.#held.length = 0;
	}

	/** The app was disconnected or revoked: forget its messages without a
	 * word (no request may carry its token any more). */
	forgetApp(appId: string): void {
		for (const [key, slot] of this.#slots) {
			if (slot.appId !== appId) continue;
			this.#slots.delete(key);
			this.#unhold(slot);
		}
	}

	// ── inside ─────────────────────────────────────────────────────────────

	async #start(slot: Slot): Promise<void> {
		slot.phase = "starting";
		slot.startingSince = this.#d.now();
		const host = this.#d.host;
		try {
			for (const [id, value] of Object.entries(slot.set)) await host.applySetting?.(id, value);
		} catch (error) {
			this.#d.warn?.(`BYOA: a setting could not be applied (${shown(String(error))}).`);
			if (this.#current(slot)) this.#finish(slot, { type: "error", reason: "setting_failed" });
			return;
		}
		if (!this.#current(slot)) return;
		if (slot.stopRequested || this.#retired) return this.#finish(slot, { type: "withdrawn" });
		this.#remember(this.#ownTexts, slot.text, OWN_TEXTS);
		this.#d.emit(slot.appId, slot.messageId, { type: "started" });
		try {
			await host.submit(slot.text);
		} catch (error) {
			this.#d.warn?.(`BYOA: the agent did not take a message (${shown(String(error))}).`);
			if (this.#current(slot) && slot.phase === "starting") this.#finish(slot, { type: "error", reason: "submit_failed" });
		}
	}

	#settable(set: Record<string, string> | undefined): boolean {
		if (set === undefined) return true;
		const declared = this.#d.host.settings?.() ?? [];
		return Object.entries(set).every(([id, value]) => {
			const setting = declared.find((s) => s.id === id);
			return setting !== undefined && this.#d.host.applySetting !== undefined && (setting.choices.length === 0 || setting.choices.some((c) => c.value === value));
		});
	}

	#stop(slot: Slot): void {
		if (slot.stopRequested) return;
		slot.stopRequested = true;
		// Not submitted yet: #start withdraws it. Submitted, not started: it is
		// aborted the moment it starts (turnStarted).
		if (slot.phase === "running") this.#abort();
	}

	#abort(): void {
		this.#d.host.abort?.().catch((error: unknown) => this.#d.warn?.(`BYOA: could not stop the turn (${shown(String(error))}).`));
	}

	/** The running turn of ours, unless silenced. */
	#live(): Slot | null {
		const slot = this.inFlight;
		return slot !== null && slot.phase === "running" && !slot.silenced ? slot : null;
	}

	#current(slot: Slot): boolean {
		return this.#slots.get(keyOf(slot.appId, slot.messageId)) === slot;
	}

	#unhold(slot: Slot): void {
		const at = this.#held.indexOf(slot);
		if (at >= 0) this.#held.splice(at, 1);
	}

	#finish(slot: Slot, event: MessageEventBody): void {
		const key = keyOf(slot.appId, slot.messageId);
		this.#slots.delete(key);
		this.#unhold(slot);
		this.#remember(this.#finished, key, REMEMBERED, this.#finishedSet);
		this.#d.emit(slot.appId, slot.messageId, event);
	}

	#refuse(appId: string, messageId: string, event: MessageEventBody): void {
		this.#remember(this.#finished, keyOf(appId, messageId), REMEMBERED, this.#finishedSet);
		this.#d.emit(appId, messageId, event);
	}

	#remember(list: string[], value: string, max: number, set?: Set<string>): void {
		list.push(value);
		set?.add(value);
		while (list.length > max) {
			const old = list.shift() as string;
			set?.delete(old);
		}
	}
}

function keyOf(appId: string, messageId: string): string {
	return `${appId}\u0000${messageId}`;
}

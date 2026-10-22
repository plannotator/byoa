// Pi's turn events, fed into the connector's SessionHandle. The core decides
// which turn is ours (by the text it submitted); this file only says what
// Pi did, in the order Pi did it. Rules (forked from Workspaces' Pi adapter):
//   - A run is busy from `agent_start` to `agent_settled`, never to
//     `agent_end`: Pi may retry, compact or run queued follow-ups after
//     `agent_end`, so that only notes how the run ended, and our message
//     ends at `agent_settled`. A new assistant message after an error is a
//     retry: the error is forgotten and the turn goes on.
//   - Our turn starts at the `message_start` of OUR custom message.
//   - Another party entering our run silences it at once and ends it
//     `taken_over` when it joins: the person pressing Enter (`input`), a user
//     message starting, another extension's custom message (which Pi may add
//     at a turn boundary without a `message_start`, so the `context` sent to
//     the model is checked too).
//   - A blocking extension prompt (`ui_prompt_start`) is `blocked`.
//   - Tool steps report the tool's name only, and only the main loop's.

import type { SessionHandle } from "@plannotator/byoa-connector-core";
import { textOf, type PiEvents, type PiMessage } from "./pi.ts";

export const CUSTOM_TYPE = "byoa";

type RunEnd = { outcome: "done" | "error" | "interrupted"; reason?: string };

export class PiTurns {
	/** Null until the connector attached the session: Pi's busy state is
	 * still followed, and nothing is reported. */
	#handle: SessionHandle | null = null;
	/** From `agent_start` to `agent_end`. */
	running = false;
	/** From `agent_end` to `agent_settled`: Pi may still run again. */
	settling = false;
	/** Blocking extension prompts open now. */
	prompts = 0;
	/** The running turn is ours (the core said so at its start). */
	#ours = false;
	/** Another extension's message entered our run. */
	#announced = false;
	#runEnd: RunEnd | null = null;

	attach(handle: SessionHandle): void {
		this.#handle = handle;
	}

	get ours(): boolean {
		return this.#ours;
	}

	agentStart(): void {
		this.running = true;
	}

	messageStart(event: PiEvents["message_start"]): void {
		const h = this.#handle;
		if (h === null) return;
		const m = event.message;
		const text = textOf(m.content);
		if (m.role === "custom" && m.customType === CUSTOM_TYPE && h.isOurs(text)) {
			if (!this.#ours && h.turnStarted(text)) {
				this.#ours = true;
				this.#announced = false;
				this.#runEnd = null;
			}
			return;
		}
		if (this.#ours && (m.role === "user" || (m.role === "assistant" && this.#announced))) return this.#takenOver();
		if (this.#ours && m.role === "custom") {
			this.#announced = true;
			h.foreignPrompt();
			return;
		}
		// A retry after an error: the turn goes on.
		if (this.#ours && m.role === "assistant") this.#runEnd = null;
		if (!this.#ours && m.role === "user") h.turnStarted(text);
	}

	/** Before every model call: a user or foreign custom message after ours
	 * means the next answer is not ours alone. */
	context(event: PiEvents["context"]): void {
		const h = this.#handle;
		if (!this.#ours || h === null) return;
		const mine = (m: PiMessage) => m.role === "custom" && m.customType === CUSTOM_TYPE && h.isOurs(textOf(m.content));
		const at = event.messages.findLastIndex(mine);
		if (at < 0) return;
		if (event.messages.slice(at + 1).some((m) => m.role === "user" || (m.role === "custom" && !mine(m)))) this.#takenOver();
	}

	/** The person (or another extension) submitted a prompt. */
	input(event: PiEvents["input"]): void {
		this.#handle?.foreignPrompt(event.text);
	}

	messageUpdate(event: PiEvents["message_update"]): void {
		const e = event.assistantMessageEvent;
		if (this.#ours && e.type === "text_delta" && typeof e.delta === "string") this.#handle?.delta(e.delta);
	}

	toolStart(event: PiEvents["tool_execution_start"] & { parentToolCallId?: string }): void {
		if (this.#ours && event.parentToolCallId === undefined) this.#handle?.tool(event.toolName);
	}

	agentEnd(event: PiEvents["agent_end"]): void {
		this.running = false;
		this.settling = true;
		if (!this.#ours) return;
		const last = [...event.messages].reverse().find((m) => m.role === "assistant");
		if (last?.stopReason === "aborted") this.#runEnd = { outcome: "interrupted" };
		else if (last?.stopReason === "error") this.#runEnd = { outcome: "error", reason: "turn_failed" };
		else this.#runEnd = { outcome: "done" };
	}

	agentSettled(): void {
		this.running = false;
		this.settling = false;
		if (!this.#ours) return;
		const end = this.#runEnd ?? { outcome: "done" as const };
		this.#ours = false;
		this.#runEnd = null;
		this.#handle?.turnEnded(end.outcome, end.reason);
	}

	uiPrompt(open: boolean): void {
		this.prompts = Math.max(0, this.prompts + (open ? 1 : -1));
	}

	#takenOver(): void {
		this.#ours = false;
		this.#runEnd = null;
		this.#handle?.takenOver();
	}
}

// The shape check of a message, shared by the UI door and byoa.send so both
// obey one set of rules. What depends on the session (interrupt support,
// declared settings, gone) is checked by the hub.

import { isRecord, LIMITS, type MessageKind, type Parsed } from "@plannotator/byoa-protocol";
import type { SendInput } from "./store.ts";

const KINDS: readonly MessageKind[] = ["chat", "task", "reply", "notice"];

export function parseSend(body: unknown, defaults: { kind: MessageKind; from: string }): Parsed<SendInput> {
	if (!isRecord(body)) return { ok: false, reason: "body: an object" };
	const { text, kind = defaults.kind, interrupt_first = false, stream = true, set } = body;
	if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "text: must not be empty" };
	if (text.length > LIMITS.text) return { ok: false, reason: `text: at most ${LIMITS.text} characters` };
	if (!KINDS.includes(kind as MessageKind)) return { ok: false, reason: "kind: chat, task, reply or notice" };
	if (typeof interrupt_first !== "boolean") return { ok: false, reason: "interrupt_first: a boolean" };
	if (typeof stream !== "boolean") return { ok: false, reason: "stream: a boolean" };
	if (set !== undefined) {
		if (!isRecord(set) || Object.keys(set).length > LIMITS.settings) return { ok: false, reason: "set: a short object" };
		for (const value of Object.values(set)) if (typeof value !== "string" || value.length > LIMITS.name) return { ok: false, reason: "set: string values" };
	}
	return {
		ok: true,
		value: {
			text,
			kind: kind as MessageKind,
			interrupt_first,
			stream,
			...(set !== undefined ? { set: set as Record<string, string> } : {}),
			from: { display_name: defaults.from },
		},
	};
}

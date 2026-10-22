// One Pi session as the connector sees it (HostSession), and the settings an
// app may set before a turn: the model and the thinking level (Machine's
// pair: `pi.setModel`, `pi.setThinkingLevel`).
//   - Busy: a run between `agent_start` and `agent_settled`, Pi not idle, or
//     a message waiting in Pi's own queue.
//   - Submit: a custom message with `triggerTurn` and `deliverAs:
//     "followUp"`, never steer. The core submits only when Pi has been idle
//     for two ticks, so a follow-up never joins a running turn.
//   - Abort: `ctx.abort()`, which the core calls only for our own turn.
//   - A context from a replaced runtime throws on any use: every call is
//     guarded, and a stale context reads busy (nothing is submitted to it).

import type { HostSession } from "@plannotator/byoa-connector-core";
import type { SessionSetting, SettingChoice, Workspace } from "@plannotator/byoa-protocol";
import type { PiApi, PiContext } from "./pi.ts";
import { CUSTOM_TYPE, type PiTurns } from "./turns.ts";

export const EFFORTS: SettingChoice[] = [
	{ value: "off", name: "Off" },
	{ value: "minimal", name: "Minimal" },
	{ value: "low", name: "Low" },
	{ value: "medium", name: "Medium" },
	{ value: "high", name: "High" },
	{ value: "xhigh", name: "Extra high" },
];
/** The model list is read from Pi's registry at most this often. */
const MODELS_EVERY_MS = 30_000;
/** A picker, not a catalogue. */
const MAX_MODELS = 40;

export interface PiHostDeps {
	pi: PiApi;
	ctx: () => PiContext | null;
	turns: PiTurns;
	workspace: () => Promise<Workspace>;
	now: () => number;
}

export function piHostSession(d: PiHostDeps): HostSession {
	let models: { at: number; list: SettingChoice[] } = { at: Number.NEGATIVE_INFINITY, list: [] };
	const use = <T>(fn: (ctx: PiContext) => T, fallback: T): T => {
		const ctx = d.ctx();
		if (ctx === null) return fallback;
		try {
			return fn(ctx);
		} catch {
			return fallback;
		}
	};
	const modelChoices = (ctx: PiContext): SettingChoice[] => {
		if (d.now() - models.at >= MODELS_EVERY_MS) {
			const seen = new Map<string, SettingChoice>();
			for (const m of ctx.modelRegistry.getAvailable()) seen.set(`${m.provider}/${m.id}`, { value: `${m.provider}/${m.id}`, name: m.name ?? m.id });
			models = { at: d.now(), list: [...seen.values()].slice(0, MAX_MODELS) };
		}
		return models.list;
	};
	return {
		hostSessionId: () => use((ctx) => ctx.sessionManager.getSessionId() || null, null),
		workspace: d.workspace,
		busy: () => d.turns.running || d.turns.settling || use((ctx) => !ctx.isIdle() || ctx.hasPendingMessages(), true),
		blocked: () => d.turns.prompts > 0,
		submit: async (text) => {
			d.pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true }, { triggerTurn: true, deliverAs: "followUp" });
		},
		abort: async () => {
			const ctx = d.ctx();
			if (ctx === null) throw new Error("the session is gone");
			ctx.abort();
		},
		settings: () =>
			use((ctx): SessionSetting[] => {
				const current = ctx.model === undefined ? null : `${ctx.model.provider}/${ctx.model.id}`;
				const choices = modelChoices(ctx);
				return [
					{ id: "model", name: "Model", value: current, choices: current !== null && !choices.some((c) => c.value === current) ? [{ value: current, name: current }, ...choices] : choices },
					{ id: "effort", name: "Thinking", value: ctx.thinkingLevel ?? d.pi.getThinkingLevel(), choices: EFFORTS },
				];
			}, []),
		applySetting: async (id, value) => {
			const ctx = d.ctx();
			if (ctx === null) throw new Error("the session is gone");
			if (id === "effort") return d.pi.setThinkingLevel(value);
			if (id !== "model") throw new Error(`unknown setting ${id}`);
			const slash = value.indexOf("/");
			const model = slash > 0 ? ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1)) : undefined;
			if (model === undefined) throw new Error(`Pi has no model ${value}`);
			if (!(await d.pi.setModel(model))) throw new Error(`${value} needs a login`);
		},
	};
}

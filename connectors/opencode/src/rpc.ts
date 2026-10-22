// The channel between the TUI half and the server half (OpenCode's plugin
// RPC: the server half registers it, the TUI calls it over the TUI's client).
//   - hello: every few seconds while a terminal UI runs, with the sessions it
//     shows (the one on screen, open tabs). Only those sessions register, and
//     only while hellos keep coming: the TUI being there is the interactive
//     check, which the server half cannot see by itself.
//   - command: `/byoa <args>` typed in the TUI; the answer is shown as a toast.
//   - display (event): what the connector wants drawn (its band or a toast).

export const RPC = {
	id: "byoa",
	methods: {
		hello: {
			input: { type: "object", properties: { sessions: { type: "array", items: { type: "string" } } }, required: ["sessions"] },
			output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		},
		command: {
			input: { type: "object", properties: { args: { type: "string" }, sessionID: { type: "string" } }, required: ["args"] },
			output: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		},
	},
	events: {
		display: { schema: { type: "object", additionalProperties: true } },
	},
} as const;

/** A TUI that sent no hello for this long is gone. */
export const PRESENCE_MS = 10_000;
export const HELLO_EVERY_MS = 2_000;

export interface DisplayEvent {
	band: string | null;
	toast?: { text: string; level: "info" | "success" | "warning" | "error" };
}

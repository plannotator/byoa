// The TUI half against a fake TUI context: its hellos name the sessions on
// screen, `/byoa` goes to the server half, and display events become toasts.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { OcTuiContext } from "../src/opencode.ts";
import { tui } from "../src/tui.ts";

function fakeTui() {
	const hellos: string[][] = [];
	const commands: { args: string; sessionID?: string }[] = [];
	const toasts: { message: string; variant?: string; duration?: number }[] = [];
	const listeners = new Map<string, (e: { data: Record<string, unknown> }) => void>();
	let slash: { slash?: { name: string }; run: (input?: string) => Promise<void> } | undefined;
	const ctx: OcTuiContext = {
		client: {
			rpc: () => ({
				hello: async (input) => void hellos.push(input.sessions),
				command: async (input) => {
					commands.push(input);
					return { text: "BYOA: Notes (http://localhost:4300) · connected as Ramos" };
				},
				events: {
					on: (name, handler) => {
						listeners.set(name, handler);
						return () => listeners.delete(name);
					},
				},
			}),
		},
		ui: {
			toast: { show: (o) => void toasts.push(o) },
			router: { current: () => ({ type: "session", sessionID: "ses_a" }) },
			tabs: { enabled: () => true, list: () => [{ sessionID: "ses_a" }, { sessionID: "ses_b" }] },
			slot: (claim) => {
				claim.render();
				return () => undefined;
			},
		},
		keymap: {
			layer: (factory) => {
				slash = factory().commands[0] as typeof slash;
			},
		},
	};
	return { ctx, hellos, commands, toasts, listeners, slash: () => slash };
}

test("hello names the session on screen and the open tabs; /byoa runs in the server half", async () => {
	const f = fakeTui();
	const stop = tui(f.ctx);
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(f.hellos[0], ["ses_a", "ses_b"]);
	assert.equal(f.slash()?.slash?.name, "byoa");
	await f.slash()?.run("status");
	assert.deepEqual(f.commands, [{ args: "status", sessionID: "ses_a" }]);
	assert.match(f.toasts.at(-1)?.message ?? "", /connected as Ramos/);
	stop();
	assert.equal(f.listeners.size, 0);
});

test("display events: a toast as given, a changed band as a toast, the same band once", () => {
	const f = fakeTui();
	const stop = tui(f.ctx);
	const display = f.listeners.get("display")!;
	display({ data: { band: "BYOA · Notes" } });
	display({ data: { band: "BYOA · Notes" } });
	display({ data: { band: "BYOA · Notes", toast: { text: "BYOA: Notes disconnected this agent", level: "warning" } } });
	assert.deepEqual(
		f.toasts.map((t) => [t.message, t.variant]),
		[
			["BYOA · Notes", "info"],
			["BYOA: Notes disconnected this agent", "warning"],
		],
	);
	stop();
});

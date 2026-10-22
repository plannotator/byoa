// @plannotator/byoa-opencode, the `./tui` half. OpenCode loads it only when a terminal
// UI is attached, so its being loaded is the interactive check. It holds no
// connector and no token; it only:
//   - says hello to the server half every HELLO_EVERY_MS with the sessions
//     it shows (the one on screen, open tabs), so those register;
//   - binds `/byoa connect <url> | disconnect <app> | status` and shows the
//     answer as a toast (nothing is written into the session, which the
//     model would read);
//   - shows what the connector asks to draw: its band as a toast when it
//     changes (OpenCode has no standing line a plugin can own), and its
//     toasts. A pairing code stays up long enough to switch to the browser.
// The slash command is registered from a component in the `app` slot,
// because a keymap layer made during setup has no provider yet.

import type { OcTuiContext } from "./opencode.ts";
import { HELLO_EVERY_MS, RPC, type DisplayEvent } from "./rpc.ts";

const TITLE = "BYOA";
const NOTICE_MS = 12_000;
const CODE_MS = 120_000;

export function tui(ctx: OcTuiContext): () => void {
	const rpc = ctx.client.rpc(RPC);
	const toast = (message: string, variant: "info" | "success" | "warning" | "error", duration = NOTICE_MS) => {
		try {
			ctx.ui.toast.show({ title: TITLE, message, variant, duration });
		} catch {
			// The TUI is closing.
		}
	};
	const shown = (): string[] => {
		const ids = new Set<string>();
		const route = ctx.ui.router.current();
		if (route.type === "session" && route.sessionID !== undefined) ids.add(route.sessionID);
		if (ctx.ui.tabs.enabled()) for (const tab of ctx.ui.tabs.list()) ids.add(tab.sessionID);
		return [...ids];
	};
	const hello = () => void rpc.hello({ sessions: shown() }).catch(() => undefined);
	const timer = setInterval(hello, HELLO_EVERY_MS);
	hello();

	let lastBand: string | null = null;
	const off = rpc.events.on("display", (event) => {
		const d = event.data as unknown as DisplayEvent;
		if (d.toast) toast(d.toast.text, d.toast.level, d.band !== lastBand && d.toast.level === "info" ? CODE_MS : NOTICE_MS);
		else if (d.band !== null && d.band !== lastBand) toast(d.band, "info");
		lastBand = d.band;
	});

	const releaseSlot = ctx.ui.slot({
		append: "app",
		render: () => {
			ctx.keymap.layer(() => ({
				commands: [
					{
						id: "byoa.command",
						title: "BYOA: connect <address> | disconnect <app> | status",
						description: "Connect this agent to a BYOA app, list connections, or disconnect one",
						group: "BYOA",
						palette: true,
						slash: { name: "byoa", arguments: true },
						run: async (input?: string) => {
							const route = ctx.ui.router.current();
							try {
								const { text } = await rpc.command({ args: input ?? "", ...(route.type === "session" && route.sessionID !== undefined ? { sessionID: route.sessionID } : {}) });
								toast(text, "info", /code [A-Z]{4}-[A-Z]{4}/.test(text) ? CODE_MS : NOTICE_MS);
							} catch (error) {
								toast(`BYOA: ${error instanceof Error ? error.message : String(error)}`, "error");
							}
						},
					},
				],
			}));
			return null;
		},
	});

	return () => {
		clearInterval(timer);
		off();
		releaseSlot();
	};
}

export default {
	id: "byoa.tui",
	setup: (ctx: OcTuiContext) => tui(ctx),
};

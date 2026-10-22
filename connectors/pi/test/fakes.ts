// A fake Pi for the adapter tests: it records what the extension asked of
// Pi and lets a test raise Pi's events in Pi's order. Paired with the core's
// fake apps (packages/connector-core/test/fakes.ts) and a scripted clock, so
// a test drives one message from the app's queue to its events, with no
// sockets and no sleeps.
import { Connector, type HostAdapter } from "@plannotator/byoa-connector-core";
import { FakeNet, flush, HOME, MemoryFiles, world, type World } from "../../../packages/connector-core/test/fakes.ts";
import type { FakeAppOptions } from "../../../packages/connector-core/test/fakes.ts";
import { byoaExtension } from "../src/index.ts";
import type { PiApi, PiContext, PiEvents, PiModel, PiToolDefinition } from "../src/pi.ts";

export const NOTES: FakeAppOptions = {
	id: "notes",
	name: "Notes",
	origin: "http://127.0.0.1:4100",
	mcp: true,
	tools: [{ name: "add_note", description: "Save a note.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
};
export const TASKS: FakeAppOptions = { id: "tasks", name: "Tasks", origin: "http://127.0.0.1:4200" };

export class FakeCtx implements PiContext {
	mode: PiContext["mode"] = "tui";
	cwd = "/home/dana/code/northstar";
	idle = true;
	pending = false;
	aborts = 0;
	stale = false;
	sessionId = "pi-session-1";
	readonly notes: string[] = [];
	readonly widgets: (string[] | undefined)[] = [];
	readonly models: PiModel[] = [
		{ provider: "echo", id: "echo-1" },
		{ provider: "echo", id: "echo-2" },
	];
	model: PiModel | undefined = this.models[0];
	thinkingLevel = "medium";
	ui = {
		notify: (message: string) => {
			this.#check();
			this.notes.push(message);
		},
		setWidget: (_key: string, content: string[] | undefined) => {
			this.#check();
			this.widgets.push(content);
		},
	};
	sessionManager = { getSessionId: () => (this.#check(), this.sessionId) };
	modelRegistry = {
		getAvailable: () => this.models,
		find: (provider: string, id: string) => this.models.find((m) => m.provider === provider && m.id === id),
	};
	isIdle() {
		this.#check();
		return this.idle;
	}
	abort() {
		this.#check();
		this.aborts += 1;
	}
	hasPendingMessages() {
		this.#check();
		return this.pending;
	}
	#check() {
		if (this.stale) throw new Error("This extension ctx is stale after session replacement or reload.");
	}
}

export class FakePi implements PiApi {
	readonly handlers = new Map<string, ((event: unknown, ctx: PiContext) => unknown)[]>();
	readonly tools: PiToolDefinition[] = [];
	readonly commands = new Map<string, (args: string, ctx: PiContext) => Promise<void>>();
	readonly sent: { content: string; options: unknown; customType: string }[] = [];
	readonly setModels: string[] = [];
	thinking = "medium";
	ctx = new FakeCtx();

	on<E extends keyof PiEvents>(event: E, handler: (event: PiEvents[E], ctx: PiContext) => unknown): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler as (event: unknown, ctx: PiContext) => unknown);
		this.handlers.set(event, list);
	}
	registerTool(tool: PiToolDefinition) {
		this.tools.push(tool);
	}
	registerCommand(name: string, options: { handler: (args: string, ctx: PiContext) => Promise<void> }) {
		this.commands.set(name, options.handler);
	}
	sendMessage(message: { customType: string; content: string }, options?: unknown) {
		this.sent.push({ content: message.content, options, customType: message.customType });
	}
	async setModel(model: PiModel) {
		this.setModels.push(`${model.provider}/${model.id}`);
		this.ctx.model = model;
		return true;
	}
	getThinkingLevel() {
		return this.thinking;
	}
	setThinkingLevel(level: string) {
		this.thinking = level;
		this.ctx.thinkingLevel = level;
	}
	emit<E extends keyof PiEvents>(event: E, e: PiEvents[E]): unknown[] {
		return (this.handlers.get(event) ?? []).map((h) => h(e, this.ctx));
	}
	async command(args: string): Promise<string | undefined> {
		await this.commands.get("byoa")?.(args, this.ctx);
		return this.ctx.notes.at(-1);
	}

	// Pi's own sequence for a turn that starts with a message.
	startTurn(content: string, role: "custom" | "user" = "custom") {
		this.ctx.idle = false;
		this.emit("agent_start", {});
		this.emit("message_start", { message: role === "custom" ? { role, customType: "byoa", content } : { role, content } });
	}
	say(text: string) {
		this.emit("message_start", { message: { role: "assistant", content: [] } });
		this.emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type: "text_delta", delta: text } });
	}
	endTurn(stopReason = "stop") {
		this.emit("agent_end", { messages: [{ role: "assistant", stopReason }] });
		this.ctx.idle = true;
		this.emit("agent_settled", {});
	}
}

export interface PiWorld extends World {
	pi: FakePi;
	/** One connector tick on the scripted clock, then the network settles. */
	step: (n?: number) => Promise<void>;
}

/** Pi with the extension loaded and a TUI session started, against fake
 * apps that are already paired. */
export async function piWorld(apps: FakeAppOptions[] = [NOTES], o: { mode?: PiContext["mode"] } = {}): Promise<PiWorld> {
	const w = await world(apps, { attach: false, host: "pi" });
	const pi = new FakePi();
	if (o.mode) pi.ctx.mode = o.mode;
	let connector: Connector | null = null;
	await byoaExtension({
		version: "1.0.2",
		tickMs: 2 ** 30,
		connector: (host: HostAdapter) => (connector = new Connector({ host, http: w.net.http, files: w.files, now: () => w.clock.t, home: HOME, random: () => 0.5 })),
	})(pi);
	pi.emit("session_start", { reason: "startup" });
	await flush();
	const step = async (n = 1) => {
		for (let i = 0; i < n; i++) {
			w.clock.t += 1000;
			await connector?.tick();
			await flush();
		}
	};
	await step();
	return { ...w, pi, step, connector: connector ?? w.connector };
}

export { FakeNet, flush, MemoryFiles };

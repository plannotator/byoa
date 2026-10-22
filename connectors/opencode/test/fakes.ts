// A fake OpenCode 2 server-plugin context for the adapter tests: it records
// prompts, interrupts, model switches, the tools added through the
// transform and the RPC display events, and lets a test say hello as a TUI
// and raise OpenCode's session events. Paired with the core's fake apps.
import { Connector, type HostAdapter } from "@plannotator/byoa-connector-core";
import { flush, HOME, world, type FakeAppOptions, type World } from "../../../packages/connector-core/test/fakes.ts";
import type { OcEvent, OcServerContext, OcSessionInfo, OcToolEditor } from "../src/opencode.ts";
import { serve, type Running } from "../src/server.ts";

export const NOTES: FakeAppOptions = {
	id: "notes",
	name: "Notes",
	origin: "http://127.0.0.1:4100",
	mcp: true,
	tools: [{ name: "add_note", description: "Save a note.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
};
export const TASKS: FakeAppOptions = { id: "tasks", name: "Tasks", origin: "http://127.0.0.1:4200" };

type Tool = Parameters<OcToolEditor["add"]>[0];

export class FakeOpenCode implements OcServerContext {
	readonly app = { version: "2.1.2" };
	readonly location = { directory: "/home/dana/code/northstar" };
	readonly infos = new Map<string, OcSessionInfo>([["ses_root", { id: "ses_root", model: { providerID: "echo", id: "echo-1" } }]]);
	readonly prompts: { sessionID: string; text: string; delivery: string }[] = [];
	readonly interrupts: string[] = [];
	readonly switched: string[] = [];
	readonly tools: Tool[] = [];
	readonly displays: Record<string, unknown>[] = [];
	idle = true;
	reloads = 0;

	readonly session = {
		get: async ({ sessionID }: { sessionID: string }) => {
			const i = this.infos.get(sessionID);
			if (!i) throw new Error("no such session");
			return i;
		},
		prompt: async (input: { sessionID: string; text: string; delivery: "queue" | "steer" }) => {
			this.prompts.push(input);
			return {};
		},
		interrupt: async ({ sessionID }: { sessionID: string }) => {
			this.interrupts.push(sessionID);
			return {};
		},
		wait: ({ sessionID: _ }: { sessionID: string }) => (this.idle ? Promise.resolve() : new Promise(() => undefined)),
		switchModel: async ({ model }: { sessionID: string; model: { providerID: string; id: string } }) => {
			this.switched.push(`${model.providerID}/${model.id}`);
			return {};
		},
	};
	readonly event = { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) };
	readonly tool = {
		transform: async (edit: (tools: OcToolEditor) => void) => {
			edit({ add: (t) => this.tools.push(t) });
			return { dispose: async () => undefined };
		},
		reload: async () => {
			this.reloads += 1;
		},
	};
	readonly model = { list: async () => ({ data: [{ id: "echo-1", providerID: "echo", name: "Echo" }, { id: "echo-2", providerID: "echo", name: "Echo 2" }] }) };
	readonly rpc = {
		register: async () => ({
			events: { emit: async (_name: string, data: Record<string, unknown>) => void this.displays.push(data) },
			dispose: async () => undefined,
		}),
	};

}

export interface OcWorld extends World {
	oc: FakeOpenCode;
	running: Running;
	/** Raise OpenCode events, in order. */
	emit: (...events: OcEvent[]) => void;
	step: (n?: number) => Promise<void>;
	/** The row our prompt became, enqueued then delivered: our turn starts. */
	deliverOurs: (sessionID?: string) => void;
}

export async function ocWorld(apps: FakeAppOptions[] = [NOTES]): Promise<OcWorld> {
	const w = await world(apps, { attach: false, host: "opencode" });
	const oc = new FakeOpenCode();
	const running = await serve(oc, {
		now: () => w.clock.t,
		connector: (host: HostAdapter) => new Connector({ host, http: w.net.http, files: w.files, now: () => w.clock.t, home: HOME, random: () => 0.5 }),
	});
	const emit = (...events: OcEvent[]) => {
		for (const e of events) running.event(e);
	};
	const step = async (n = 1) => {
		for (let i = 0; i < n; i++) {
			w.clock.t += 1000;
			await running.tick();
			await flush();
		}
	};
	let row = 0;
	const deliverOurs = (sessionID = "ses_root") => {
		const p = oc.prompts.at(-1);
		if (!p) throw new Error("nothing was prompted");
		const inboxID = `msg_ours_${++row}`;
		emit(
			{ type: "session.inbox.enqueued", data: { sessionID, inboxID, item: { type: "user", payload: { text: p.text }, delivery: "queue" } } },
			{ type: "session.execution.started", data: { sessionID } },
			{ type: "session.inbox.delivered", data: { sessionID, inboxID } },
		);
	};
	return { ...w, oc, running, emit, step, deliverOurs, connector: running.connector };
}

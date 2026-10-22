// The part of OpenCode 2's plugin API this connector uses, typed
// structurally so it loads without importing @opencode/plugin (the host
// resolves that module only inside its own runtime). Checked against the
// installed @opencode/cli and @opencode/plugin 2.1.2 (dist types) and the
// 2.0.32 source.

/** An event as `ctx.event.subscribe()` yields it (server) and the TUI's
 * client sees it. `data.sessionID` names the session for session events. */
export interface OcEvent {
	type: string;
	data?: Record<string, unknown>;
}

export interface ModelRef {
	id: string;
	providerID: string;
	variant?: string;
}

export interface OcSessionInfo {
	id: string;
	parentID?: string;
	model?: ModelRef;
	location?: { directory?: string };
}

/** `ctx.session` in a server plugin. */
export interface OcSessionDomain {
	get(input: { sessionID: string }): Promise<OcSessionInfo>;
	prompt(input: { sessionID: string; text: string; delivery: "queue" | "steer"; id?: string; metadata?: Record<string, unknown> }): Promise<unknown>;
	interrupt(input: { sessionID: string }): Promise<unknown>;
	wait(input: { sessionID: string }): Promise<unknown>;
	switchModel(input: { sessionID: string; model: ModelRef }): Promise<unknown>;
}

export interface OcToolEditor {
	add(tool: {
		name: string;
		description: string;
		input: Record<string, unknown>;
		options?: { codemode?: boolean };
		execute: (input: unknown, context: { sessionID: string }) => Promise<{ content: string }>;
	}): void;
}

export interface RpcRegistration {
	readonly events: { emit(name: string, data: Record<string, unknown>): Promise<void> };
	dispose(): Promise<void>;
}

/** A server plugin's context: one per project folder. */
export interface OcServerContext {
	readonly app: { version: string };
	readonly location: { directory: string };
	readonly session: OcSessionDomain;
	readonly event: { subscribe(options?: { signal?: AbortSignal }): AsyncIterable<OcEvent> };
	readonly tool: { transform(edit: (tools: OcToolEditor) => void): Promise<{ dispose(): Promise<void> }>; reload(): Promise<void> };
	readonly model: { list(): Promise<{ data: { id: string; providerID: string; name?: string }[] }> };
	readonly rpc: {
		register(definition: unknown, handlers: Record<string, (input: never) => Promise<unknown>>): Promise<RpcRegistration>;
	};
}

/** A TUI plugin's context: one per terminal UI. */
export interface OcTuiContext {
	readonly client: {
		rpc(definition: unknown): {
			hello(input: { sessions: string[] }): Promise<unknown>;
			command(input: { args: string; sessionID?: string }): Promise<{ text: string }>;
			events: { on(name: string, handler: (event: { data: Record<string, unknown> }) => void): () => void };
		};
	};
	readonly ui: {
		toast: { show(options: { title?: string; message: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }): void };
		router: { current(): { type: string; sessionID?: string } };
		tabs: { enabled(): boolean; list(): readonly { sessionID: string }[] };
		slot(claim: { append: "app"; render: () => null }): () => void;
	};
	readonly keymap: {
		layer(factory: () => { commands: readonly Record<string, unknown>[] }): void;
	};
}

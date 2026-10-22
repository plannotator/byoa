// The part of Pi's extension API this connector uses, typed structurally so
// it loads on every Pi that has `agent_settled` and `ctx.mode` (0.80 and
// later, 1.x included) without importing Pi itself. Checked against the
// installed 0.85.1 (dist/core/extensions/types.d.ts) and the 1.0.2 source.

export type PiMode = "tui" | "rpc" | "json" | "print";
export type ThinkingLevel = string;

export interface PiModel {
	provider: string;
	id: string;
	name?: string;
}

export interface PiUi {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	setWidget(key: string, content: string[] | undefined): void;
}

export interface PiContext {
	ui: PiUi;
	mode: PiMode;
	cwd: string;
	sessionManager: { getSessionId(): string };
	modelRegistry: { getAvailable(): PiModel[]; find(provider: string, id: string): PiModel | undefined };
	model: PiModel | undefined;
	thinkingLevel?: ThinkingLevel;
	isIdle(): boolean;
	abort(): void;
	hasPendingMessages(): boolean;
}

/** A message as Pi's events carry it (the fields read here). */
export interface PiMessage {
	role?: string;
	customType?: string;
	content?: unknown;
	stopReason?: string;
}

export interface PiEvents {
	session_start: { reason?: string };
	session_shutdown: { reason?: string };
	agent_start: object;
	agent_end: { messages: PiMessage[] };
	agent_settled: object;
	message_start: { message: PiMessage };
	message_update: { message: PiMessage; assistantMessageEvent: { type: string; delta?: string } };
	tool_execution_start: { toolCallId: string; toolName: string };
	input: { text: string; source: "interactive" | "rpc" | "extension"; streamingBehavior?: "steer" | "followUp" };
	context: { messages: PiMessage[] };
	ui_prompt_start: object;
	ui_prompt_end: object;
}

export interface PiToolResult {
	content: { type: "text"; text: string }[];
	details: Record<string, never>;
	isError?: boolean;
}

export interface PiToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: PiContext): Promise<PiToolResult>;
}

export interface PiApi {
	on<E extends keyof PiEvents>(event: E, handler: (event: PiEvents[E], ctx: PiContext) => unknown): unknown;
	registerTool(tool: PiToolDefinition): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: (prefix: string) => { value: string; label: string }[] | null;
			handler: (args: string, ctx: PiContext) => Promise<void>;
		},
	): void;
	sendMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): void;
	setModel(model: PiModel): Promise<boolean>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
}

/** The text of a message's content: a string, or its text parts joined. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part: { type?: string; text?: unknown } | null) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

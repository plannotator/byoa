// What both live drivers (connectors/pi/scripts/live.ts and
// connectors/opencode/scripts/live.ts) share: the two demo apps and the echo
// model, a host in a real pty (tty.exp), the person's side through the
// app's UI doors (cookie `demo_session=signed-in`, `Origin` set), and the
// SSE stream from /byoa/ui/events, recorded in order.
// Nothing here touches the real HOME: each host runs under `env -i` with a
// throwaway HOME inside the run's root.

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const HERE = dirname(fileURLToPath(import.meta.url));
export const COOKIE = "demo_session=signed-in";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function until<T>(what: string, ms: number, probe: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = await probe();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
		await sleep(200);
	}
}

const children: ChildProcess[] = [];
process.on("exit", () => {
	for (const c of children) c.kill("SIGTERM");
});

async function listening(url: string): Promise<boolean> {
	try {
		await fetch(url, { signal: AbortSignal.timeout(1000) });
		return true;
	} catch {
		return false;
	}
}

/** Starts the demo app on `port` unless something already answers there. */
export async function demoApp(port: number, id: string, name: string): Promise<string> {
	const origin = `http://localhost:${port}`;
	if (await listening(`${origin}/.well-known/byoa`)) return origin;
	const child = spawn(process.execPath, [join(REPO, "examples/demo/src/server.ts")], {
		env: { ...process.env, PORT: String(port), APP_ID: id, APP_NAME: name, DEMO_AUTO_APPROVE: "1" },
		stdio: "ignore",
	});
	children.push(child);
	await until(`${name} on ${port}`, 15_000, () => listening(`${origin}/.well-known/byoa`));
	return origin;
}

export async function echoModel(port: number, log: string): Promise<string> {
	const base = `http://127.0.0.1:${port}/v1`;
	if (await listening(`${base}/models`)) return base;
	const child = spawn(process.execPath, [join(HERE, "echo-model.ts")], { env: { ...process.env, PORT: String(port), ECHO_LOG: log }, stdio: "ignore" });
	children.push(child);
	await until("the echo model", 10_000, () => listening(`${base}/models`));
	return base;
}

/** A Tcl list word: braces keep spaces and specials literal. */
const tcl = (s: string) => `{${s}}`;

export class Tty {
	readonly dir: string;
	readonly log: string;
	readonly child: ChildProcess;

	constructor(root: string, cwd: string, env: Record<string, string>, argv: string[]) {
		this.dir = join(root, "tty");
		this.log = join(root, "tty.log");
		rmSync(this.dir, { recursive: true, force: true });
		mkdirSync(this.dir, { recursive: true });
		const cmd = ["env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv].map(tcl).join(" ");
		this.child = spawn("expect", [join(HERE, "tty.exp")], { env: { ...process.env, TTY_DIR: this.dir, TTY_LOG: this.log, TTY_CMD: cmd, TTY_CWD: cwd }, stdio: "ignore" });
		children.push(this.child);
	}

	/** Types a line and presses Enter. */
	async type(line: string): Promise<void> {
		rmSync(join(this.dir, "typed"), { force: true });
		writeFileSync(join(this.dir, "type"), `${line}\n`);
		await until(`typing ${line}`, 20_000, () => existsSync(join(this.dir, "typed")));
	}

	/** The screen so far, escape sequences removed. */
	screen(): string {
		try {
			return readFileSync(this.log, "utf8").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, " ").replace(/\x1b[\]P^_][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b./g, "");
		} catch {
			return "";
		}
	}

	async stop(): Promise<void> {
		mkdirSync(this.dir, { recursive: true });
		writeFileSync(join(this.dir, "stop"), "");
		await Promise.race([new Promise((r) => this.child.once("exit", r)), sleep(25_000)]);
		this.child.kill("SIGTERM");
	}
}

export interface UiSession {
	id: string;
	host: string;
	state: string;
	started_at: string;
	workspace: Record<string, string>;
	capabilities: { interrupt: boolean; settings: { id: string; value: string | null }[] };
}

export interface UiEvent {
	type: string;
	session_id?: string;
	message_id?: string;
	event?: { type: string; text?: string; name?: string; reason?: string };
	reason?: string;
	at: number;
}

/** The person's side of one app: the UI doors, as its own browser uses them. */
export class Person {
	readonly events: UiEvent[] = [];
	readonly #origin: string;
	readonly #name: string;
	#abort = new AbortController();

	constructor(origin: string, name: string) {
		this.#origin = origin;
		this.#name = name;
	}

	get name(): string {
		return this.#name;
	}

	#headers(json = false): Record<string, string> {
		return { cookie: COOKIE, origin: this.#origin, ...(json ? { "content-type": "application/json" } : {}) };
	}

	async sessions(): Promise<UiSession[]> {
		const r = await fetch(`${this.#origin}/byoa/ui/sessions`, { headers: this.#headers() });
		const body = (await r.json()) as { connections: { sessions: UiSession[] }[] };
		return body.connections.flatMap((c) => c.sessions);
	}

	/** The newest live session of `host`, once one is there. */
	async live(host: string, besides: string[] = []): Promise<UiSession> {
		return until(`a live ${host} session in ${this.#name}`, 30_000, async () =>
			(await this.sessions())
				.filter((s) => s.host === host && s.state !== "gone" && !besides.includes(s.id))
				.sort((a, b) => b.started_at.localeCompare(a.started_at))[0],
		);
	}

	async send(sessionId: string, text: string, extra: Record<string, unknown> = {}): Promise<string> {
		const r = await fetch(`${this.#origin}/byoa/ui/sessions/${encodeURIComponent(sessionId)}/messages`, {
			method: "POST",
			headers: this.#headers(true),
			body: JSON.stringify({ text, kind: "chat", stream: true, ...extra }),
		});
		const body = (await r.json()) as { message_id?: string };
		if (r.status !== 202 || !body.message_id) throw new Error(`${this.#name}: send answered ${r.status} ${JSON.stringify(body)}`);
		return body.message_id;
	}

	async interrupt(sessionId: string, messageId: string): Promise<string> {
		const r = await fetch(`${this.#origin}/byoa/ui/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/interrupt`, {
			method: "POST",
			headers: this.#headers(true),
			body: "{}",
		});
		return ((await r.json()) as { outcome?: string }).outcome ?? `status ${r.status}`;
	}

	async activity(): Promise<{ notes: { text: string; session: string | null }[] }> {
		return (await (await fetch(`${this.#origin}/api/activity`, { headers: this.#headers() })).json()) as { notes: { text: string; session: string | null }[] };
	}

	/** Opens /byoa/ui/events and records every event, in order. */
	async listen(): Promise<void> {
		const r = await fetch(`${this.#origin}/byoa/ui/events`, { headers: this.#headers(), signal: this.#abort.signal });
		if (r.status !== 200 || !r.body) throw new Error(`${this.#name}: events answered ${r.status}`);
		const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
		void (async () => {
			let buf = "";
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return;
					buf += value;
					let at: number;
					while ((at = buf.indexOf("\n\n")) >= 0) {
						const block = buf.slice(0, at);
						buf = buf.slice(at + 2);
						const data = block.split("\n").find((l) => l.startsWith("data: "));
						if (data) this.events.push({ ...(JSON.parse(data.slice(6)) as Omit<UiEvent, "at">), at: Date.now() });
					}
				}
			} catch {
				// closed
			}
		})();
	}

	close(): void {
		this.#abort.abort();
	}

	/** One message's stream as short words: accepted, queued, started,
	 * delta, tool:<name>, done, interrupted:<reason>, gone:<reason>. */
	sequence(messageId: string): string[] {
		const out: string[] = [];
		for (const e of this.events) {
			if (e.message_id !== messageId) continue;
			if (e.type === "accepted") out.push("accepted");
			else if (e.type === "gone") out.push(`gone:${e.reason}`);
			else if (e.type === "event" && e.event) {
				const ev = e.event;
				const word = ev.type === "tool" ? `tool:${ev.name}` : ev.reason ? `${ev.type}:${ev.reason}` : ev.type;
				if (word === "delta" && out.at(-1) === "delta") continue;
				out.push(word);
			}
		}
		return out;
	}

	text(messageId: string): string {
		return this.events
			.filter((e) => e.message_id === messageId && e.event?.type === "delta")
			.map((e) => e.event?.text ?? "")
			.join("");
	}

	ended(messageId: string): UiEvent | undefined {
		return this.events.find((e) => e.message_id === messageId && (e.type === "gone" || ["done", "error", "interrupted", "withdrawn"].includes(e.event?.type ?? "")));
	}

	at(messageId: string, type: string): number | undefined {
		return this.events.find((e) => e.message_id === messageId && (e.event?.type === type || e.type === type))?.at;
	}
}

/** A step of the proof: PASS or FAIL with its evidence, printed and kept. */
export class Transcript {
	readonly lines: string[] = [];
	failed = 0;
	readonly #file: string;

	constructor(file: string, title: string) {
		this.#file = file;
		writeFileSync(file, "");
		this.say(`# ${title}`);
		this.say(`run at ${new Date().toISOString()}`);
	}

	say(line: string): void {
		this.lines.push(line);
		appendFileSync(this.#file, `${line}\n`);
		console.log(line);
	}

	async step(name: string, fn: () => Promise<string>): Promise<boolean> {
		try {
			const evidence = await fn();
			this.say(`PASS ${name}\n     ${evidence.replace(/\n/g, "\n     ")}`);
			return true;
		} catch (error) {
			this.failed += 1;
			this.say(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}
}

export function assert(ok: unknown, message: string): asserts ok {
	if (!ok) throw new Error(message);
}

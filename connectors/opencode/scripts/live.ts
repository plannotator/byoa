// The live proof for @plannotator/byoa-opencode: the real OpenCode 2 TUI in a pty
// (`opencode2 --standalone`), with a throwaway HOME and XDG folders, the
// echo model as an OpenAI-compatible provider, and two demo apps. The
// person's side goes through each app's UI doors; the SSE stream from
// /byoa/ui/events is the evidence. Writes live.transcript.txt.
//   OPENCODE_BIN=/path/to/opencode2 node connectors/opencode/scripts/live.ts
// Without OPENCODE_BIN it installs @opencode/cli 2.1.2 under /tmp/byoa-pioc.
// Ports: demo apps 4300 (Notes) and 4400 (Tasks), the echo model 4599.
// Shares connectors/pi/scripts/live-kit.ts, tty.exp and echo-model.ts.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assert, demoApp, echoModel, Person, REPO, sleep, Transcript, Tty, until } from "../../pi/scripts/live-kit.ts";

const ROOT = "/tmp/byoa-pioc/opencode";
const HOME = join(ROOT, "home");
const WORK = join(ROOT, "work", "northstar");
const PLUGIN = join(REPO, "connectors/opencode");
const out = new Transcript(join(REPO, "connectors/opencode/scripts/live.transcript.txt"), "@plannotator/byoa-opencode live proof");

function opencode(): string {
	if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
	const prefix = "/tmp/byoa-pioc/pkgs/opencode";
	const bin = join(prefix, "node_modules/.bin/opencode2");
	if (!existsSync(bin)) execFileSync("npm", ["install", "--prefix", prefix, "--no-save", "--silent", "@opencode/cli@2.1.2"], { stdio: "inherit" });
	return bin;
}
const OC = opencode();

rmSync(ROOT, { recursive: true, force: true });
for (const d of [HOME, join(ROOT, "tmp"), join(HOME, ".config", "opencode"), WORK]) mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: WORK });
execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/northstar.git"], { cwd: WORK });

const model = await echoModel(4599, join(ROOT, "echo.jsonl"));
writeFileSync(
	join(HOME, ".config", "opencode", "opencode.json"),
	JSON.stringify({
		model: "echo/echo-1",
		providers: { echo: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: model, apiKey: "test-model-key" }, models: { "echo-1": { modelID: "echo-1", name: "Echo" } } } },
		plugins: [PLUGIN],
	}),
);
const notes = new Person(await demoApp(4300, "notes", "Notes"), "Notes");
const tasks = new Person(await demoApp(4400, "tasks", "Tasks"), "Tasks");

const env = {
	HOME,
	TMPDIR: join(ROOT, "tmp"),
	PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
	TERM: "xterm-256color",
	COLORTERM: "truecolor",
	LANG: "en_US.UTF-8",
	XDG_CONFIG_HOME: join(HOME, ".config"),
	XDG_DATA_HOME: join(HOME, ".local/share"),
	XDG_STATE_HOME: join(HOME, ".local/state"),
	XDG_CACHE_HOME: join(HOME, ".cache"),
	OPENCODE_DISABLE_AUTOUPDATE: "1",
	OPENCODE_DISABLE_MODELS_FETCH: "1",
};
const version = execFileSync(OC, ["--version"], { env, encoding: "utf8" }).trim();
out.say(`${version} (${OC}), plugin ${PLUGIN}, HOME ${HOME}`);
const credential = (port: number) => join(HOME, ".byoa", "credentials", `http_localhost_${port}.json`);
const ready = (tty: Tty) => until("OpenCode's TUI", 60_000, () => /Echo|echo-1/.test(tty.screen())).then(() => sleep(3_000));
let tty = new Tty(ROOT, WORK, env, [OC, "--standalone"]);
let sessions = { notes: "", tasks: "" };

try {
	await ready(tty);

	await out.step("1. /byoa connect both apps", async () => {
		for (const port of [4300, 4400]) {
			const saved = () => existsSync(credential(port));
			await tty.type(`/byoa connect http://localhost:${port}`);
			// The slash menu can take the first Enter.
			await until(`the credential for ${port}`, 5_000, saved).catch(() => tty.type(""));
			await until(`the credential for ${port}`, 15_000, saved);
			await sleep(1_500);
		}
		const modes = [4300, 4400].map((p) => (statSync(credential(p)).mode & 0o777).toString(8));
		const dir = (statSync(dirname(credential(4300))).mode & 0o777).toString(8);
		// The tool list is fixed for the plugin's life: a new OpenCode gets both apps' tools.
		await tty.stop();
		tty = new Tty(join(ROOT, "second"), WORK, env, [OC, "--standalone"]);
		await ready(tty);
		// A session exists once the person writes in it; the TUI then shows it.
		await tty.type("hello from the person");
		const a = await notes.live("opencode");
		const b = await tasks.live("opencode");
		sessions = { notes: a.id, tasks: b.id };
		return `credential files 0${modes.join(", 0")} in a 0${dir} folder\nafter a restart and a first prompt: Notes session ${a.id} (${a.state}), Tasks session ${b.id} (${b.state}); workspace sent: ${JSON.stringify(a.workspace)}; settings: ${a.capabilities.settings.map((s) => `${s.id}=${s.value}`).join(", ")}`;
	});

	await notes.listen();
	await tasks.listen();
	await sleep(3_000);

	await out.step("2-3. a message through the UI door, and its SSE sequence", async () => {
		const id = await notes.send(sessions.notes, "hello from the Notes chat");
		await until("its end", 30_000, () => notes.ended(id));
		const seq = notes.sequence(id);
		assert(seq.join(" ") === "accepted started delta done", `sequence ${seq.join(" ")}`);
		return `${id}: ${seq.join(" → ")}; answer text "${notes.text(id)}"`;
	});

	await out.step("4. the proxied tool (the echo model calls `notes` add_note)", async () => {
		const id = await notes.send(sessions.notes, "TOOL:notes:a note from OpenCode through BYOA");
		await until("its end", 30_000, () => notes.ended(id));
		const seq = notes.sequence(id);
		assert(seq.includes("tool:notes") && seq.at(-1) === "done", `sequence ${seq.join(" ")}`);
		const act = await notes.activity();
		const note = act.notes.find((n) => n.text === "a note from OpenCode through BYOA");
		assert(note, `GET /api/activity: ${JSON.stringify(act.notes)}`);
		return `${id}: ${seq.join(" → ")}\nGET /api/activity → notes: ${JSON.stringify(note)}`;
	});

	await out.step("5a. two apps' messages run one after the other", async () => {
		const first = await tasks.send(sessions.tasks, "SLOW from Tasks");
		await until("Tasks' turn to start", 15_000, () => tasks.at(first, "started"));
		const second = await notes.send(sessions.notes, "then Notes");
		await until("both ends", 60_000, () => tasks.ended(first) && notes.ended(second));
		const t = tasks.sequence(first);
		const n = notes.sequence(second);
		const tDone = tasks.at(first, "done") ?? 0;
		const nStart = notes.at(second, "started") ?? 0;
		assert(t.at(-1) === "done" && n.at(-1) === "done", `Tasks ${t.join(" ")}; Notes ${n.join(" ")}`);
		assert(n.includes("queued"), `Notes was not queued: ${n.join(" ")}`);
		assert(nStart >= tDone, `Notes started ${tDone - nStart} ms before Tasks ended`);
		return `Tasks ${first}: ${t.join(" → ")}\nNotes ${second}: ${n.join(" → ")}\nNotes started ${nStart - tDone} ms after Tasks' done`;
	});

	await out.step("5b. interrupt stops our turn", async () => {
		const id = await notes.send(sessions.notes, "SLOW interrupt me");
		await until("a delta", 15_000, () => notes.at(id, "delta"));
		const outcome = await notes.interrupt(sessions.notes, id);
		await until("its end", 20_000, () => notes.ended(id));
		const seq = notes.sequence(id);
		assert(seq.at(-1) === "interrupted:stopped", `sequence ${seq.join(" ")}`);
		return `${id}: interrupt door → ${outcome}; ${seq.join(" → ")}`;
	});

	await out.step("stand-down: `opencode2 run --standalone` with both credentials on disk registers nothing", async () => {
		const before = (await notes.sessions()).length + (await tasks.sessions()).length;
		const r = spawnSync(OC, ["run", "--standalone", "say hello"], { cwd: WORK, env, encoding: "utf8", timeout: 90_000 });
		await sleep(3_000);
		const after = (await notes.sessions()).length + (await tasks.sessions()).length;
		assert(after === before, `sessions ${before} → ${after}`);
		return `opencode2 run exited ${r.status}, printed "${(r.stdout ?? "").trim().slice(0, 60)}"; sessions listed in the two apps: ${before} before, ${after} after`;
	});
} finally {
	notes.close();
	tasks.close();
	await tty.stop();
	out.say(`\n${out.failed === 0 ? "ALL PASSED" : `${out.failed} FAILED`}; the pty log is ${tty.log}`);
	process.exit(out.failed === 0 ? 0 : 1);
}

// The live proof for @plannotator/byoa-pi: the real Pi, interactive in a pty, with a
// throwaway HOME and Pi agent folder, the echo model (PI_OFFLINE=1), and two
// demo apps. The person's side goes through each app's UI doors; the SSE
// stream from /byoa/ui/events is the evidence. Writes live.transcript.txt.
//   node connectors/pi/scripts/live.ts            (Pi from PATH)
//   PI_BIN=/path/to/pi node connectors/pi/scripts/live.ts
// Ports: demo apps 4300 (Notes) and 4400 (Tasks), the echo model 4599.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assert, demoApp, echoModel, Person, REPO, sleep, Transcript, Tty, until } from "./live-kit.ts";

const ROOT = "/tmp/byoa-pioc/pi";
const HOME = join(ROOT, "home");
const WORK = join(ROOT, "work", "northstar");
const EXT = join(REPO, "connectors/pi/src/index.ts");
const PI = realpathSync(process.env.PI_BIN ?? execFileSync("/bin/sh", ["-c", "command -v pi"], { encoding: "utf8" }).trim());
const out = new Transcript(join(REPO, "connectors/pi/scripts/live.transcript.txt"), "@plannotator/byoa-pi live proof");

rmSync(ROOT, { recursive: true, force: true });
for (const d of [HOME, join(ROOT, "tmp"), join(ROOT, "agent"), WORK]) mkdirSync(d, { recursive: true });
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: WORK });
execFileSync("git", ["remote", "add", "origin", "https://dana:secret-token@github.com/acme/northstar.git"], { cwd: WORK });

const model = await echoModel(4599, join(ROOT, "echo.jsonl"));
writeFileSync(
	join(ROOT, "agent", "models.json"),
	JSON.stringify({ providers: { echo: { baseUrl: model, api: "openai-completions", apiKey: "test-model-key", models: [{ id: "echo-1", name: "Echo" }] } } }),
);
const notesOrigin = await demoApp(4300, "notes", "Notes");
const tasksOrigin = await demoApp(4400, "tasks", "Tasks");
const notes = new Person(notesOrigin, "Notes");
const tasks = new Person(tasksOrigin, "Tasks");

const env = {
	HOME,
	TMPDIR: join(ROOT, "tmp"),
	PATH: `${dirname(process.execPath)}:${dirname(PI)}:/usr/bin:/bin`,
	TERM: "xterm-256color",
	LANG: "en_US.UTF-8",
	COLUMNS: "160",
	LINES: "40",
	PI_CODING_AGENT_DIR: join(ROOT, "agent"),
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	PI_TELEMETRY: "0",
};
const version = execFileSync(PI, ["--version"], { env, encoding: "utf8" }).trim();
out.say(`pi ${version} (${PI}), extension ${EXT}, HOME ${HOME}`);
const tty = new Tty(ROOT, WORK, env, [PI, "-e", EXT, "--provider", "echo", "--model", "echo-1"]);
let sessions = { notes: "", tasks: "" };
const credential = (port: number) => join(HOME, ".byoa", "credentials", `http_localhost_${port}.json`);

try {
	await until("Pi's TUI", 60_000, () => /echo-1/.test(tty.screen()));

	await out.step("1. /byoa connect both apps", async () => {
		for (const port of [4300, 4400]) {
			const saved = () => {
				try {
					return statSync(credential(port));
				} catch {
					return null;
				}
			};
			await tty.type(`/byoa connect http://localhost:${port}`);
			// A completion menu can take the first Enter.
			await until(`the credential for ${port}`, 5_000, saved).catch(() => tty.type(""));
			await until(`the credential for ${port}`, 15_000, saved);
		}
		const modes = [4300, 4400].map((p) => (statSync(credential(p)).mode & 0o777).toString(8));
		const dir = (statSync(dirname(credential(4300))).mode & 0o777).toString(8);
		await until("the connected text", 10_000, () => /connected to Tasks/.test(tty.screen()));
		// This session registers with both apps at once; tools are fixed per
		// session, so a new session gets both apps' tools.
		const old = [(await notes.live("pi")).id, (await tasks.live("pi")).id];
		await tty.type("/new");
		const a = await notes.live("pi", old);
		const b = await tasks.live("pi", old);
		sessions = { notes: a.id, tasks: b.id };
		return `screen: "connected to Notes ... as Ramos", "connected to Tasks ... as Ramos"\ncredential files 0${modes.join(", 0")} in a 0${dir} folder\nafter /new: Notes session ${a.id} (${a.state}), Tasks session ${b.id} (${b.state}); workspace sent: ${JSON.stringify(a.workspace)}; settings: ${a.capabilities.settings.map((s) => `${s.id}=${s.value}`).join(", ")}`;
	});

	const nSes = { id: sessions.notes };
	const tSes = { id: sessions.tasks };
	await notes.listen();
	await tasks.listen();
	await sleep(500);

	await out.step("2-3. a message through the UI door, and its SSE sequence", async () => {
		const id = await notes.send(nSes.id, "hello from the Notes chat");
		await until("its end", 30_000, () => notes.ended(id));
		const seq = notes.sequence(id);
		assert(seq.join(" ") === "accepted started delta done", `sequence ${seq.join(" ")}`);
		await until("the provenance line on Pi's screen", 5_000, () => /\[BYOA\] Notes \(localhost:4300\) · chat from Ramos/.test(tty.screen()));
		return `${id}: ${seq.join(" → ")}; answer text "${notes.text(id)}"\nPi's screen shows "[BYOA] Notes (localhost:4300) · chat from Ramos · ${id}"`;
	});

	await out.step("4. the proxied tool (the echo model calls `notes` add_note)", async () => {
		const id = await notes.send(nSes.id, "TOOL:notes:a note from Pi through BYOA");
		await until("its end", 30_000, () => notes.ended(id));
		const seq = notes.sequence(id);
		assert(seq.includes("tool:notes") && seq.at(-1) === "done", `sequence ${seq.join(" ")}`);
		const act = await notes.activity();
		const note = act.notes.find((n) => n.text === "a note from Pi through BYOA");
		assert(note, `GET /api/activity: ${JSON.stringify(act.notes)}`);
		return `${id}: ${seq.join(" → ")}\nGET /api/activity → notes: ${JSON.stringify(note)}`;
	});

	await out.step("5a. two apps' messages run one after the other", async () => {
		const first = await tasks.send(tSes.id, "SLOW from Tasks");
		await until("Tasks' turn to start", 10_000, () => tasks.at(first, "started"));
		const second = await notes.send(nSes.id, "then Notes");
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
		const id = await notes.send(nSes.id, "SLOW interrupt me");
		await until("a delta", 15_000, () => notes.at(id, "delta"));
		const outcome = await notes.interrupt(nSes.id, id);
		await until("its end", 20_000, () => notes.ended(id));
		const seq = notes.sequence(id);
		assert(seq.at(-1) === "interrupted:stopped", `sequence ${seq.join(" ")}`);
		return `${id}: interrupt door → ${outcome}; ${seq.join(" → ")}`;
	});

	await out.step("/byoa status in the TUI", async () => {
		const shown = () => /this session: registered/.test(tty.screen());
		await tty.type("/byoa status");
		// Pi's argument completion takes the first Enter.
		await until("status", 4_000, shown).catch(() => tty.type(""));
		await until("status", 10_000, shown);
		return `screen shows "Notes (http://localhost:4300) · connected as Ramos · this session: registered" (and Tasks)`;
	});

	await out.step("stand-down: `pi -p` with both credentials on disk registers nothing", async () => {
		const before = (await notes.sessions()).length + (await tasks.sessions()).length;
		const r = spawnSync(PI, ["-e", EXT, "--provider", "echo", "--model", "echo-1", "-p", "say hello"], { cwd: WORK, env, encoding: "utf8", timeout: 60_000 });
		await sleep(2_000);
		const after = (await notes.sessions()).length + (await tasks.sessions()).length;
		assert(after === before, `sessions ${before} → ${after}`);
		return `pi -p exited ${r.status}, printed "${r.stdout.trim().slice(0, 60)}"; sessions listed in the two apps: ${before} before, ${after} after`;
	});
} finally {
	notes.close();
	tasks.close();
	await tty.stop();
	out.say(`\n${out.failed === 0 ? "ALL PASSED" : `${out.failed} FAILED`}; the pty log is ${tty.log}`);
	process.exit(out.failed === 0 ? 0 : 1);
}

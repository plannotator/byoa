# Live proof of the Claude Code connector: real Claude Code in a pty with
# --plugin-dir, two demo apps on loopback, and the apps' UI doors driven the
# way a signed-in browser would (cookie demo_session=signed-in, Origin header).
#
#   python3 connectors/claude-code/scripts/live.py      (from the repo root)
#
# Steps (each prints PASS or FAIL with its evidence; the transcript goes to
# scripts/live-transcript.txt):
#   1. /byoa connect both apps; both list this session.
#   2. Notes: a message that uses the notes tool; the SSE stream shows
#      accepted, started, delta, tool, done; /api/activity has the note with
#      the session id.
#   3. One message from each app at once: they run one after the other.
#   4. A running message interrupted: `interrupted`.
#   5. The terminal shows the "[BYOA] Notes (localhost:4100) · chat from
#      Ramos · msg_…" line.
#   6. /clear: both apps see a new session register.
# The connector's tools reach new sessions only (SPEC 9.6), so after the
# pairing the driver runs one /clear before step 2; step 6 is a second one.
# Claude Code runs with --permission-mode default, so the proxied tool asks
# for permission and the driver answers Yes, and checks the app saw
# `blocked` meanwhile.
#
# ~/.byoa is the connector's real folder (the core takes no other, and the
# adapter reads no override, so a project cannot point it elsewhere): an
# existing one is moved aside first and put back at the end.
import json, os, pty, re, select, shutil, signal, subprocess, sys, threading, time, fcntl, termios, struct, urllib.request

REPO = os.path.realpath(os.path.join(os.path.dirname(__file__), "../../.."))
PLUGIN = os.path.join(REPO, "connectors/claude-code")
RUN = "/tmp/byoa-live"
PROJ = os.path.join(RUN, "proj")
BYOA = os.path.expanduser("~/.byoa")
BACKUP = os.path.expanduser("~/.byoa.live-backup")
APPS = {4100: ("notes", "Notes"), 4200: ("tasks", "Tasks")}
TRANSCRIPT = os.path.join(PLUGIN, "scripts/live-transcript.txt")
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[=>()][0-9A-Za-z]?")

lines, results = [], []
def say(*a):
    s = time.strftime("%H:%M:%S ") + " ".join(str(x) for x in a)
    print(s, flush=True); lines.append(s)
def verdict(step, ok, evidence):
    results.append((step, ok)); say(("PASS" if ok else "FAIL"), step, "|", evidence)

# ── the apps' doors, as the signed-in browser ────────────────────────────────
def api(port, method, path, body=None):
    headers = {"cookie": "demo_session=signed-in", "origin": f"http://localhost:{port}"}
    data = None
    if body is not None:
        headers["content-type"] = "application/json"; data = json.dumps(body).encode()
    req = urllib.request.Request(f"http://localhost:{port}{path}", data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=10) as r:
        text = r.read().decode()
        return json.loads(text) if text else None

events, events_lock = [], threading.Lock()
def sse(port):
    req = urllib.request.Request(f"http://localhost:{port}/byoa/ui/events", headers={"cookie": "demo_session=signed-in", "accept": "text/event-stream"})
    with urllib.request.urlopen(req, timeout=600) as r:
        kind = None
        for raw in r:
            line = raw.decode().rstrip("\n")
            if line.startswith("event: "): kind = line[7:]
            elif line.startswith("data: "):
                with events_lock: events.append((time.time(), port, kind, json.loads(line[6:])))

def message_events(port, mid):
    with events_lock:
        out = []
        for t, p, kind, d in events:
            if p != port or d.get("message_id") != mid: continue
            out.append((t, kind if kind != "event" else d["event"]["type"], d))
        return out

def compact(seq):
    out = []
    for name in seq:
        if out and out[-1][0] == name: out[-1][1] += 1
        else: out.append([name, 1])
    return " ".join(n if c == 1 else f"{n}x{c}" for n, c in out)

def live_sessions(port):
    out = []
    for c in api(port, "GET", "/byoa/ui/sessions")["connections"]:
        for s in c["sessions"]:
            if s["host"] == "claude-code" and s["state"] != "gone": out.append(s)
    return sorted(out, key=lambda s: s["started_at"])

# ── Claude Code in a pty ─────────────────────────────────────────────────────
raw = b""; answered = 0; trusted = False; fd = None; pid = None; blocked_seen = []
CURSOR_FORWARD = re.compile(rb"\x1b\[(\d*)C")
def flat_screen():
    # Claude Code moves the cursor instead of writing spaces, so text is
    # compared with all whitespace removed.
    text = ANSI.sub(b"", CURSOR_FORWARD.sub(b" ", raw)).decode("utf8", "replace")
    return re.sub(r"\s+", "", text)
def pump(secs):
    global raw, answered, trusted
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd not in r: continue
        try: d = os.read(fd, 65536)
        except OSError: return
        if not d: return
        LOG.write(d); LOG.flush(); raw += d
        flat = flat_screen().lower()
        if not trusted and ("itrustthisfolder" in flat or "yes,proceed" in flat):
            trusted = True; time.sleep(0.5); os.write(fd, b"\x1b[B"); time.sleep(0.3); os.write(fd, b"\r"); say("accepted the trust prompt (Down, Enter)")
        if trusted and flat.count("doyouwanttoproceed") > answered:
            answered = flat.count("doyouwanttoproceed")
            # Claude Code raises its permission_prompt notification only after
            # the prompt has waited a few seconds; then a tick and a poll carry
            # it to the app. Sample until the app shows it, at most 15 s.
            t0 = time.time()
            while time.time() - t0 < 15:
                time.sleep(1)
                try: states = [(s["id"], s["state"], s.get("cause")) for s in live_sessions(4100)]
                except Exception as error: states = str(error)
                if isinstance(states, list) and any(st == "blocked" for _, st, _ in states): break
            blocked_seen.append(states)
            os.write(fd, b"\r"); say(f"permission prompt for the tool: after {round(time.time() - t0, 1)} s Notes saw the session as", states, "; pressed Enter (Yes)")

def screen(): return ANSI.sub(b"", CURSOR_FORWARD.sub(b" ", raw)).decode("utf8", "replace")
def type_line(text):
    os.write(fd, text.encode()); pump(0.6); os.write(fd, b"\r")
def wait_for(pred, secs, what):
    end = time.time() + secs
    while time.time() < end:
        pump(0.5)
        try:
            v = pred()
            if v: return v
        except Exception: pass
    say("timed out waiting for", what); return None

def send(port, sid, text):
    return api(port, "POST", f"/byoa/ui/sessions/{sid}/messages", {"text": text})["message_id"]
FINAL = {"done", "error", "interrupted", "withdrawn"}
def finished(port, mid):
    names = [n for _, n, _ in message_events(port, mid)]
    return names if FINAL & set(names) or "gone" in names else None

# ── run ──────────────────────────────────────────────────────────────────────
procs = []
def cleanup():
    if pid:
        try: os.kill(pid, signal.SIGKILL)
        except Exception: pass
    for p in procs: p.terminate()
    if os.path.isdir(BYOA): shutil.rmtree(BYOA)
    if os.path.isdir(BACKUP): os.rename(BACKUP, BYOA); say("restored the earlier ~/.byoa")
    with open(TRANSCRIPT, "w") as f: f.write("\n".join(lines) + "\n")

try:
    shutil.rmtree(RUN, ignore_errors=True); os.makedirs(PROJ)
    LOG = open(os.path.join(RUN, "pty.log"), "wb")
    open(os.path.join(PROJ, "README.md"), "w").write("# live-proj\n")
    subprocess.run(["git", "init", "-q", PROJ], check=True)
    subprocess.run(["git", "-C", PROJ, "remote", "add", "origin", "https://x-access-token:SECRET@github.com/acme/live-proj.git"], check=True)
    if os.path.exists(BYOA): os.rename(BYOA, BACKUP); say("moved the existing ~/.byoa aside")
    for port, (app_id, name) in APPS.items():
        env = {**os.environ, "PORT": str(port), "APP_ID": app_id, "APP_NAME": name, "DEMO_AUTO_APPROVE": "1"}
        procs.append(subprocess.Popen(["node", "examples/demo/src/server.ts"], cwd=REPO, env=env, stdout=open(os.path.join(RUN, f"{app_id}.log"), "w"), stderr=subprocess.STDOUT))
    for port in APPS:
        for _ in range(50):
            try: urllib.request.urlopen(f"http://localhost:{port}/.well-known/byoa", timeout=1); break
            except Exception: time.sleep(0.2)
        threading.Thread(target=sse, args=(port,), daemon=True).start()
    say("demo apps up on 4100 (notes) and 4200 (tasks)")

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(PROJ); os.environ["TERM"] = "xterm-256color"
        os.execvp("claude", ["claude", "--plugin-dir", PLUGIN, "--model", "haiku", "--permission-mode", "default", "--debug-file", os.path.join(RUN, "claude-debug.log")])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
    say("claude started in", PROJ)
    pump(8)
    wait_for(lambda: "forshortcuts" in flat_screen(), 10, "the prompt hint")
    pump(3)
    trusted = True  # a folder trusted on an earlier run shows no prompt

    # 1. connect both apps
    for port, (app_id, name) in APPS.items():
        type_line(f"/byoa connect http://localhost:{port}")
        needle = f"connected to {name} (http://localhost:{port}) as Ramos"
        got = wait_for(lambda: needle.replace(" ", "") in flat_screen(), 30, f"connected to {name}")
        say("terminal shows:", f"BYOA: {needle}." if got else "(no connected line)")
    first = {port: wait_for(lambda p=port: live_sessions(p), 30, f"a session in app {port}") for port in APPS}
    verdict("1 connect", all(first.values()), {p: [(s["id"], s["state"], s["workspace"]) for s in (first[p] or [])] for p in APPS})
    type_line("/byoa status"); pump(3)
    status = re.findall(r"BYOA:(?:Notes|Tasks)\(http://localhost:\d+\)·connectedasRamos·thissession:[a-z]+", flat_screen())
    say("/byoa status shows:", status[-2:])

    # The tools are fixed per session: a /clear brings the new apps' tools.
    old = {p: first[p][-1]["id"] for p in APPS if first[p]}
    type_line("/clear"); pump(2)
    cur = {p: wait_for(lambda p=p: [s for s in live_sessions(p) if s["id"] != old.get(p)], 30, f"a new session in {p}") for p in APPS}
    sid = {p: cur[p][-1]["id"] for p in APPS if cur[p]}
    say("after /clear, sessions:", sid)
    if len(sid) < 2: raise RuntimeError("no session to send to; stopping")

    # 2. a message that uses the notes tool
    mid = send(4100, sid[4100], "Use the notes tool to add a note that says hello from BYOA, then reply done.")
    say("sent", mid)
    names = wait_for(lambda: finished(4100, mid), 180, "message 1 to finish")
    seq = [n for _, n, _ in message_events(4100, mid)]
    tools = [d["event"].get("name") for _, n, d in message_events(4100, mid) if n == "tool"]
    order_ok = seq[:2] == ["accepted", "started"] and "delta" in seq and "tool" in seq and seq[-1] == "done"
    acts = api(4100, "GET", "/api/activity")
    note = [n for n in acts["notes"] if "hello from byoa" in n["text"].lower()]
    verdict("2 tool turn", order_ok and bool(note) and note[0]["session"] == sid[4100], f"{mid}: {compact(seq)} tools={tools} activity={note}")

    # 3. one message from each app at the same time
    t0 = time.time()
    ma = send(4100, sid[4100], "Reply with exactly the word alpha.")
    mb = send(4200, sid[4200], "Reply with exactly the word bravo.")
    say(f"sent {ma} (Notes) and {mb} (Tasks) {int((time.time()-t0)*1000)} ms apart")
    wait_for(lambda: finished(4100, ma) and finished(4200, mb), 180, "both messages")
    ea, eb = message_events(4100, ma), message_events(4200, mb)
    def at(seq, name): return next((t for t, n, _ in seq if n == name), None)
    first_, second = (ea, eb) if (at(ea, "started") or 1e18) < (at(eb, "started") or 1e18) else (eb, ea)
    serial = at(first_, "done") is not None and at(second, "started") is not None and at(second, "started") >= at(first_, "done")
    verdict("3 two apps, one at a time", serial and "queued" in [n for _, n, _ in second],
            f"Notes {ma}: {compact([n for _, n, _ in ea])} | Tasks {mb}: {compact([n for _, n, _ in eb])} | second started {round((at(second, 'started') or 0) - (at(first_, 'done') or 0), 2)} s after the first was done")

    # 4. interrupt a running message
    mi = send(4100, sid[4100], "Write the numbers from 1 to 400, one per line, and nothing else.")
    wait_for(lambda: "delta" in [n for _, n, _ in message_events(4100, mi)], 120, "the long message to stream")
    out = api(4100, "POST", f"/byoa/ui/sessions/{sid[4100]}/messages/{mi}/interrupt", {})
    say("interrupt:", out)
    wait_for(lambda: finished(4100, mi), 60, "the interrupted message to end")
    seq = message_events(4100, mi)
    last = seq[-1][2]["event"] if seq and seq[-1][1] != "gone" and "event" in seq[-1][2] else {}
    verdict("4 interrupt", out.get("outcome") == "interrupt_sent" and last.get("type") == "interrupted", f"{mi}: {compact([n for _, n, _ in seq])} reason={last.get('reason')}")

    # 5. the provenance line in the terminal
    shown = re.findall(r"\[BYOA\]Notes\(localhost:4100\)·chatfromRamos·(msg_[A-Za-z0-9_-]{22})", flat_screen())
    verdict("5 provenance line", bool(shown), f"[BYOA] Notes (localhost:4100) · chat from Ramos · {shown[-1]} (and {len(shown) - 1} more)" if shown else "not on screen")

    # 6. /clear: re-registration
    before = dict(sid)
    type_line("/clear"); pump(2)
    after = {p: wait_for(lambda p=p: [s for s in live_sessions(p) if s["id"] not in (before.get(p), old.get(p))], 30, f"re-registration in {p}") for p in APPS}
    verdict("6 /clear re-registers", all(after.values()), {p: f"{before.get(p)} -> {[s['id'] for s in (after[p] or [])]}" for p in APPS})

    blocked = any(isinstance(b, list) and any(st == "blocked" and cause == "permission" for _, st, cause in b) for b in blocked_seen)
    verdict("extra: permission prompt shows as blocked", blocked, blocked_seen or "no permission prompt appeared")
    say("band above the prompt:", "BYOA·Notes,Tasks" in flat_screen())
    type_line("/exit"); pump(3)
finally:
    cleanup()
    say("summary:", " ".join(f"{s}={'PASS' if ok else 'FAIL'}" for s, ok in results))
    with open(TRANSCRIPT, "w") as f: f.write("\n".join(lines) + "\n")
sys.exit(0 if results and all(ok for _, ok in results) else 1)

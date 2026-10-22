// The demo's chat page: the person's live sessions, a chat with the chosen
// one, and the app's own activity (notes, `say`). One EventSource per tab
// carries everything (SPEC 8).

export function chatPage(appName: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${appName} · BYOA demo</title>
<style>
  body { font: 15px/1.45 system-ui, sans-serif; margin: 0; color: #1d2433; background: #f7f8fa; }
  header { padding: 14px 20px; background: #fff; border-bottom: 1px solid #e3e6ea; font-weight: 600; }
  main { display: grid; grid-template-columns: 260px 1fr 260px; gap: 16px; padding: 16px; }
  section { background: #fff; border: 1px solid #e3e6ea; border-radius: 10px; padding: 12px; min-height: 60vh; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #6b7385; margin: 0 0 8px; }
  .session { padding: 8px; border-radius: 8px; cursor: pointer; }
  .session.on { background: #eef3ff; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
  .ready { background: #22a06b } .busy { background: #e2a03f } .blocked { background: #d1453b } .gone { background: #b4b9c4 }
  .msg { margin: 8px 0; padding: 8px 10px; border-radius: 8px; white-space: pre-wrap; }
  .you { background: #eef3ff } .agent { background: #f4f5f7 } .tool { color: #6b7385; font-size: 13px }
  form { display: flex; gap: 8px; margin-top: 8px } input { flex: 1; padding: 8px; border: 1px solid #cfd4dc; border-radius: 8px }
  button { padding: 8px 12px; border-radius: 8px; border: 1px solid #cfd4dc; background: #fff; cursor: pointer }
  .muted { color: #6b7385; font-size: 13px }
</style></head>
<body><header>${appName} <span class="muted">· chat with your own agent</span></header>
<main>
  <section><h2>Your agents</h2><div id="sessions" class="muted">No agent connected. In Claude Code, Pi or OpenCode: <code>/byoa connect ${"${location.origin}"}</code></div></section>
  <section><h2>Chat</h2><div id="log"></div>
    <form id="f"><input id="t" placeholder="Ask your agent…" autocomplete="off"><button>Send</button><button type="button" id="stop">Stop</button></form></section>
  <section><h2>${appName} activity</h2><div id="activity" class="muted">Nothing yet.</div></section>
</main>
<script>
let current = null, lastMessage = null;
const answers = {};
const el = (id) => document.getElementById(id);
function line(cls, text) { const d = document.createElement("div"); d.className = "msg " + cls; d.textContent = text; el("log").append(d); return d; }
const es = new EventSource("/byoa/ui/events");
es.onmessage = (m) => {
  const e = JSON.parse(m.data);
  if (e.type === "sessions") {
    const list = e.connections.flatMap((c) => c.sessions.map((s) => ({ ...s, machine: c.machine_name })));
    if (!list.length) return;
    if (!current || !list.some((s) => s.id === current)) current = (list.find((s) => s.state !== "gone") || list[0]).id;
    el("sessions").innerHTML = "";
    for (const s of list) {
      const d = document.createElement("div");
      d.className = "session" + (s.id === current ? " on" : "");
      d.innerHTML = '<span class="dot ' + s.state + '"></span>' + s.host + ' · ' + (s.workspace.folder_name || "?") + '<div class="muted">' + s.state + (s.machine ? " · " + s.machine : "") + "</div>";
      d.onclick = () => { current = s.id; es.onmessage({ data: m.data }); };
      el("sessions").append(d);
    }
  } else if (e.type === "accepted") {
    lastMessage = e.message_id;
  } else if (e.type === "event") {
    const ev = e.event;
    if (ev.type === "delta") { (answers[e.message_id] ||= line("agent", "")).textContent += ev.text; }
    else if (ev.type === "tool") line("tool", "⚙ " + ev.title);
    else if (ev.type === "queued") line("tool", "Waiting for your agent to finish its turn…");
    else if (["done", "error", "interrupted", "withdrawn"].includes(ev.type) && ev.type !== "done") line("tool", ev.type + (ev.reason ? ": " + ev.reason : ""));
  } else if (e.type === "gone") line("tool", "Stopped: " + e.reason);
};
el("f").onsubmit = async (ev) => {
  ev.preventDefault();
  const text = el("t").value.trim(); if (!text || !current) return;
  el("t").value = ""; line("you", text);
  const r = await fetch("/byoa/ui/sessions/" + current + "/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
  if (!r.ok) line("tool", "Could not send: " + (await r.text()));
};
el("stop").onclick = () => current && lastMessage && fetch("/byoa/ui/sessions/" + current + "/messages/" + lastMessage + "/interrupt", { method: "POST" });
setInterval(async () => {
  const a = await (await fetch("/api/activity")).json();
  const rows = [...a.notes.map((n) => "📝 " + n.text), ...a.says.map((s) => "💬 " + s.text)];
  if (rows.length) el("activity").textContent = rows.join("\\n");
}, 1500);
</script></body></html>`;
}

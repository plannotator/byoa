// Pairing (RFC 8628 against pair_start / pair_poll), the credential files,
// and the connect / disconnect / status commands. Each case is a way a real
// pairing goes wrong if the rule breaks.
import assert from "node:assert/strict";
import { test } from "node:test";

import { credentialPath } from "../src/credentials.ts";
import { SLOW_DOWN_STEP_MS } from "../src/pairing.ts";
import { app, FakeApp, FakeNet, flush, HOME, MemoryFiles, world } from "./fakes.ts";

const WS = { id: "workspaces", name: "Workspaces", origin: "https://workspaces.example" };
const LOCAL = { id: "machine", name: "Machine", origin: "http://127.0.0.1:4100" };

// Catches: a code shown without naming the origin, a token saved wider than
// 0600, and the connector not picking up the approval on its timer.
test("device grant: shows link, code and origin; approval on a later tick saves a 0600 credential and connects", async () => {
	const w = await world([WS], { pair: false });
	const said = await w.connector.connect("workspaces.example");
	assert.match(said, /open https:\/\/workspaces\.example\/byoa\/connect\?code=BCDF-GHJK and check that it shows the code BCDF-GHJK/);
	assert.match(said, /Whoever runs https:\/\/workspaces\.example can start turns/);
	assert.equal(w.host.displays.at(-1)?.band, "BYOA: connect Workspaces at https://workspaces.example/byoa/connect?code=BCDF-GHJK  code BCDF-GHJK");
	assert.equal(w.net.to(WS.origin, "/pair/poll").length, 1, "the first poll goes out at once");
	await w.tick(1);
	assert.equal(w.net.to(WS.origin, "/pair/poll").length, 1, "then the interval (2 s) is kept");
	app(w.net, WS.origin).approve();
	await w.tick(2);
	await w.connector.settled();
	await flush();
	const file = w.files.files.get(credentialPath(HOME, "claude-code", WS.origin));
	assert.ok(file, "the credential file exists");
	assert.equal(file.mode, 0o600);
	assert.equal(w.files.dirs.get(`${HOME}/.byoa/credentials/claude-code`), 0o700);
	assert.equal(JSON.parse(file.text).app.name, "Workspaces");
	assert.ok(w.host.toasts.some((t) => /connected to Workspaces \(https:\/\/workspaces\.example\) as Dana/.test(t)));
	assert.match(await w.connector.status(), /Workspaces \(https:\/\/workspaces\.example\) · connected as Dana/);
	await w.tick(1);
	assert.equal(app(w.net, WS.origin).sessions.size, 1, "the attached session registered right after pairing");
});

// Catches: a local app that approves at once still printing a link and code.
test("an app that approves at once: one poll, and only 'connected', no link or code", async () => {
	const w = await world([{ ...LOCAL, approveAtOnce: true }], { pair: false });
	const said = await w.connector.connect("127.0.0.1:4100");
	assert.equal(said, "BYOA: connected to Machine (http://127.0.0.1:4100) as Dana. This session can receive its messages now; its tools reach new sessions.");
	assert.equal(w.net.to(LOCAL.origin, "/pair/poll").length, 1);
	assert.ok(!w.host.displays.some((d) => /code/.test(d.band ?? "")), "no code band was drawn");
});

// Catches: denial, expiry and unreadable errors leaving the pairing running,
// and slow_down not widening the interval for good.
test("pairing errors: slow_down widens the interval, denied and expired end it with a line", async () => {
	const w = await world([WS], { pair: false });
	const a = app(w.net, WS.origin);
	a.pollScript.push({ status: 400, body: { error: "authorization_pending" } }, { status: 400, body: { error: "slow_down" } });
	await w.connector.connect(WS.origin);
	await w.tick(2);
	await w.connector.settled();
	assert.equal(w.net.to(WS.origin, "/pair/poll").length, 2);
	await w.tick(2 + SLOW_DOWN_STEP_MS / 1000 - 1);
	await w.connector.settled();
	assert.equal(w.net.to(WS.origin, "/pair/poll").length, 2, "nothing before the widened interval");
	await w.tick(1);
	await w.connector.settled();
	assert.equal(w.net.to(WS.origin, "/pair/poll").length, 3);
	a.deny();
	await w.tick(7);
	await w.connector.settled();
	await flush();
	assert.ok(w.host.toasts.includes("BYOA: the connection was cancelled in Workspaces."));
	assert.match(await w.connector.status(), /not connected to any app/);

	a.pollScript.push({ status: 400, body: { error: "expired_token" } });
	await w.connector.connect(WS.origin);
	assert.match(await w.connector.status(), /not connected to any app/);
	assert.ok(w.files.files.size === 0, "nothing saved");
});

// Catches: a token or a person sent to another site.
test("refused before pairing: plain http off loopback, a discovery that claims another origin, an approval link on another site, a taken app id", async () => {
	const net = new FakeNet();
	const w = await world([WS], { net });
	assert.match(await w.connector.connect("http://evil.example"), /is not https/);
	net.add(new FakeApp({ id: "liar", origin: "https://liar.example", discovery: (d) => ({ ...d, app: { id: "liar", name: "Liar", origin: "https://workspaces.example" } }) }));
	assert.match(await w.connector.connect("liar.example"), /says it is https:\/\/workspaces\.example/);
	const phish = net.add(new FakeApp({ id: "phish", origin: "https://phish.example" }));
	phish.startLink = () => "https://elsewhere.example/connect?code=BCDF-GHJK";
	assert.match(await w.connector.connect("phish.example"), /approval link on another site/);
	net.add(new FakeApp({ id: "workspaces", name: "Fake Workspaces", origin: "https://copy.example" }));
	assert.match(await w.connector.connect("copy.example"), /already uses the id "workspaces"/);
	net.add(new FakeApp({ id: "offsite", origin: "https://offsite.example", discovery: (d) => ({ ...d, endpoints: { ...(d.endpoints as object), sessions: "https://other.example/s" } }) }));
	assert.match(await w.connector.connect("offsite.example"), /sessions door on another site/);
	assert.match(await w.connector.connect(WS.origin), /already connected to Workspaces/);
});

// Catches: a credential file other users can read being used anyway.
test("a credential file readable by group or others is refused and named; its app is not used", async () => {
	const files = new MemoryFiles();
	const net = new FakeNet();
	await world([WS], { files, net, attach: false });
	const path = credentialPath(HOME, "claude-code", WS.origin);
	files.chmod(path, 0o644);
	const w = await world([WS], { files, net });
	const status = await w.connector.status();
	assert.match(status, new RegExp(`${path.replace(/[.]/g, "\\.")} has mode 0644.*chmod 600`));
	await w.tick(3);
	assert.equal(app(net, WS.origin).sessions.size, 0, "never registered with a token from that file");
});

// Catches: a disconnect that leaves the token live, or a request after it.
test("disconnect revokes the token, removes the file and stops the app's links; an unreachable app keeps it", async () => {
	const w = await world([WS]);
	await w.tick(2);
	const a = app(w.net, WS.origin);
	assert.equal(a.sessions.size, 1);
	a.down = true;
	assert.match(await w.connector.disconnect("workspaces"), /could not reach Workspaces.*still live/);
	assert.ok(w.files.files.has(credentialPath(HOME, "claude-code", WS.origin)));
	a.down = false;
	assert.match(await w.connector.command("disconnect Workspaces"), /disconnected from Workspaces\. Its token is revoked and removed/);
	assert.equal(w.files.files.has(credentialPath(HOME, "claude-code", WS.origin)), false);
	assert.equal(a.revoked.size, 1);
	const before = w.net.sent.length;
	await w.tick(3);
	assert.equal(w.net.sent.length, before, "no request after disconnect");
	assert.match(await w.connector.command("disconnect nothing"), /no connected app is called nothing/);
});

// Catches: print, RPC and SDK runs registering a session.
test("a host that is not interactive registers nothing", async () => {
	const w = await world([WS], { attach: false });
	w.host.interactive = false;
	const handle = w.connector.attach(w.session);
	await w.tick(3);
	assert.equal(app(w.net, WS.origin).sessions.size, 0);
	assert.deepEqual(await handle.tools(), []);
});

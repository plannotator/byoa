// The approval-page render hook: each state reaches it as raw data, null
// falls back to the built-in page, missing security headers are added, and
// a page the app draws itself completes a pairing with the documented form.

import assert from "node:assert/strict";
import { test } from "node:test";
import { grantSentence, type ApprovalPage } from "../src/index.ts";
import { body, makeApp, ORIGIN } from "./harness.ts";

const MACHINE = "o'neil <mbp>";
const CLIENT = { client: { host: "claude-code", connector: "byoa", connector_version: "0.1.0", machine_name: MACHINE } };

/** An app whose hook records every page and draws nothing. */
function recording(draw: (page: ApprovalPage, req: Request) => Response | null | undefined = () => null) {
	const pages: ApprovalPage[] = [];
	const urls: string[] = [];
	const app = makeApp({
		renderPage: (page, req) => {
			pages.push(page);
			urls.push(req.url);
			return draw(page, req);
		},
	});
	return { app, pages, urls };
}

async function start(app: ReturnType<typeof makeApp>) {
	return body(app.call("POST", "/byoa/pair/start", { body: CLIENT }));
}

test("every state reaches the hook with its raw data", async () => {
	const { app, pages, urls } = recording();
	const s = await start(app);

	await app.call("GET", "/byoa/connect");
	assert.deepEqual(pages.at(-1), { state: "signIn", status: 401, appName: "Test App" });
	assert.equal(urls.at(-1), `${ORIGIN}/byoa/connect`);

	await app.call("GET", "/byoa/connect", { user: "ramos" });
	assert.deepEqual(pages.at(-1), { state: "entry", status: 200, appName: "Test App", formAction: "/byoa/connect", codeField: "code", accountName: "Ramos" });

	await app.call("GET", "/byoa/connect?code=BCDF-GHJK", { user: "ramos" });
	assert.deepEqual(pages.at(-1), { state: "invalid", status: 200, appName: "Test App", formAction: "/byoa/connect", codeField: "code" });

	await app.clock.advance(75_000);
	await app.call("GET", `/byoa/connect?code=${s.user_code.toLowerCase()}`, { user: "ramos" });
	const consent = pages.at(-1);
	assert.ok(consent?.state === "consent");
	assert.match(consent.csrfToken, /^[A-Za-z0-9_-]{43}$/);
	assert.deepEqual(consent, {
		state: "consent",
		status: 200,
		appName: "Test App",
		formAction: "/byoa/connect",
		accountName: "Ramos",
		userCode: s.user_code,
		ageSeconds: 75,
		host: "claude-code",
		hostName: "Claude Code",
		machineName: MACHINE,
		machineVerified: false,
		grant: `Claude Code on ${MACHINE} can use Test App as you, and Test App can start turns in that agent's sessions.`,
		csrfToken: consent.csrfToken,
		form: { method: "POST", fields: { code: "code", csrf: "csrf", decision: "decision" }, decisions: { connect: "connect", cancel: "cancel" } },
	});
	assert.equal(grantSentence(consent), consent.grant);

	await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: s.user_code, csrf: "forged", decision: "connect" } });
	assert.deepEqual(pages.at(-1), { state: "expired", status: 403, appName: "Test App" });

	await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: s.user_code, csrf: consent.csrfToken, decision: "connect" } });
	assert.deepEqual(pages.at(-1), { state: "connected", status: 200, appName: "Test App", host: "claude-code", hostName: "Claude Code" });

	const other = await start(app);
	await app.call("GET", `/byoa/connect?code=${other.user_code}`, { user: "ramos" });
	const csrf = (pages.at(-1) as Extract<ApprovalPage, { state: "consent" }>).csrfToken;
	await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: other.user_code, csrf, decision: "cancel" } });
	assert.deepEqual(pages.at(-1), { state: "cancelled", status: 200, appName: "Test App" });

	await app.call("POST", "/byoa/connect", { form: { code: other.user_code, csrf, decision: "cancel" } });
	assert.deepEqual(pages.at(-1), { state: "signIn", status: 401, appName: "Test App" });
	assert.deepEqual([...new Set(pages.map((p) => p.state))].sort(), ["cancelled", "connected", "consent", "entry", "expired", "invalid", "signIn"]);
});

test("null or undefined falls back to the built-in page, byte for byte", async () => {
	for (const nothing of [null, undefined]) {
		const plain = makeApp();
		const hooked = recording(() => nothing).app;
		const read = async (app: ReturnType<typeof makeApp>, path: string, user?: string) => {
			const res = await app.call("GET", path, user === undefined ? {} : { user });
			return { status: res.status, headers: [...res.headers], text: await res.text() };
		};
		for (const [path, user] of [["/byoa/connect", undefined], ["/byoa/connect", "ramos"], ["/byoa/connect?code=BCDF-GHJK", "ramos"]] as const)
			assert.deepEqual(await read(hooked, path, user), await read(plain, path, user), `${String(nothing)} ${path}`);
	}
});

test("a custom page gets the security headers it left out, and keeps the ones it set", async () => {
	const { app } = recording(
		(page) =>
			new Response(`<p>${page.state}</p>`, {
				status: page.status,
				headers: { "content-type": "text/html", "x-frame-options": "SAMEORIGIN", "content-security-policy": "default-src 'self'", "x-app": "mine" },
			}),
	);
	const res = await app.call("GET", "/byoa/connect", { user: "ramos" });
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "<p>entry</p>");
	assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
	assert.equal(res.headers.get("content-security-policy"), "default-src 'self'");
	assert.equal(res.headers.get("content-type"), "text/html");
	assert.equal(res.headers.get("x-app"), "mine");
	assert.equal(res.headers.get("cache-control"), "no-store");
	assert.equal(res.headers.get("referrer-policy"), "no-referrer");
	assert.equal(res.headers.get("x-content-type-options"), "nosniff");

	// Immutable headers (a redirect's) are copied, not written to.
	const redirect = recording(() => Response.redirect(`${ORIGIN}/elsewhere`, 302)).app;
	const moved = await redirect.call("GET", "/byoa/connect", { user: "ramos" });
	assert.equal(moved.status, 302);
	assert.equal(moved.headers.get("location"), `${ORIGIN}/elsewhere`);
	assert.equal(moved.headers.get("x-frame-options"), "DENY");
	assert.ok(moved.headers.get("content-security-policy")?.startsWith("default-src 'none'"));

	// A response with every header set is returned as it is.
	const full = new Response("ok", {
		headers: { "content-security-policy": "a", "x-frame-options": "b", "cache-control": "c", "referrer-policy": "d", "x-content-type-options": "e" },
	});
	const same = recording(() => full).app;
	assert.equal(await same.call("GET", "/byoa/connect", { user: "ramos" }), full);
});

test("a full pairing through a custom consent page that POSTs the documented fields", async () => {
	const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
	// The app's own markup: nothing like the built-in page.
	const { app, pages } = recording((page) => {
		if (page.state !== "consent") return new Response(`<section data-state="${page.state}"></section>`, { status: page.status });
		const { fields, decisions } = page.form;
		return new Response(
			`<section data-state="consent"><h2>${esc(page.hostName)} wants in</h2><code>${esc(page.userCode)}</code><small>${page.ageSeconds}s</small>
<p>${esc(page.machineName ?? "")} (unverified)</p><p>${esc(page.accountName)}</p><p>${esc(page.grant)}</p>
<form data-method="${page.form.method}" data-action="${esc(page.formAction)}"><input data-name="${fields.code}" data-value="${esc(page.userCode)}"><input data-name="${fields.csrf}" data-value="${esc(page.csrfToken)}"><button data-name="${fields.decision}" data-value="${decisions.connect}">Yes</button></form></section>`,
			{ headers: { "content-type": "text/html" } },
		);
	});
	const s = await start(app);
	const html = await (await app.call("GET", `/byoa/connect?code=${s.user_code}`, { user: "ramos" })).text();
	assert.ok(html.includes("o&#39;neil &#60;mbp&#62; (unverified)"), "the app escaped the raw machine name");
	const action = /data-action="([^"]+)"/.exec(html)?.[1] ?? "";
	const form: Record<string, string> = {};
	for (const [, name, value] of html.matchAll(/data-name="([^"]+)" data-value="([^"]+)"/g)) form[name as string] = value as string;
	assert.deepEqual(Object.keys(form).sort(), ["code", "csrf", "decision"]);

	const decided = await app.call("POST", action, { user: "ramos", form });
	assert.match(await decided.text(), /data-state="connected"/);
	assert.equal(pages.at(-1)?.state, "connected");
	await app.clock.advance(2000);
	const collected = await body(app.call("POST", "/byoa/pair/poll", { body: { device_code: s.device_code } }));
	assert.match(collected.access_token, /^byoa_/);
	assert.ok((await app.register(collected.access_token)).startsWith("ses_"));
});

test("the invalid state gets identical data for unknown, expired and used codes", async () => {
	const { app, pages } = recording();
	const used = await start(app);
	await app.call("GET", `/byoa/connect?code=${used.user_code}`, { user: "ramos" });
	const csrf = (pages.at(-1) as Extract<ApprovalPage, { state: "consent" }>).csrfToken;
	await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: used.user_code, csrf, decision: "connect" } });
	const expired = await start(app);
	await app.clock.advance(600_000);

	const seen: ApprovalPage[] = [];
	for (const code of ["BCDF-GHJK", "nonsense", used.user_code, expired.user_code]) {
		await app.call("GET", `/byoa/connect?code=${code}`, { user: "ramos" });
		seen.push(pages.at(-1) as ApprovalPage);
	}
	// A replayed approval form, and a POST for an expired code, meet the same data.
	await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: used.user_code, csrf, decision: "connect" } });
	seen.push(pages.at(-1) as ApprovalPage);
	await app.call("POST", "/byoa/connect", { user: "ramos", form: { code: expired.user_code, csrf, decision: "connect" } });
	seen.push(pages.at(-1) as ApprovalPage);
	for (const page of seen) assert.deepEqual(page, { state: "invalid", status: 200, appName: "Test App", formAction: "/byoa/connect", codeField: "code" });
});

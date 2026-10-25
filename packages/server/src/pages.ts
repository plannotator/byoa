// The approval pages of the device grant (SPEC 4.1): server-rendered, no
// script, inline style only, so the page's CSP can be default-src 'none'.
// Everything a request supplied is escaped. The pages say what connecting
// grants, mark what the agent declared as unverified, and show the request's
// age, the controls SPEC 9.9 names against pairing phishing. An app may draw
// the page itself through `renderPage`; pairing.ts still makes every check.

import type { ApprovalPage, ByoaOptions } from "./types.ts";

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f6f6f4;color:#1b1b18}
main{max-width:440px;margin:10vh auto;padding:28px;background:#fff;border:1px solid #e2e2dc;border-radius:12px}
h1{font-size:19px;margin:0 0 12px}p{margin:8px 0}.code{font:600 20px ui-monospace,Menlo,monospace;letter-spacing:.08em}
.muted{color:#66665e}.grant{padding:12px;background:#f6f6f4;border-radius:8px}
form{display:flex;gap:8px;margin-top:18px}button,input{font:inherit;padding:7px 14px;border-radius:7px;border:1px solid #c9c9c0;background:#fff}
button.primary{background:#1b1b18;color:#fff;border-color:#1b1b18}input{flex:1;text-transform:uppercase;font-family:ui-monospace,Menlo,monospace}`;

const HEADERS: Record<string, string> = {
	"content-type": "text/html; charset=utf-8",
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	"x-frame-options": "DENY",
	"cache-control": "no-store",
	// same-origin, not no-referrer: under no-referrer a browser's form POST
	// carries `Origin: null`. The page's URL holds the code, and it never
	// leaves the app's origin either way.
	"referrer-policy": "same-origin",
	"x-content-type-options": "nosniff",
};

/** Added to an app's own page when it left them out. */
const SECURITY_HEADERS = ["content-security-policy", "x-frame-options", "cache-control", "referrer-policy", "x-content-type-options"];

const HOST_NAMES: Record<string, string> = { "claude-code": "Claude Code", pi: "Pi", opencode: "OpenCode", amp: "Amp" };

export function hostName(host: string): string {
	// Own keys only: a declared host of "constructor" names itself, not Object's.
	return Object.hasOwn(HOST_NAMES, host) ? (HOST_NAMES[host] as string) : host;
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string, status = 200): Response {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
	return new Response(html, { status, headers: HEADERS });
}

function entryForm(action: string): string {
	return `<form method="get" action="${escapeHtml(action)}"><input name="code" aria-label="Code from your terminal" placeholder="XXXX-XXXX" autocomplete="off" maxlength="16" required><button class="primary" type="submit">Continue</button></form>`;
}

type Page<S extends ApprovalPage["state"]> = Extract<ApprovalPage, { state: S }>;

/** The words that say what connecting grants (SPEC 4.1), raw. Pass the
 * consent page, or the same three names. */
export function grantSentence(input: { hostName: string; machineName: string | null; appName: string }): string {
	return grantWords(input, (text) => text);
}

function grantWords(input: { hostName: string; machineName: string | null; appName: string }, esc: (text: string) => string): string {
	const machine = input.machineName ?? "an unnamed machine";
	return `${esc(input.hostName)} on ${esc(machine)} can use ${esc(input.appName)} as you, and ${esc(input.appName)} can start turns in that agent's sessions.`;
}

function entryPage(p: Page<"entry">): Response {
	return page(`Connect an agent to ${p.appName}`, `<h1>Connect an agent to ${escapeHtml(p.appName)}</h1><p class="muted">Signed in as <strong>${escapeHtml(p.accountName)}</strong>. Enter the code your terminal shows.</p>${entryForm(p.formAction)}`, p.status);
}

/** The same bytes for an unknown, expired, cancelled or used code, so the
 * page tells nobody which codes exist. */
function invalidPage(p: Page<"invalid">): Response {
	return page("This code is not valid", `<h1>This code is not valid</h1><p class="muted">Check the code in your terminal, or start again there. Codes for ${escapeHtml(p.appName)} last ten minutes and work once.</p>${entryForm(p.formAction)}`, p.status);
}

function signInPage(p: Page<"signIn">): Response {
	return page(`Sign in to ${p.appName}`, `<h1>Sign in to ${escapeHtml(p.appName)} first</h1><p class="muted">Then open this link again. Connecting an agent needs your own signed-in session.</p>`, p.status);
}

function expiredPage(p: Page<"expired">): Response {
	return page("This request expired", `<h1>This request expired</h1><p class="muted">Nothing was connected. Open the link from your terminal again.</p>`, p.status);
}

function consentPage(p: Page<"consent">): Response {
	const machine = p.machineName ?? "an unnamed machine";
	const age = p.ageSeconds < 60 ? `${p.ageSeconds} seconds` : `${Math.round(p.ageSeconds / 60)} minutes`;
	const { fields, decisions } = p.form;
	return page(
		`Connect ${p.hostName} to ${p.appName}`,
		`<h1>Connect ${escapeHtml(p.hostName)} to ${escapeHtml(p.appName)}</h1>
<p>Code <span class="code">${escapeHtml(p.userCode)}</span>, requested ${escapeHtml(age)} ago. Continue only if it matches your terminal.</p>
<p>Machine: <strong>${escapeHtml(machine)}</strong> <span class="muted">(unverified: the agent named it; ${escapeHtml(p.appName)} cannot check it, or the host)</span></p>
<p>Account: <strong>${escapeHtml(p.accountName)}</strong></p>
<p class="grant">${grantWords(p, escapeHtml)}</p>
<p class="muted">If you did not start this, press Cancel. You can disconnect it any time.</p>
<form method="post" action="${escapeHtml(p.formAction)}"><input type="hidden" name="${fields.code}" value="${escapeHtml(p.userCode)}"><input type="hidden" name="${fields.csrf}" value="${escapeHtml(p.csrfToken)}"><button class="primary" type="submit" name="${fields.decision}" value="${decisions.connect}">Connect</button><button type="submit" name="${fields.decision}" value="${decisions.cancel}">Cancel</button></form>`,
		p.status,
	);
}

function connectedPage(p: Page<"connected">): Response {
	return page("Connected", `<h1>Connected. Go back to your terminal.</h1><p class="muted">${escapeHtml(p.hostName)} picks up the connection by itself. You can close this tab.</p>`, p.status);
}

function cancelledPage(p: Page<"cancelled">): Response {
	return page("Cancelled", `<h1>Cancelled.</h1><p class="muted">Nothing was connected. You can close this tab.</p>`, p.status);
}

export function builtInPage(p: ApprovalPage): Response {
	switch (p.state) {
		case "entry":
			return entryPage(p);
		case "invalid":
			return invalidPage(p);
		case "signIn":
			return signInPage(p);
		case "expired":
			return expiredPage(p);
		case "consent":
			return consentPage(p);
		case "connected":
			return connectedPage(p);
		case "cancelled":
			return cancelledPage(p);
	}
}

/** The app's page when it drew one, with any security header it left out
 * added; otherwise the built-in page. */
export async function renderPage(p: ApprovalPage, req: Request, hook: ByoaOptions["renderPage"]): Promise<Response> {
	const custom = hook === undefined ? null : await hook(p, req);
	if (custom === null || custom === undefined) return builtInPage(p);
	const missing = SECURITY_HEADERS.filter((name) => !custom.headers.has(name));
	if (missing.length === 0) return custom;
	// A copy, since a response's headers may be immutable (one from fetch()).
	const headers = new Headers(custom.headers);
	for (const name of missing) headers.set(name, HEADERS[name] as string);
	return new Response(custom.body, { status: custom.status, statusText: custom.statusText, headers });
}

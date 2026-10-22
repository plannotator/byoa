// The approval pages of the device grant (SPEC 4.1): server-rendered, no
// script, inline style only, so the page's CSP can be default-src 'none'.
// Everything a request supplied is escaped. The pages say what connecting
// grants, mark what the agent declared as unverified, and show the request's
// age, the controls SPEC 9.9 names against pairing phishing.

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
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
};

const HOST_NAMES: Record<string, string> = { "claude-code": "Claude Code", pi: "Pi", opencode: "OpenCode", amp: "Amp" };

export function hostName(host: string): string {
	return HOST_NAMES[host] ?? host;
}

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function page(title: string, body: string, status = 200): Response {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
	return new Response(html, { status, headers: HEADERS });
}

function entryForm(action: string): string {
	return `<form method="get" action="${escapeHtml(action)}"><input name="code" aria-label="Code from your terminal" placeholder="XXXX-XXXX" autocomplete="off" maxlength="16" required><button class="primary" type="submit">Continue</button></form>`;
}

export function entryPage(app: string, action: string, account: string): Response {
	return page(`Connect an agent to ${app}`, `<h1>Connect an agent to ${escapeHtml(app)}</h1><p class="muted">Signed in as <strong>${escapeHtml(account)}</strong>. Enter the code your terminal shows.</p>${entryForm(action)}`);
}

/** The one answer for an unknown, expired, cancelled or used code: the same
 * bytes whichever it is, so the page tells nobody which codes exist. */
export function invalidPage(app: string, action: string): Response {
	return page("This code is not valid", `<h1>This code is not valid</h1><p class="muted">Check the code in your terminal, or start again there. Codes for ${escapeHtml(app)} last ten minutes and work once.</p>${entryForm(action)}`);
}

export function signInPage(app: string): Response {
	return page(`Sign in to ${app}`, `<h1>Sign in to ${escapeHtml(app)} first</h1><p class="muted">Then open this link again. Connecting an agent needs your own signed-in session.</p>`, 401);
}

export function expiredPage(): Response {
	return page("This request expired", `<h1>This request expired</h1><p class="muted">Nothing was connected. Open the link from your terminal again.</p>`, 403);
}

export function consentPage(input: {
	app: string;
	action: string;
	host: string;
	machine: string | null;
	account: string;
	userCode: string;
	ageSeconds: number;
	csrf: string;
}): Response {
	const host = hostName(input.host);
	const machine = input.machine ?? "an unnamed machine";
	const age = input.ageSeconds < 60 ? `${input.ageSeconds} seconds` : `${Math.round(input.ageSeconds / 60)} minutes`;
	return page(
		`Connect ${host} to ${input.app}`,
		`<h1>Connect ${escapeHtml(host)} to ${escapeHtml(input.app)}</h1>
<p>Code <span class="code">${escapeHtml(input.userCode)}</span>, requested ${escapeHtml(age)} ago. Continue only if it matches your terminal.</p>
<p>Machine: <strong>${escapeHtml(machine)}</strong> <span class="muted">(unverified: the agent named it; ${escapeHtml(input.app)} cannot check it, or the host)</span></p>
<p>Account: <strong>${escapeHtml(input.account)}</strong></p>
<p class="grant">${escapeHtml(host)} on ${escapeHtml(machine)} can use ${escapeHtml(input.app)} as you, and ${escapeHtml(input.app)} can start turns in that agent's sessions.</p>
<p class="muted">If you did not start this, press Cancel. You can disconnect it any time.</p>
<form method="post" action="${escapeHtml(input.action)}"><input type="hidden" name="code" value="${escapeHtml(input.userCode)}"><input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}"><button class="primary" type="submit" name="decision" value="connect">Connect</button><button type="submit" name="decision" value="cancel">Cancel</button></form>`,
	);
}

export function connectedPage(host: string): Response {
	return page("Connected", `<h1>Connected. Go back to your terminal.</h1><p class="muted">${escapeHtml(hostName(host))} picks up the connection by itself. You can close this tab.</p>`);
}

export function cancelledPage(): Response {
	return page("Cancelled", `<h1>Cancelled.</h1><p class="muted">Nothing was connected. You can close this tab.</p>`);
}

// Every line the connector shows a person, in one place, so every host says
// the same thing. Status text only: the connector never composes a turn's
// text beyond its provenance line. App-supplied values go through `shown`.

import { shown } from "./clean.ts";

export const COMMAND = "/byoa";

const app = (name: string) => shown(name, 80);

export const text = {
	help: () => `BYOA: ${COMMAND} connect <address> | disconnect <app> | status`,
	connectWhat: () => `BYOA: connect to which app? ${COMMAND} connect <address>, for example ${COMMAND} connect workspaces.example`,
	badAddress: (why: string) => `BYOA: cannot connect: ${why}.`,
	notAnApp: (origin: string, why: string) => `BYOA: ${origin} is not a BYOA app this connector can use (${shown(why)}).`,
	unreachable: (origin: string, why: string) => `BYOA: could not reach ${origin} (${shown(why)}). Try ${COMMAND} connect again.`,
	idTaken: (id: string, other: string) => `BYOA: another connected app, at ${other}, already uses the id "${id}". Disconnect it first: ${COMMAND} disconnect ${other}`,
	alreadyConnected: (name: string, account: string, origin: string) =>
		`BYOA: already connected to ${app(name)} (${origin}) as ${account}. To connect again, run ${COMMAND} disconnect ${origin} first.`,
	/** Names the origin every time: whoever runs it can start turns here. */
	pairing: (name: string, origin: string, url: string, code: string, local: boolean) =>
		`BYOA: to connect this agent to ${app(name)} at ${origin}${local ? " (an app on this machine)" : ""}, open ${url} and check that it shows the code ${code}. Whoever runs ${origin} can start turns in this agent and use it as you; connect only if you trust it.`,
	requiresWithheld: (name: string, fields: string[]) =>
		`${app(name)} needs ${fields.join(" and ")}, which ~/.byoa/policy.json does not share with it; sessions will not register there until it does.`,
	codeBand: (name: string, url: string, code: string) => `BYOA: connect ${app(name)} at ${url}  code ${code}`,
	waiting: (name: string, url: string, code: string) => `BYOA: waiting for approval in ${app(name)}. Open ${url} and check the code ${code}.`,
	retrying: (why: string) => `BYOA: still waiting for approval; ${shown(why)}, retrying.`,
	connected: (name: string, account: string, origin: string) =>
		`BYOA: connected to ${app(name)} (${origin}) as ${account}. This session can receive its messages now; its tools reach new sessions.`,
	denied: (name: string) => `BYOA: the connection was cancelled in ${app(name)}.`,
	expired: (name: string) => `BYOA: the code for ${app(name)} expired before it was approved. Run ${COMMAND} connect again for a new one.`,
	failed: (name: string, why: string) => `BYOA: pairing with ${app(name)} failed (${shown(why)}).`,
	rateLimited: (seconds: number) => `BYOA: too many pairing requests; try again in ${seconds} s.`,
	saveFailed: (name: string, why: string) =>
		`BYOA: ${app(name)} approved this agent but the token could not be saved (${shown(why)}). Disconnect it in the app, then connect again.`,
	nothingToDisconnect: (what: string) => `BYOA: no connected app is called ${shown(what, 80)}. ${COMMAND} status lists them.`,
	disconnectWhich: () => `BYOA: disconnect which app? ${COMMAND} disconnect <app>`,
	disconnected: (name: string, path: string) => `BYOA: disconnected from ${app(name)}. Its token is revoked and removed from ${path}.`,
	disconnectedLocally: (name: string, path: string) =>
		`BYOA: ${app(name)} no longer knew this token. Removed it from ${path}.`,
	disconnectUnreachable: (name: string, why: string) =>
		`BYOA: could not reach ${app(name)} (${shown(why)}). The token is still live and still on this machine. Try again, or disconnect in the app.`,
	pairingStopped: (name: string) => `BYOA: pairing with ${app(name)} stopped. Nothing was connected.`,
	revoked: (name: string, origin: string) =>
		`BYOA: ${app(name)} disconnected this agent (its token was revoked). ${COMMAND} connect ${origin} to connect again.`,
	band: (names: string[]) => `BYOA · ${names.map(app).join(", ")}`,
	noApps: () => `BYOA: not connected to any app. ${COMMAND} connect <address> to connect one.`,
	sessionLine: (state: string) => `this session: ${state}`,
	toolsFailed: (name: string, why: string) => `BYOA: ${app(name)}'s tools are not available in this session (${shown(why)}).`,
} as const;

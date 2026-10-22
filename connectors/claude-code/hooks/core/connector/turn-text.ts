// GENERATED from packages/connector-core/src/turn-text.ts by connectors/claude-code/scripts/sync-core.mjs. Edit the source, not this copy.
// The text a message becomes in the host (SPEC 6): the connector's own
// provenance line, then the app's text verbatim. The line names the app and
// origin from the connector's pairing record, so an app cannot pass for
// another app or for the person. The connector never composes the rest.
//
// Our turns are recognised by this exact text, never by a host's framing
// sentence. "Contains", because Claude Code wraps a plugin's prompt in its
// own frame.

import { provenanceLine, type MessageCommand } from "./protocol.ts";

export function turnText(app: { name: string; origin: string }, message: MessageCommand): string {
	const line = provenanceLine({
		appName: app.name,
		origin: app.origin,
		kind: message.kind,
		from: message.from.display_name,
		messageId: message.message_id,
	});
	return `${line}\n${message.text}`;
}

/** A text that would run a slash command on Claude Code is never submitted. */
export function isSlashCommand(text: string): boolean {
	return text.trim().startsWith("/");
}

/** True when the prompt the host shows is, or wraps, `submitted`. */
export function matchesTurn(prompt: string, submitted: string): boolean {
	return prompt === submitted || (submitted.length > 0 && prompt.includes(submitted));
}

// Which turn is the one our own `$.prompt.submit` started, and which prompts
// end a turn of ours (forked from Workspaces' turns-match.ts). Pure, so the
// rules read in one place and test without a session.
//
// Matching never depends on Claude Code's frame around a plugin's prompt
// ("The byoa plugin sent a message: ..."; the engine may reword it). It rests
// on what this plugin controls:
//   - the text it submitted: the turn's text must hold its first line (the
//     provenance line, unique per message), and its last line after that;
//   - Claude Code stamps a plugin's own submit `origin: { kind: 'plugin',
//     name }` for every other hook, so a prompt this plugin's hook sees that
//     is not stamped with its own name is someone else's, and a turn that
//     holds such a prompt is never streamed.

/** This plugin's name, as Claude Code stamps it on the prompts it submits. */
export const PLUGIN_NAME = 'byoa'

/** Origins (`PromptSubmitInput.origin.kind`) of a prompt that is the agent's
 * own work rather than another party's intent: delivered into our turn, it
 * does not end it.
 *   - `task-notification`: a background task the agent itself started (a
 *     background Bash run, a Monitor, a background agent) reporting back. It
 *     carries that task's output, as a tool result does.
 * Every other kind ends our turn: `composer` and `bridge` (the person),
 * `peer`, `peer-send-message`, `projects-relay`, `coordinator`, `channel`,
 * `slack-ping`, `scheduled-trigger`, `auto-continuation`, `observer`,
 * `observer-activity`, `plugin` (another plugin), `sdk`, `unclassified`, and
 * any kind a newer Claude Code adds: fail closed. */
export const OWN_WORK_ORIGINS: ReadonlySet<string> = new Set(['task-notification'])

/** True when a prompt of this origin, delivered into our running turn, ends
 * our ownership of it. */
export function takesOver(origin: { kind?: unknown } | undefined): boolean {
  const kind = typeof origin?.kind === 'string' ? origin.kind : ''
  return !OWN_WORK_ORIGINS.has(kind)
}

/** True when the origin is this plugin's own submit. */
export function isOwnSubmit(origin: { kind?: unknown; name?: unknown } | undefined): boolean {
  return origin?.kind === 'plugin' && origin.name === PLUGIN_NAME
}

/** How a starting turn relates to the text this plugin submitted:
 *   - `ours`: the turn carries our text and nothing someone else submitted;
 *   - `merged`: it carries our text AND another party's prompt (Claude Code
 *     ran them as one turn): our message ran, but not alone, so nothing of
 *     it may stream; the message ends taken over;
 *   - `other`: not our turn (our text is absent, or the turn is another
 *     party's prompt that quotes ours, a paste). */
export function matchTurn(turnText: string, submitted: string, foreign: readonly string[]): 'ours' | 'merged' | 'other' {
  const lines = submitted.split('\n')
  const first = lines[0] ?? ''
  const last = lines[lines.length - 1] ?? ''
  if (first.length === 0) return 'other'
  const at = turnText.indexOf(first)
  if (at < 0) return 'other'
  const end = turnText.indexOf(last, lines.length > 1 ? at + first.length : at)
  if (end < 0) return 'other'
  const others = foreign.filter((f) => f.trim().length > 0)
  for (const f of others) if (f.includes(first) && turnText.includes(f)) return 'other'
  const rest = turnText.slice(0, at) + turnText.slice(end + last.length)
  for (const f of others) if (rest.includes(f)) return 'merged'
  return 'ours'
}

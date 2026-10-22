// Whether the person's permission rules and prompt let a proxied tool call
// run (SPEC 9.4: the host's permission prompts are the control). Pure.
//
// A tool a mod registers with `$.tool.register` is answered in its
// `tool.call` hook, and a hook that answers without `next(e)` skips the
// permission check: no prompt, no allow or deny rule. So the hook calls
// `next(e)` first. Inside it Claude Code runs the rules, the mode and the
// prompt. A call they refuse comes back as a refusal or an error naming the
// missing permission. A call they allow goes on to core, and core has
// nothing to run for a registered tool, so it answers with its own error
// "<plugin> registered the tool <name> but no tool.call hook answered this
// call" (seen on 2.1.306). That error, and only it, means "allowed".
//
// Fail closed: any other result, including that error reworded by a newer
// Claude Code, means the call does not reach the app.

/** The words of core's answer to a registered tool that only it reached. */
export const ALLOWED_SIGN = 'no tool.call hook answered this call'

export function allowedByHost(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false
  const r = result as { deny?: unknown; isError?: unknown; text?: unknown; result?: unknown }
  if (typeof r.deny === 'string' || r.isError !== true) return false
  const text = typeof r.text === 'string' ? r.text : typeof r.result === 'string' ? r.result : ''
  return text.includes(ALLOWED_SIGN)
}

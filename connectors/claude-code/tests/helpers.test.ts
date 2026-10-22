// Under `claude plugin test`: the adapter's pure helpers, without the kit's
// engine. What each test catches is named on it.
import { describe, expect, test } from 'claude-code/testing'

import { allowedByHost } from '../hooks/permission.ts'
import { sessionSettings, valueTyped } from '../hooks/settings.ts'
import { parseList, parseRead } from '../hooks/shell.ts'
import { isOwnSubmit, matchTurn, takesOver } from '../hooks/turns-match.ts'
import { folderName, remoteLabel } from '../hooks/workspace.ts'

const OURS = '[BYOA] Notes (localhost:4100) · chat from Ramos · msg_1\nadd a note\nthen reply done'

describe('turns-match', () => {
  // Catches: matching on Claude Code's frame sentence instead of our text.
  test('our text inside any frame is ours', () => {
    expect(matchTurn(`Some plugin frame:\n${OURS}\n(trailer)`, OURS, [])).toBe('ours')
    expect(matchTurn(OURS, OURS, [])).toBe('ours')
  })
  // Catches: another message's turn claimed (the provenance line differs).
  test('another message, or no message, is other', () => {
    expect(matchTurn(OURS.replace('msg_1', 'msg_2'), OURS, [])).toBe('other')
    expect(matchTurn('hello', OURS, [])).toBe('other')
  })
  // Catches: a person's paste of our text claimed as our turn.
  test("someone else's prompt that quotes ours is other", () => {
    const paste = `look: ${OURS}`
    expect(matchTurn(paste, OURS, [paste])).toBe('other')
  })
  // Catches: a turn carrying our text and the person's prompt streamed.
  test('our text plus a foreign prompt is merged', () => {
    expect(matchTurn(`${OURS}\nalso check billing`, OURS, ['also check billing'])).toBe('merged')
  })
  // Catches: a background task's report ending our turn; a newer origin
  // kind failing open.
  test('only the agent’s own task notifications leave our turn alone', () => {
    expect(takesOver({ kind: 'task-notification' })).toBe(false)
    for (const kind of ['composer', 'bridge', 'peer', 'plugin', 'unclassified', 'something-new']) expect(takesOver({ kind })).toBe(true)
    expect(takesOver(undefined)).toBe(true)
  })
  // Catches: another plugin's prompt mistaken for ours.
  test('only a plugin prompt stamped byoa is our own', () => {
    expect(isOwnSubmit({ kind: 'plugin', name: 'byoa' })).toBe(true)
    expect(isOwnSubmit({ kind: 'plugin', name: 'other' })).toBe(false)
    expect(isOwnSubmit({ kind: 'composer' })).toBe(false)
  })
})

describe('workspace', () => {
  // Catches: a token inside a remote URL leaving the machine.
  test('remotes become host/path with no user, password, scheme or .git', () => {
    expect(remoteLabel('git@github.com:acme/app.git')).toBe('github.com/acme/app')
    expect(remoteLabel('https://x-access-token:ghs_secret@github.com/acme/app.git\n')).toBe('github.com/acme/app')
    expect(remoteLabel('ssh://git@GitHub.com:22/acme/app')).toBe('github.com/acme/app')
    expect(remoteLabel('https://gitlab.example/group/sub/app/')).toBe('gitlab.example/group/sub/app')
  })
  // Catches: a local path sent as if it were a remote.
  test('local paths and junk give nothing', () => {
    expect(remoteLabel('/srv/git/app.git')).toBe(null)
    expect(remoteLabel('file:///srv/git/app.git')).toBe(null)
    expect(remoteLabel('')).toBe(null)
    expect(remoteLabel('two words')).toBe(null)
  })
  test('folder name', () => {
    expect(folderName('/home/test/northstar')).toBe('northstar')
    expect(folderName('/home/test/northstar/')).toBe('northstar')
    expect(folderName('/')).toBe('/')
  })
})

describe('settings', () => {
  // Catches: a setting offered that this Claude Code cannot apply, or a
  // value claimed that is not known.
  test('offered per command, null until known', () => {
    expect(sessionSettings(new Set(['model']), {})).toEqual([
      { id: 'model', name: 'Model', value: null, choices: [{ value: 'default', name: 'Default' }, { value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }, { value: 'haiku', name: 'Haiku' }] },
    ])
    expect(sessionSettings(new Set(['effort']), {})[0]?.choices.find((c) => c.value === 'xhigh')?.name).toBe('Extra high')
    expect(sessionSettings(new Set(['model', 'effort']), { effort: 'high' }).map((s) => s.value)).toEqual([null, 'high'])
  })
  test("the person's own /model: a choice, else unknown", () => {
    expect(valueTyped('model', ' Opus ')).toBe('opus')
    expect(valueTyped('model', '')).toBe(null)
    expect(valueTyped('model', 'claude-opus-4-1')).toBe(null)
  })
})

describe('permission', () => {
  // Catches: a proxied tool reaching the app when the person's rules or
  // prompt refused it, or when Claude Code's answer is not the known sign.
  test("only core's unanswered-tool error means allowed", () => {
    expect(allowedByHost({ ref: 1, isError: true, result: 'Error: byoa registered the tool notes but no tool.call hook answered this call: add on(...)', text: 'byoa registered the tool notes but no tool.call hook answered this call: add on(...)' })).toBe(true)
    expect(allowedByHost({ ref: 1, isError: true, text: "Claude requested permissions to use mcp__byoa__notes, but you haven't granted it yet." })).toBe(false)
    expect(allowedByHost({ deny: 'no tool.call hook answered this call' })).toBe(false)
    expect(allowedByHost({ result: 'no tool.call hook answered this call' })).toBe(false)
    expect(allowedByHost({ ref: 1, isError: true, text: 'The user doesn’t want to proceed with this tool use.' })).toBe(false)
    expect(allowedByHost(undefined)).toBe(false)
  })
})

describe('shell output', () => {
  test('read: mode and text, or missing', () => {
    expect(parseRead('missing\n')).toBe(null)
    expect(parseRead('mode 600\n{"a":1}\nsecond')).toEqual({ mode: 0o600, text: '{"a":1}\nsecond' })
    expect(() => parseRead('garbage')).toThrow()
  })
  test('list: names', () => {
    expect(parseList('a.json\nb.json\n')).toEqual(['a.json', 'b.json'])
    expect(parseList('')).toEqual([])
  })
})

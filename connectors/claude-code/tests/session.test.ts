// Under `claude plugin test`: the adapter against one scripted BYOA app,
// through the engine's own dispatch. A credential is already on disk; the
// app hands out messages on its poll; the test fires Claude Code's turn
// events. What each test catches is named on it.
import { describe, expect, mock, test } from 'claude-code/testing'

const HOME = '/home/test'
const ORIGIN = 'http://127.0.0.1:4100'
const CRED_DIR = `${HOME}/.byoa/credentials/claude-code`
const TOKEN = 'tok-notes'
const TEXT = 'What changed today?'
const DISCOVERY = {
  byoa: '0.1',
  app: { id: 'notes', name: 'Notes', origin: ORIGIN },
  endpoints: { pair_start: '/byoa/pair/start', pair_poll: '/byoa/pair/poll', verification_uri: '/byoa/connect', revoke: '/byoa/revoke', sessions: '/byoa/sessions', mcp: '/mcp' },
  poll_hold_seconds: 20,
  accepts: { interrupt: true, stream: true, settings: ['model', 'effort'] },
}
const CREDENTIAL = {
  version: 1,
  origin: ORIGIN,
  app: { id: 'notes', name: 'Notes' },
  token: TOKEN,
  connection_id: 'conn_1',
  account: 'Ramos',
  discovery: DISCOVERY,
  saved_at: '2026-10-21T00:00:00Z',
}
const NOTE_TOOL = { name: 'add_note', description: 'Add a note. It shows in the app.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }

/** The provenance line the connector puts above the app's text. */
const line = (id: string) => `[BYOA] Notes (127.0.0.1:4100) · chat from Ramos · ${id}`
const turnText = (id: string, text = TEXT) => `${line(id)}\n${text}`
/** Claude Code's frame around a plugin's prompt; the adapter must not rely on it. */
const framed = (text: string) => `The byoa plugin sent a message:\n${text}\n\nThis is how Claude Code surfaces a prompt a plugin submits.`

function world(on: any) {
  const posted: any[] = []
  const registered: any[] = []
  const polls: any[] = []
  const mcpCalls: any[] = []
  const submitted: string[] = []
  const aborted: string[] = []
  const toolsRegistered: string[] = []
  const commandsRun: string[] = []
  const deliver: any[][] = []
  let held: Array<() => void> = []
  let hostSessionId = 'host-1'
  mock.env(on, { HOME })
  const clock = mock.clock(on, { now: 1_000_000 })
  const json = (status: number, body: unknown) => ({ value: { status, ok: status < 300, headers: { 'content-type': 'application/json' }, text: JSON.stringify(body) } })
  on('http.fetch', async ($: any, e: any) => {
    const path = new URL(e.url).pathname
    const body = e.init?.body ? JSON.parse(e.init.body) : null
    expect(e.init?.headers?.authorization).toBe(`Bearer ${TOKEN}`)
    if (path === '/byoa/sessions') {
      registered.push(body)
      return json(200, { session: { id: `ses_${body.host_session_id}` }, poll_hold_seconds: 20, minimum_connector_version: '0.1.0' })
    }
    if (path.endsWith('/poll')) {
      polls.push({ session: path.split('/')[3], ...body })
      // A newer poll answers the held one with nothing, as an app does.
      for (const release of held.splice(0)) release()
      const ready = deliver.shift()
      if (ready) return json(200, { commands: ready })
      let commands: any[] = []
      await new Promise<void>((resolve) => held.push(() => resolve()))
      commands = deliver.shift() ?? []
      return json(200, { commands })
    }
    if (path.endsWith('/events')) {
      posted.push(...body.events)
      return { value: { status: 204, ok: true, headers: {}, text: '' } }
    }
    if (path === '/mcp') {
      if (body.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: body.id, result: { tools: [NOTE_TOOL] } })
      if (body.method === 'tools/call') {
        mcpCalls.push(body.params)
        return json(200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `added: ${body.params.arguments.text}` }] } })
      }
    }
    return json(404, { error: 'not_found', error_description: path })
  })
  on('process.run', async ($: any, e: any) => {
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const [cmd, , script] = e.argv
    const arg = String(e.argv[4] ?? '')
    if (cmd === 'git') return e.argv.includes('get-url') ? out('https://x-access-token:secret@github.com/acme/northstar.git\n') : out('main\n')
    if (cmd !== '/bin/sh') return out('', 127)
    if (String(script).includes('hostname')) return out('test-host\n')
    if (String(script).includes('ls -1A')) return out(arg === CRED_DIR ? 'http_127.0.0.1_4100.json\n' : '')
    if (String(script).includes('stat -c %a')) return arg === `${CRED_DIR}/http_127.0.0.1_4100.json` ? out(`mode 600\n${JSON.stringify(CREDENTIAL)}`) : out('missing\n')
    return out('', 1)
  })
  on('session.version' as any, async () => ({ value: { version: '2.1.306' } }))
  on('session.id' as any, async () => ({ value: hostSessionId }))
  on('session.cwd' as any, async () => ({ value: '/home/test/northstar' }))
  on('command.list' as any, async () => ({ value: [{ name: 'model', description: '', source: 'builtin' }, { name: 'effort', description: '', source: 'builtin' }] }))
  on('command.register', async () => ({ value: { command: 'byoa' } }))
  on('command.run', async ($: any, e: any) => {
    commandsRun.push(`${e.command} ${e.args}`)
    return { text: '' }
  })
  on('tool.register' as any, async ($: any, e: any) => {
    toolsRegistered.push(e.name)
    return { value: { tool: `mcp__byoa__${e.name}` } }
  })
  on('ui.toast' as any, async () => ({ value: undefined }))
  on('ui.log' as any, async () => ({ value: undefined }))
  on('ui.render', async () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('prompt.submit', async ($: any, e: any) => {
    if (e.origin?.kind === 'plugin') submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.abort' as any, async ($: any, e: any) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  on('turn.start', async ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('session.start', async ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.end', async ($: any, e: any) => ({ sessionId: e.sessionId }))
  on('classic.Notification' as any, async () => ({}))
  // Core beneath the hooks: the permission check, then (allowed) the
  // registered tool, which core cannot run (permission.ts).
  const permission = { allow: true }
  on('tool.call', async ($: any, e: any) =>
    permission.allow
      ? { isError: true, result: `Error: byoa registered the tool ${e.tool.slice(11)} but no tool.call hook answered this call.`, text: `byoa registered the tool ${e.tool.slice(11)} but no tool.call hook answered this call.` }
      : { isError: true, result: `Error: Claude requested permissions to use ${e.tool}, but you haven't granted it yet.`, text: `Claude requested permissions to use ${e.tool}, but you haven't granted it yet.` },
  )

  // Each advance runs the plugin's tick; several let the requests a tick
  // started finish and the next ones go out.
  const settle = async (ticks = 4) => {
    for (let i = 0; i < ticks; i++) await clock.advance(1000)
  }
  const msg = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'message', message_id: id, kind: 'chat', from: { display_name: 'Ramos' }, text: TEXT, interrupt_first: false, stream: true, ...extra })
  const events = () => posted.map((p) => `${p.message_id}:${p.seq}:${p.type}${p.text ? `:${p.text}` : ''}${p.name ? `:${p.name}` : ''}${p.reason ? `:${p.reason}` : ''}`)
  const wake = () => {
    for (const release of held.splice(0)) release()
  }
  const switchTo = (id: string) => (hostSessionId = id)
  return { posted, registered, polls, mcpCalls, submitted, aborted, toolsRegistered, commandsRun, deliver, settle, msg, events, wake, switchTo, permission }
}

const complete = (turnId: string, extra: Record<string, unknown> = {}) => ({ turnId, answer: '', durationMs: 5, isAborted: false, reason: 'answer', ...extra }) as any
const start = ($: any) => $.session.start({ cwd: '/home/test/northstar', surface: 'terminal', isInteractive: true })

async function step($: any, turnId: string, index: number, extra: Record<string, unknown> = {}) {
  const stream = $.turn.step({ turnId, index, model: 'claude-test', messageCount: 1, ...extra })
  let s = await stream.next()
  while (s.done !== true) s = await stream.next()
}

describe('byoa session loop', () => {
  // Catches: a -p or SDK run registering, or reaching the network at all.
  test('not interactive: no command, no request', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: '/home/test/northstar', surface: null, isInteractive: false } as any)
    await w.settle()
    expect(w.registered).toEqual([])
    expect(w.polls).toEqual([])
  })

  // Catches: the app's text rewritten, the provenance line missing, the
  // path or a token in the remote leaving the machine, a turn never ending,
  // and anything but text and tool names streaming.
  test('idle: registers, submits the provenance line and the text, streams started, delta, tool, done', async ($, on) => {
    const w = world(on)
    on('turn.step', async function* ($: any, e: any) {
      yield { kind: 'thinking', index: 0, text: 'private' }
      yield { kind: 'text', index: 1, text: 'Two notes.' }
      yield { kind: 'tool', index: 2, id: 'toolu_1', name: 'Read' }
      yield { kind: 'input', index: 2, json: '{"file_path":"/secret"}' }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    w.deliver.push([w.msg('msg_1')])
    await start($)
    await w.settle()
    expect(w.registered.length).toBe(1)
    expect(w.registered[0].host).toBe('claude-code')
    expect(w.registered[0].host_session_id).toBe('host-1')
    expect(w.registered[0].workspace).toEqual({ folder_name: 'northstar', git_remote: 'github.com/acme/northstar' })
    expect(w.registered[0].capabilities.interrupt).toBe(true)
    expect(w.registered[0].capabilities.settings.map((s: any) => [s.id, s.value])).toEqual([['model', null], ['effort', null]])
    expect(w.submitted).toEqual([turnText('msg_1')])
    await $.turn.start({ text: framed(turnText('msg_1')), turnId: 't-ours' })
    await step($, 't-ours', 0)
    await $.turn.complete(complete('t-ours'))
    await w.settle()
    expect(w.events()).toEqual(['msg_1:0:started', 'msg_1:1:delta:Two notes.', 'msg_1:2:tool:Read', 'msg_1:3:done'])
    expect(JSON.stringify(w.posted)).not.toContain('secret')
    expect(JSON.stringify(w.posted)).not.toContain('private')
  })

  // Catches: submitting into a busy session (a pending $.prompt.submit
  // cannot be withdrawn), and the person's turn being claimed as ours.
  test("busy: a message is queued while the person's turn runs and starts after it", async ($, on) => {
    const w = world(on)
    await start($)
    await w.settle()
    await $.turn.start({ text: 'the person typed this', turnId: 't-person' })
    w.deliver.push([w.msg('msg_2')])
    w.wake()
    await w.settle()
    expect(w.submitted).toEqual([])
    expect(w.events()).toEqual(['msg_2:0:queued'])
    expect(w.polls.some((p) => p.state === 'busy')).toBe(true)
    await $.turn.complete(complete('t-person'))
    await w.settle()
    expect(w.submitted).toEqual([turnText('msg_2')])
    expect(w.events()).toEqual(['msg_2:0:queued', 'msg_2:1:started'])
  })

  // Catches: a subagent making the session busy forever, or its steps
  // streaming to the app.
  test("a subagent's steps and end neither stream nor end the main turn", async ($, on) => {
    const w = world(on)
    on('turn.step', async function* ($: any, e: any) {
      yield { kind: 'text', index: 0, text: e.agentId ? 'subagent text' : 'main text' }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    w.deliver.push([w.msg('msg_3')])
    await start($)
    await w.settle()
    await $.turn.start({ text: framed(turnText('msg_3')), turnId: 't-ours' })
    await step($, 't-sub', 0, { agentId: 'agent-1' })
    await $.turn.complete(complete('t-sub', { agentId: 'agent-1' }))
    await step($, 't-ours', 0)
    await w.settle()
    expect(w.events()).toEqual(['msg_3:0:started', 'msg_3:1:delta:main text'])
    expect(w.polls.at(-1).state).toBe('busy')
    await $.turn.complete(complete('t-ours'))
    await w.settle()
    expect(w.events()).toEqual(['msg_3:0:started', 'msg_3:1:delta:main text', 'msg_3:2:done'])
    expect(w.polls.at(-1).state).toBe('ready')
  })

  // Catches: the answer to what the PERSON typed into an app's turn
  // streaming to the app (Workspaces review B1).
  test('a prompt typed into our turn: nothing more streams, and it ends interrupted, taken_over', async ($, on) => {
    const w = world(on)
    const chunks: Record<number, any[]> = {
      0: [{ kind: 'text', index: 0, text: 'our answer ' }],
      1: [{ kind: 'text', index: 0, text: 'the answer to what the person typed' }],
    }
    on('turn.step', async function* ($: any, e: any) {
      for (const c of chunks[e.index] ?? []) yield c
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    w.deliver.push([w.msg('msg_4')])
    await start($)
    await w.settle()
    await $.turn.start({ text: framed(turnText('msg_4')), turnId: 't-ours' })
    await step($, 't-ours', 0)
    await ($ as any).prompt.submit({ text: 'also check billing', turnId: 't-ours', origin: { kind: 'composer' }, wait: false })
    await step($, 't-ours', 1)
    await $.turn.complete(complete('t-ours'))
    await w.settle()
    expect(w.events()).toEqual(['msg_4:0:started', 'msg_4:1:delta:our answer ', 'msg_4:2:interrupted:taken_over'])
  })

  // Catches: text written after the person's Enter reaching the app, and
  // the finished answer lost when the turn ends before the typed prompt
  // could join it (Workspaces finding 2).
  test('a prompt typed during the last step: nothing after the Enter streams, and the turn ends done', async ($, on) => {
    const w = world(on)
    const gate: { open: () => void } = { open: () => undefined }
    const opened = new Promise<void>((r) => (gate.open = r))
    on('turn.step', async function* ($: any, e: any) {
      yield { kind: 'text', index: 0, text: 'our answer ' }
      await opened
      yield { kind: 'text', index: 0, text: 'written after the Enter' }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    w.deliver.push([w.msg('msg_12')])
    await start($)
    await w.settle()
    await $.turn.start({ text: framed(turnText('msg_12')), turnId: 't-ours' })
    const running = step($, 't-ours', 0)
    await w.settle(1)
    await ($ as any).prompt.submit({ text: 'PERSONAL also check billing', turnId: 't-ours', origin: { kind: 'composer' }, wait: false })
    gate.open()
    await running
    await $.turn.complete(complete('t-ours'))
    await $.turn.start({ text: 'PERSONAL also check billing', turnId: 't-person' })
    await $.turn.complete(complete('t-person'))
    await w.settle()
    expect(w.events()).toEqual(['msg_12:0:started', 'msg_12:1:delta:our answer ', 'msg_12:2:done'])
  })

  // Catches: a background task reporting back ending our turn for no
  // visible reason (Workspaces finding 3).
  test("a background task's notification in our turn does not take it over", async ($, on) => {
    const w = world(on)
    const chunks: Record<number, any[]> = { 0: [{ kind: 'text', index: 0, text: 'started a build ' }], 1: [{ kind: 'text', index: 0, text: 'and it passed' }] }
    on('turn.step', async function* ($: any, e: any) {
      for (const c of chunks[e.index] ?? []) yield c
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    w.deliver.push([w.msg('msg_5')])
    await start($)
    await w.settle()
    await $.turn.start({ text: framed(turnText('msg_5')), turnId: 't-ours' })
    await step($, 't-ours', 0)
    await ($ as any).prompt.submit({ text: '<task-notification>done</task-notification>', turnId: 't-ours', origin: { kind: 'task-notification' }, wait: false })
    await step($, 't-ours', 1)
    await $.turn.complete(complete('t-ours'))
    await w.settle()
    expect(w.events()).toEqual(['msg_5:0:started', 'msg_5:1:delta:started a build ', 'msg_5:2:delta:and it passed', 'msg_5:3:done'])
  })

  // Catches: Stop aborting anything but our own running turn, or aborting
  // from inside a hook instead of the tick.
  test('interrupt aborts only our running turn, by its id, and ends it interrupted', async ($, on) => {
    const w = world(on)
    w.deliver.push([w.msg('msg_6')])
    await start($)
    await w.settle()
    await $.turn.start({ text: framed(turnText('msg_6')), turnId: 't-ours' })
    w.deliver.push([{ type: 'interrupt', message_id: 'msg_6' }])
    w.wake()
    await w.settle()
    expect(w.aborted).toEqual(['t-ours'])
    await $.turn.complete(complete('t-ours', { isAborted: true, reason: 'aborted' }))
    await w.settle()
    expect(w.events()).toEqual(['msg_6:0:started', 'msg_6:1:interrupted:stopped'])
  })

  // Catches: an interrupt stopping the person's own turn.
  test("an interrupt for a held message withdraws it and never aborts the person's turn", async ($, on) => {
    const w = world(on)
    await start($)
    await w.settle()
    await $.turn.start({ text: 'the person typed this', turnId: 't-person' })
    w.deliver.push([w.msg('msg_7')])
    w.wake()
    await w.settle()
    w.deliver.push([{ type: 'interrupt', message_id: 'msg_7' }])
    w.wake()
    await w.settle()
    expect(w.aborted).toEqual([])
    expect(w.events()).toEqual(['msg_7:0:queued', 'msg_7:1:withdrawn'])
  })

  // Catches: a paste of our text claimed as our turn, and a turn that
  // carries another party's prompt beside ours streamed.
  test("someone else's paste of our text is not claimed; a turn that merges ours with theirs ends taken_over", async ($, on) => {
    const w = world(on)
    w.deliver.push([w.msg('msg_8')])
    await start($)
    await w.settle()
    const paste = `look at this: ${turnText('msg_8')}`
    await ($ as any).prompt.submit({ text: paste, origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: paste, turnId: 't-paste' })
    await $.turn.complete(complete('t-paste'))
    expect(w.events()).toEqual(['msg_8:0:started'])
    await ($ as any).prompt.submit({ text: 'PERSONAL note', origin: { kind: 'composer' }, wait: false })
    await $.turn.start({ text: `${framed(turnText('msg_8'))}\nPERSONAL note`, turnId: 't-merged' })
    await w.settle()
    expect(w.events()).toEqual(['msg_8:0:started', 'msg_8:1:interrupted:taken_over'])
  })

  // Catches: a permission prompt not reaching the app as `blocked`.
  test('a permission prompt in a running turn polls blocked', async ($, on) => {
    const w = world(on)
    await start($)
    await w.settle()
    await $.turn.start({ text: 'the person typed this', turnId: 't-person' })
    await ($ as any).classic.Notification({ notification_type: 'permission_prompt', message: 'Claude needs your permission', hook_event_name: 'Notification', session_id: 'host-1', transcript_path: '', cwd: '/' })
    await w.settle()
    expect(w.polls.at(-1)).toMatchObject({ state: 'blocked', cause: 'permission' })
  })

  // Catches: /clear (a new id, no session.start) leaving the old session
  // registered, a held message submitted into the new conversation, and the
  // tools not registered for the new session.
  test('/clear: the old session ends its messages, the new id registers again with its tools', async ($, on) => {
    const w = world(on)
    await start($)
    await w.settle()
    expect(w.toolsRegistered).toEqual(['notes'])
    await $.turn.start({ text: 'the person typed this', turnId: 't-person' })
    w.deliver.push([w.msg('msg_9')])
    w.wake()
    await w.settle()
    await $.turn.complete(complete('t-person'))
    await $.session.end({ reason: 'clear', sessionId: 'host-1', resume: {} } as any)
    w.switchTo('host-2')
    await w.settle()
    expect(w.registered.map((r) => r.host_session_id)).toEqual(['host-1', 'host-2'])
    expect(w.events()).toEqual(['msg_9:0:queued', 'msg_9:1:withdrawn:session_ended'])
    expect(w.submitted).toEqual([])
    expect(w.toolsRegistered).toEqual(['notes', 'notes'])
  })

  // Catches: the proxied tool not reaching the app's MCP, the token sent
  // anywhere else, the call not tied to its session and message.
  test("the proxied tool calls the app's MCP with the session and message ids", async ($, on) => {
    const w = world(on)
    w.deliver.push([w.msg('msg_10')])
    await start($)
    await w.settle()
    await $.turn.start({ text: framed(turnText('msg_10')), turnId: 't-ours' })
    const out = await $.tool.call({ tool: 'mcp__byoa__notes', action: 'add_note', text: 'hello' } as any)
    expect(out).toMatchObject({ result: 'added: hello' })
    expect(w.mcpCalls[0].name).toBe('add_note')
    expect(w.mcpCalls[0].arguments).toEqual({ text: 'hello' })
    expect(w.mcpCalls[0]._meta).toEqual({ 'dev.byoa/session': 'ses_host-1', 'dev.byoa/wakes': true, 'dev.byoa/message': 'msg_10' })
    const gone = await $.tool.call({ tool: 'mcp__byoa__tasks', action: 'x' } as any)
    expect(String((gone as any).deny)).toContain('not connected')
  })

  // Catches: a proxied tool answered without the person's permission rules
  // and prompt (SPEC 9.4), which a hook that never calls next(e) does.
  test('a call the permission check refuses never reaches the app', async ($, on) => {
    const w = world(on)
    w.permission.allow = false
    await start($)
    await w.settle()
    const out = await $.tool.call({ tool: 'mcp__byoa__notes', action: 'add_note', text: 'hello' } as any)
    expect(String((out as any).text)).toContain("haven't granted it yet")
    expect(w.mcpCalls).toEqual([])
  })

  // Catches: a setting applied any other way than the host's own command,
  // or a value claimed that is not known.
  test('set: /model runs before the turn, and the value is reported after', async ($, on) => {
    const w = world(on)
    w.deliver.push([w.msg('msg_11', { set: { model: 'haiku' } })])
    await start($)
    await w.settle()
    expect(w.commandsRun).toEqual(['model haiku'])
    expect(w.submitted).toEqual([turnText('msg_11')])
    expect(w.polls.at(-1).settings.find((s: any) => s.id === 'model').value).toBe('haiku')
  })

  // Catches: /byoa not answered, or the band not drawn.
  test('/byoa status names the app and this session; the band shows the connected apps', async ($, on) => {
    const w = world(on)
    await start($)
    await w.settle()
    const answer = await $.command.run({ command: 'byoa', args: 'status' } as any)
    expect(answer.text).toContain('Notes (http://127.0.0.1:4100) · connected as Ramos · this session: registered')
    const ui = await ($ as any).ui.mount({ plugin: 'byoa', component: 'AbovePrompt', requestId: 'AbovePrompt', surface: 'terminal', viewport: { columns: 100, rows: 30 }, props: { hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 100, scroll: { offset: 0, bodyRows: 5 }, view: {} } })
    expect(await ui.find({ type: 'Text', text: 'BYOA · Notes' })).toBeDefined()
  })
})

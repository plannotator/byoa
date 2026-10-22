// byoa: the Claude Code adapter of the BYOA connector, a hooks module. The
// host-free core is ./core (a copy of packages/connector-core and
// packages/protocol made by scripts/sync-core.mjs: a mod imports only its own
// files). This file supplies the core's ports, reports Claude Code's turn
// events to it, and does what it asks. Every `$` call is here, because
// `claude plugin validate` follows `$` only within this file.
//
// Host rules (each came from a review of an earlier connector):
//   - Interactive sessions only (`isInteractive`). A -p run or an SDK host
//     gets nothing: no command, no tool, no request.
//   - Credentials live in ~/.byoa, written by a `/bin/sh` child under
//     `umask 077` (shell.ts), never in `$.store`, which is a 0644 file.
//   - All background work runs from one `$.clock.every` tick. Hooks only
//     record what happened and hand it to the core; no hook starts work of
//     its own that outlives it. `$.turn.abort` waits for the tick too, so it
//     never runs inside the `turn.start` hook that asked for it.
//   - The host session id is read again at every tick and every
//     `turn.start`: `/clear` and resume change it with no `session.start`.
//     A new id gets a new attached session (its apps register again, its
//     tools are the apps connected now); the old one is detached, so its
//     messages end and nothing is submitted into the new conversation.
//   - Busy comes from main-loop `turn.start` and `turn.complete` only. A
//     subagent raises no `turn.start`, and its `turn.complete` and steps
//     carry `agentId`; those never count.
//   - A turn is submitted with `$.prompt.submit({ text })`, never `asUser`,
//     and only `$.turn.abort` of OUR running turn stops one. This file never
//     answers a permission prompt and never hooks the permission check. A
//     proxied tool call goes through that check like any tool (permission.ts).
//   - Only our own turn streams: its visible text chunks and tool names,
//     never thinking, tool input or output, or a subagent's steps. Which turn
//     is ours, and which prompts take it over, is turns-match.ts.
//   - A prompt someone else submits into our running turn is announced at
//     Enter (`prompt.submit` with our turn's id) and reaches the model at the
//     turn's next step. From the Enter nothing more streams; at that next
//     main-loop step the message ends `interrupted` (`taken_over`). If the
//     turn ends first, it ends `done` with what streamed before the Enter.
//
// What the Claude Code API cannot do, and how this file lives with it:
//   - `$.http.fetch` follows redirects and has no switch to stop it. On a
//     redirect to another origin it drops `Authorization`, so the token does
//     not follow; the answer's final URL is not reported, so the core cannot
//     check it.
//   - No hook says which choice a bare /model picker made, so a setting's
//     value is null unless this plugin set it or the person typed it.
//   - A tool registered once stays registered for the process. A tool of an
//     app that is gone is answered with a refusal.
//   - A hook that answers a registered tool skips the permission check, and
//     no call asks for the real prompt; permission.ts reads the outcome of
//     `next(e)` from core's answer instead.

import type { EngineInterface, Register } from 'claude-code'

import { COMMAND, Connector, type Display, type FilePort, type HostSession, type HttpPort, type ProxiedTool, type SessionHandle } from './core/connector/index.ts'
import type { Workspace } from './core/protocol/index.ts'
import { allowedByHost } from './permission.ts'
import { isSettingId, sessionSettings, valueTyped, type SettingId } from './settings.ts'
import { SHELL_INIT, hostnameArgv, listArgv, parseList, parseRead, readArgv, removeArgv, writeArgv } from './shell.ts'
import { PLUGIN_NAME, isOwnSubmit, matchTurn, takesOver } from './turns-match.ts'
import { folderName, gitBranchArgv, gitRemoteArgv, remoteLabel } from './workspace.ts'

const TICK_MS = 1_000
/** The prefix Claude Code gives every tool this plugin registers. */
const TOOL_PREFIX = `mcp__${PLUGIN_NAME}__`
/** Prompts of other parties a waiting message remembers, to keep them out of
 * the turn it claims. Plumbing: a person types a few at most in the moment
 * between our submit and our turn's start. */
const FOREIGN_REMEMBERED = 16

// ── state: one Claude Code process ────────────────────────────────────────

let connector: Connector | null = null
/** The attached session for the host session id `sessionKey`. */
let handle: SessionHandle | null = null
let sessionKey: string | null = null
/** Ids that ended (`session.end`). Right after a /clear the engine may still
 * answer the old id for a moment; it must not be attached again. */
const ended = new Set<string>()
/** The main-loop turn running now, anyone's. */
let running: string | null = null
/** A permission prompt is on screen, until the turn moves on. */
let blocked = false
/** Our submitted text, its turn not started yet, with the prompts of other
 * parties seen since. */
let pending: { text: string; foreign: string[] } | null = null
/** Our running turn; `announced` once another party's prompt entered it. */
let ours: { turnId: string; announced: boolean } | null = null
let abortWanted = false
/** The proxied tools of `handle`, by the full name Claude calls. */
const tools = new Map<string, ProxiedTool>()
let toolsFor: SessionHandle | null = null
/** The commands this Claude Code has among the settings, and their values. */
const settingCommands = new Set<string>()
const settingValues: Partial<Record<SettingId, string | null>> = {}
let band: string | null = null
let bandShown: string | null = null
const toasts: string[] = []
/** The core's clock: `$.clock.now()` at the last tick, plus the real time
 * since. Driven by `$.clock`, so the test kit's mocked clock drives it. */
let clockAt = 0
let clockReal = 0
let ticking = false

const now = () => clockAt + (Date.now() - clockReal)

function display(d: Display): void {
  band = d.band
  if (d.toast) toasts.push(d.toast.text)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── ports ──────────────────────────────────────────────────────────────────

function claudeFiles($: EngineInterface): FilePort {
  return {
    async read(path) {
      const r = await $.process.run(readArgv(path), SHELL_INIT)
      if (r.exitCode !== 0) throw new Error(`could not read ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
      return parseRead(r.stdout)
    },
    async writePrivate(path, text) {
      const r = await $.process.run(writeArgv(path), { ...SHELL_INIT, stdin: text })
      if (r.exitCode !== 0) throw new Error(`could not write ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
    },
    async remove(path) {
      const r = await $.process.run(removeArgv(path), SHELL_INIT)
      if (r.exitCode !== 0) throw new Error(`could not remove ${path}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
    },
    async list(dir) {
      const r = await $.process.run(listArgv(dir), SHELL_INIT)
      if (r.exitCode !== 0) throw new Error(`could not list ${dir}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
      return parseList(r.stdout)
    },
  }
}

function claudeHttp($: EngineInterface): HttpPort {
  return async (req) => {
    const res = await $.http.fetch(req.url, { method: req.method, headers: req.headers, ...(req.body !== undefined ? { body: req.body } : {}) })
    return { status: res.status, text: res.text, headers: res.headers }
  }
}

/** One host session id, as the core sees it. */
function claudeSession($: EngineInterface, id: string): HostSession {
  let workspace: Promise<Workspace> | null = null
  return {
    hostSessionId: () => id,
    workspace: () => (workspace ??= readWorkspace($)),
    busy: () => running !== null,
    blocked: () => blocked,
    async submit(text) {
      // Only into the conversation this session stands for.
      if (id !== sessionKey) throw new Error('the session was cleared or replaced')
      pending = { text, foreign: [] }
      // Resolves once the turn started (or was queued behind a prompt the
      // person typed at the same moment).
      const r = (await $.prompt.submit({ text })) as { drop?: unknown } | undefined
      if (typeof r?.drop === 'string') {
        if (pending?.text === text) pending = null
        throw new Error(r.drop)
      }
    },
    async abort() {
      abortWanted = true
    },
    settings: () => sessionSettings(settingCommands, settingValues),
    async applySetting(setting, value) {
      if (!isSettingId(setting)) throw new Error(`this session has no setting ${setting}`)
      await $.command.run({ command: setting, args: value })
      settingValues[setting] = value
    },
  }
}

async function readWorkspace($: EngineInterface): Promise<Workspace> {
  const cwd = String(await $.session.cwd())
  const [remote, branch] = await Promise.all([gitLine($, gitRemoteArgv(cwd)), gitLine($, gitBranchArgv(cwd))])
  const label = remote === null ? null : remoteLabel(remote)
  return { folder_name: folderName(cwd), path: cwd, ...(label !== null ? { git_remote: label } : {}), ...(branch !== null ? { branch } : {}) }
}

async function gitLine($: EngineInterface, argv: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(argv, { cwd: '/', timeoutMs: 5_000 })
    return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : null
  } catch {
    return null
  }
}

async function readMachineName($: EngineInterface): Promise<string | undefined> {
  try {
    const r = await $.process.run(hostnameArgv(), SHELL_INIT)
    return r.exitCode === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

// ── the tick ───────────────────────────────────────────────────────────────

/** The attached session goes: its messages end, its tools stop answering. */
function leave(): void {
  handle?.detach()
  handle = null
  sessionKey = null
  pending = null
  ours = null
  abortWanted = false
  blocked = false
  tools.clear()
  toolsFor = null
}

async function tick($: EngineInterface): Promise<void> {
  if (ticking || connector === null) return
  ticking = true
  try {
    clockAt = await $.clock.now()
    clockReal = Date.now()
    const id = await $.session.id()
    if (id !== sessionKey && !ended.has(id)) {
      leave()
      sessionKey = id
      handle = connector.attach(claudeSession($, id))
    }
    if (abortWanted) {
      abortWanted = false
      const turnId = ours !== null && running === ours.turnId ? ours.turnId : null
      if (turnId !== null) await $.turn.abort({ turnId }).catch((error: unknown) => $.ui.toast(`BYOA: could not stop the turn (${errorText(error)}).`))
    }
    await connector.tick()
    if (handle !== null && toolsFor !== handle) registerTools($, handle)
    flush($)
  } catch (error) {
    $.ui.log(`BYOA: ${errorText(error)}`, { to: 'debug' })
  } finally {
    ticking = false
  }
}

/** Registers the session's proxied tools, one per app, once. They are built
 * from the apps connected when the session attached and stay fixed for it.
 * Started by the tick, not awaited: listing a slow app's tools must not hold
 * the tick. */
function registerTools($: EngineInterface, h: SessionHandle): void {
  toolsFor = h
  h.tools()
    .then(async (list) => {
      for (const tool of list) {
        if (handle !== h) return
        const r = await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })
        if (handle === h) tools.set(typeof r?.tool === 'string' ? r.tool : `${TOOL_PREFIX}${tool.name}`, tool)
      }
    })
    .catch((error: unknown) => $.ui.toast(`BYOA: the apps' tools are not available in this session (${errorText(error)}).`))
}

/** Draws what the core asked to show since the last time. */
function flush($: EngineInterface): void {
  if (band !== bandShown) {
    bandShown = band
    $.ui.invalidate('ui.render')
  }
  for (const text of toasts.splice(0)) $.ui.toast(text)
}

// ── hooks ──────────────────────────────────────────────────────────────────

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    if (!e.isInteractive || connector !== null) return result
    const home = await $.env.get('HOME')
    if (!home) {
      $.ui.toast('BYOA: HOME is not set, so there is nowhere to keep credentials.')
      return result
    }
    for (const command of await $.command.list().catch(() => [])) if (isSettingId(command.name)) settingCommands.add(command.name)
    const hostVersion = (await $.session.version().catch(() => null))?.version
    const machineName = await readMachineName($)
    clockAt = await $.clock.now()
    clockReal = Date.now()
    const c = new Connector({
      host: { host: 'claude-code', hostVersion, machineName, isInteractive: () => true, display },
      http: claudeHttp($),
      files: claudeFiles($),
      now,
      home,
    })
    // Reads the credential files only; the first tick attaches the session.
    await c.start()
    connector = c
    $.clock.every(TICK_MS, () => tick($))
    await $.command.register({
      name: 'byoa',
      description: 'BYOA: connect this agent to web apps',
      argumentHint: 'connect <address> | disconnect <app> | status',
      immediate: true,
    })
    return result
  })

  on('session.end', async ($, e, next) => {
    if (sessionKey !== null && e.sessionId === sessionKey) {
      ended.add(sessionKey)
      leave()
      running = null
    }
    return next(e)
  })

  on('command.run', { command: 'byoa' }, async ($, e) => {
    if (connector === null) return { text: `BYOA: ${COMMAND} works in an interactive session only.` }
    try {
      const text = await connector.command(e.args)
      flush($)
      return { text }
    } catch (error) {
      return { text: `BYOA: ${errorText(error)}` }
    }
  })

  // The person's own /model or /effort: what it leaves in force, if this
  // plugin can tell. Observed only.
  on('command.run', { command: ['model', 'effort'] }, async ($, e, next) => {
    if (!isOwnSubmit(e.origin) && isSettingId(e.command)) settingValues[e.command] = valueTyped(e.command, e.args)
    return next(e)
  })

  // A proxied tool: the person's permission rules and prompt first (inside
  // next(e), permission.ts), then the app's MCP, with the session's token.
  on('tool.call', { tool: /^mcp__byoa__/ }, async ($, e, next) => {
    const tool = tools.get(e.tool)
    if (tool === undefined) return { deny: `BYOA: ${e.tool} is not connected in this session. An app connected mid-session brings its tool to the next session (after /clear).` }
    const checked = await next(e)
    if (!allowedByHost(checked)) return checked
    const { tool: _tool, tool_use_id: _id, agentId: _agent, consent: _consent, ...input } = e as Record<string, unknown>
    const out = await tool.call(input)
    return out.isError ? { deny: out.text } : { result: out.text }
  }).catch(async ($, e, next) => (next.called ? next(e) : { deny: `BYOA: the call failed in the connector (${next.error?.kind ?? 'error'}).` }))

  // Every prompt this hook sees that is not stamped as this plugin's own is
  // another party's (turns-match.ts).
  on('prompt.submit', async ($, e, next) => {
    if (handle !== null && !isOwnSubmit(e.origin)) {
      if (ours !== null) {
        // Into our running turn: silenced from now; taken over at its next step.
        if (e.turnId === ours.turnId && takesOver(e.origin) && !ours.announced) {
          ours.announced = true
          handle.foreignPrompt()
        }
      } else {
        if (pending !== null && e.text.length > 0) {
          pending.foreign.push(e.text)
          if (pending.foreign.length > FOREIGN_REMEMBERED) pending.foreign.shift()
        }
        // The person's prompt goes before a held message.
        handle.foreignPrompt()
      }
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    // A /clear or resume the tick has not seen yet: this turn is not the
    // attached session's.
    if ((await $.session.id()) !== sessionKey) leave()
    running = e.turnId
    blocked = false
    if (handle !== null) {
      const verdict = pending === null ? 'other' : matchTurn(e.text, pending.text, pending.foreign)
      // The core matches by "contains"; a turn the stricter rule calls
      // someone else's (a paste of our text) is reported without its text,
      // so the core cannot claim it.
      if (handle.turnStarted(verdict === 'other' ? '' : e.text)) {
        pending = null
        ours = { turnId: e.turnId, announced: false }
        if (verdict === 'merged') {
          ours = null
          handle.takenOver()
        }
      }
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const main = e.agentId === undefined
    if (main) blocked = false
    // The step after another party's prompt entered our turn carries it.
    if (main && ours !== null && ours.turnId === e.turnId && ours.announced) {
      ours = null
      handle?.takenOver()
    }
    const mine = main && ours !== null && ours.turnId === e.turnId ? handle : null
    if (mine === null) return yield* next(e)
    const stream = next(e)
    let step = await stream.next()
    while (!step.done) {
      const chunk = step.value
      if (chunk.kind === 'text') mine.delta(chunk.text)
      else if (chunk.kind === 'tool') mine.tool(chunk.name)
      yield chunk
      step = await stream.next()
    }
    return step.value
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      if (running === e.turnId) running = null
      blocked = false
      if (ours !== null && ours.turnId === e.turnId) {
        const { announced } = ours
        ours = null
        // Aborted after another party's prompt was announced (Claude Code's
        // send-now interrupts the turn to deliver it): taken over.
        if (e.isAborted) announced ? handle?.takenOver() : handle?.turnEnded('interrupted')
        else if (e.reason === 'error' || e.reason === 'refusal') handle?.turnEnded('error', 'turn_failed')
        else handle?.turnEnded('done')
      }
    }
    return next(e)
  })

  // A permission prompt on screen: Claude Code raises its Notification
  // (`permission_prompt`) while the prompt waits on the person. Observed only.
  on('classic.Notification', async ($, e, next) => {
    if (e.notification_type === 'permission_prompt' && running !== null) blocked = true
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (bandShown === null) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const rest = await next(e)
    const mine = Text({ dimColor: true, children: [bandShown] })
    return Box({ flexDirection: 'column', children: rest ? [mine, rest] : [mine] })
  })
}

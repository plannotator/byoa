// The settings an app may set before a turn (SPEC 5.3 `set`): the model and
// the effort, applied through Claude Code's own /model and /effort commands
// (Machine's way). Pure.
//   - Offered only when this Claude Code has the command.
//   - `value` is what is known to be in force: what this plugin last applied,
//     or what the person typed after /model or /effort themselves. It is
//     null when unknown (a bare /model opens a picker whose choice no hook
//     sees), because SPEC 5.1 says null rather than a guess.

import type { SessionSetting, SettingChoice } from './core/protocol/index.ts'

/** `value` is what an app's `set` sends and what /model or /effort takes;
 * `name` is what the app's picker shows. */
export const SETTINGS: ReadonlyArray<{ id: 'model' | 'effort'; name: string; choices: readonly SettingChoice[] }> = [
  {
    id: 'model',
    name: 'Model',
    choices: [
      { value: 'default', name: 'Default' },
      { value: 'opus', name: 'Opus' },
      { value: 'sonnet', name: 'Sonnet' },
      { value: 'haiku', name: 'Haiku' },
    ],
  },
  {
    id: 'effort',
    name: 'Effort',
    choices: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'Extra high' },
      { value: 'max', name: 'Max' },
    ],
  },
]

export type SettingId = (typeof SETTINGS)[number]['id']

export function isSettingId(command: string): command is SettingId {
  return SETTINGS.some((s) => s.id === command)
}

/** The settings this session offers, given the commands it has. */
export function sessionSettings(commands: ReadonlySet<string>, values: Readonly<Partial<Record<SettingId, string | null>>>): SessionSetting[] {
  return SETTINGS.filter((s) => commands.has(s.id)).map((s) => ({ id: s.id, name: s.name, value: values[s.id] ?? null, choices: s.choices.map((c) => ({ ...c })) }))
}

/** What the person's own `/model <args>` or `/effort <args>` leaves in force,
 * as far as this plugin can tell: one of the choices, else unknown. */
export function valueTyped(id: SettingId, args: string): string | null {
  const word = args.trim().toLowerCase()
  const setting = SETTINGS.find((s) => s.id === id)
  return setting !== undefined && setting.choices.some((c) => c.value === word) ? word : null
}

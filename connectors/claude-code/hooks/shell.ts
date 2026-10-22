// The adapter's shell-outs, in one place so a Node test runs them as they are
// (tests/node/shell.test.mjs). A mod has no file system call that sets a
// mode, and `$.store` is a 0644 file, so the credential files under ~/.byoa
// are read, written, listed and removed by `/bin/sh` children (forked from
// Workspaces' shell.ts).
//
// None of them resolves a tool from PATH or from the project folder: each
// script sets PATH to the system folders, moves to `/`, and calls every tool
// by its absolute path. The child also gets a fixed PATH and `/` as its
// working folder from the call site (SHELL_INIT). A token never rides a
// command line: the write takes the text on stdin.

/** Every file shell-out: `/` as the working folder (never the project) and a
 * fixed minimal PATH over the host's environment. */
export const SHELL_INIT = { cwd: '/', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', ENV: '', BASH_ENV: '', CDPATH: '' } }

const PRELUDE = ['PATH=/usr/bin:/bin', 'export PATH', 'cd / || exit 1']

// The file's permission bits, a newline, then its text, in one child; or
// "missing". GNU stat first: BSD `stat -f` means something else on Linux.
export const READ_SCRIPT = [
  ...PRELUDE,
  'if [ ! -e "$1" ]; then echo missing; exit 0; fi',
  'm=$(/usr/bin/stat -c %a "$1" 2>/dev/null || /usr/bin/stat -f %Lp "$1") || exit 1',
  'printf "mode %s\\n" "$m"',
  '/bin/cat "$1"',
].join('\n')

// stdin to the file: folder 0700 (made, or set if it existed), file created
// 0600 by the umask so it is never readable by others, under a temporary name
// that must not exist yet (noclobber), then renamed over the target.
export const WRITE_SCRIPT = [
  ...PRELUDE,
  'umask 077',
  'set -C',
  'd=$(/usr/bin/dirname "$1")',
  '/bin/mkdir -p "$d" && /bin/chmod 700 "$d" || exit 1',
  't="$1.$$.tmp"',
  'if /bin/cat > "$t" && /bin/chmod 600 "$t" && /bin/mv -f "$t" "$1"; then exit 0; fi',
  '/bin/rm -f "$t"',
  'exit 1',
].join('\n')

// One name per line; nothing when the folder does not exist.
export const LIST_SCRIPT = [...PRELUDE, 'if [ ! -d "$1" ]; then exit 0; fi', 'cd "$1" || exit 1', 'exec /bin/ls -1A'].join('\n')

export const HOSTNAME_SCRIPT = [
  ...PRELUDE,
  'if [ -x /bin/hostname ]; then exec /bin/hostname; fi',
  'if [ -x /usr/bin/hostname ]; then exec /usr/bin/hostname; fi',
  'exec /usr/bin/uname -n',
].join('\n')

export const readArgv = (path: string) => ['/bin/sh', '-c', READ_SCRIPT, 'sh', path]
export const writeArgv = (path: string) => ['/bin/sh', '-c', WRITE_SCRIPT, 'sh', path]
export const listArgv = (dir: string) => ['/bin/sh', '-c', LIST_SCRIPT, 'sh', dir]
export const removeArgv = (path: string) => ['/bin/rm', '-f', '--', path]
export const hostnameArgv = () => ['/bin/sh', '-c', HOSTNAME_SCRIPT]

/** The read script's output: null when the file does not exist. */
export function parseRead(stdout: string): { text: string; mode: number } | null {
  if (stdout === 'missing\n') return null
  const nl = stdout.indexOf('\n')
  const mode = /^mode ([0-7]{3,4})$/.exec(nl < 0 ? stdout : stdout.slice(0, nl))
  if (!mode?.[1]) throw new Error('could not read the file mode')
  return { mode: parseInt(mode[1], 8), text: stdout.slice(nl + 1) }
}

/** The list script's output as names. */
export function parseList(stdout: string): string[] {
  return stdout.split('\n').filter((name) => name !== '')
}

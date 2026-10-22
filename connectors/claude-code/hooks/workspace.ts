// What the session tells an app about its folder (SPEC 5.1 `workspace`), from
// facts the adapter reads with git. Pure. The person's sharing setting
// (~/.byoa/policy.json) filters these per app in the core; this file only
// shapes them.
//   - `git_remote` is `host/path`, the form SPEC 5.1 shows: no scheme, no
//     `.git`, and never the user or password part, because a remote URL can
//     carry a token (`https://x-access-token:…@github.com/…`).

/** The git argv for the origin remote and for the branch, run in `cwd`. */
export const gitRemoteArgv = (cwd: string) => ['git', '-C', cwd, 'remote', 'get-url', 'origin']
export const gitBranchArgv = (cwd: string) => ['git', '-C', cwd, 'branch', '--show-current']

export function folderName(path: string): string {
  const parts = path.split('/').filter((p) => p !== '')
  return parts[parts.length - 1] ?? '/'
}

/** `git@github.com:acme/app.git`, `https://tok@github.com/acme/app.git` and
 * `ssh://git@github.com:22/acme/app` all become `github.com/acme/app`. A
 * local path or anything unreadable gives null: nothing is sent. */
export function remoteLabel(raw: string): string | null {
  const url = raw.trim()
  if (url === '' || /[\s\u0000-\u001f]/.test(url)) return null
  let host: string
  let path: string
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url)
  if (scheme !== null) {
    if (scheme[1]?.toLowerCase() === 'file') return null
    const rest = scheme[2] ?? ''
    const slash = rest.indexOf('/')
    const authority = slash < 0 ? rest : rest.slice(0, slash)
    path = slash < 0 ? '' : rest.slice(slash + 1)
    host = authority.slice(authority.lastIndexOf('@') + 1).replace(/:\d*$/, '')
  } else {
    // scp-like: [user@]host:path
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url)
    if (scp === null) return null
    host = scp[1] ?? ''
    path = scp[2] ?? ''
  }
  path = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '')
  if (host === '' || path === '') return null
  return `${host.toLowerCase()}/${path}`
}

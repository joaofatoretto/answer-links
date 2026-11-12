// Finding the files, folders and links an answer names. Pure: no `$`.

/** A URL or path-like token, and where it stands in the text: `[at, end)`. */
export type Candidate =
  | { kind: 'url'; url: string; at: number; end: number }
  | { kind: 'path'; path: string; line?: number; at: number; end: number; isFileUrl?: true }

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/g
const FILE_URL_RE = /\bfile:\/\/(\/[^\s<>"'`)\]]+)/g
const CODE_RE = /`([^`\n]+)`/g
// An absolute, home, dot or multi-segment relative path, with an optional :line(:col).
const PATH_RE =
  /(?:^|[\s(["'*])((?:~|\.{1,2})?(?:\/[\w.@+-]+)+\/?|[\w.@+-]+(?:\/[\w.@+-]+)+\/?|[\w.@+-]+\/)(?::(\d+)(?::\d+)?)?/g
// A bare file name with an extension, accepted only inside backticks.
const BARE_FILE_RE = /^[\w@+-][\w.@+-]*\.[A-Za-z][\w]{0,9}$/

const TRAILING = /[.,;:!?]+$/
// A URL also sheds markdown emphasis around it: `**https://x.dev**`, `~~https://x.dev~~.`
const URL_TRAILING = /[.,;:!?*_~]+$/

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s)
  } catch {
    return s
  }
}

function splitLine(token: string): { path: string; line?: number } {
  const m = /^(.*?):(\d+)(?::\d+)?$/.exec(token)
  if (m && m[1]) return { path: m[1], line: Number(m[2]) }
  return { path: token }
}

function looksLikePath(token: string): boolean {
  if (/\s/.test(token) || token.length > 400) return false
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return false
  if (token.includes('/')) return /^(?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]*)*$/.test(token)
  return BARE_FILE_RE.test(token)
}

/** Every URL and path-like token in the text, in the order they appear. */
export function findCandidates(text: string): Candidate[] {
  const found: Candidate[] = []

  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(URL_TRAILING, '')
    const at = m.index ?? 0
    found.push({ kind: 'url', url, at, end: at + url.length })
  }
  for (const m of text.matchAll(FILE_URL_RE)) {
    const raw = m[1].replace(URL_TRAILING, '')
    const { path, line } = splitLine(safeDecode(raw))
    const at = m.index ?? 0
    found.push({ kind: 'path', path, line, at, end: at + 'file://'.length + raw.length, isFileUrl: true })
  }
  for (const m of text.matchAll(CODE_RE)) {
    const token = m[1].trim().replace(TRAILING, '')
    const { path, line } = splitLine(token)
    const at = m.index ?? 0
    if (looksLikePath(path)) found.push({ kind: 'path', path, line, at, end: at + m[0].length })
  }

  // Bare paths in prose, with URLs blanked so their paths aren't read twice.
  const prose = text.replace(/\b(?:https?|file):\/\/[^\s<>"'`)\]]+/g, s => ' '.repeat(s.length))
  for (const m of prose.matchAll(PATH_RE)) {
    const path = m[1].replace(TRAILING, '')
    if (path === '/' || path === '//' || path.length < 3) continue
    const at = (m.index ?? 0) + m[0].indexOf(m[1])
    const end = m[2] ? (m.index ?? 0) + m[0].length : at + path.length
    found.push({ kind: 'path', path, line: m[2] ? Number(m[2]) : undefined, at, end })
  }

  return found.sort((a, b) => a.at - b.at)
}

/** Blanks what must not get links: fenced code, and links or autolinks already written. */
function maskMarkdown(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ')
  return text
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, blank)
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, blank)
    .replace(/<(?:https?|file):[^>\s]+>/g, blank)
}

/**
 * The text with each token `hrefFor` answers turned into a markdown link to
 * that href, the token's own spelling (backticks included) as the link text.
 * Fenced code and links already written are left alone.
 */
export function linkify(text: string, hrefFor: (c: Candidate) => string | undefined): string {
  let out = ''
  let pos = 0
  for (const c of findCandidates(maskMarkdown(text))) {
    if (c.at < pos) continue
    const href = hrefFor(c)
    if (!href) continue
    out += text.slice(pos, c.at) + `[${text.slice(c.at, c.end)}](${href})`
    pos = c.end
  }
  return out + text.slice(pos)
}

export function resolvePath(path: string, cwd: string, home: string | undefined): string | undefined {
  let p = path
  if (p === '~' || p.startsWith('~/')) {
    if (!home) return undefined
    p = home + p.slice(1)
  } else if (!p.startsWith('/')) {
    p = `${cwd.replace(/\/$/, '')}/${p}`
  }
  // Normalize `.` and `..` segments.
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return '/' + out.join('/')
}

export function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts.at(-1) ?? '/'
}

const MAX_HINT = 28

/** A long folder cut to its last two segments: `…/hooks/lib`. */
export function shortenHint(hint: string): string {
  if (hint.length <= MAX_HINT) return hint
  const parts = hint.split('/').filter(Boolean)
  const tail = parts.slice(-2).join('/')
  return tail.length + 2 <= MAX_HINT || parts.length < 2 ? `…/${tail}` : `…/${parts.at(-1)}`
}

/** The parent folder, relative to the session when inside it, `~` for home, shortened when long. */
export function parentHint(path: string, cwd: string, home: string | undefined): string | undefined {
  const parent = path.slice(0, path.lastIndexOf('/')) || '/'
  const root = cwd.replace(/\/$/, '')
  if (parent === root) return undefined
  if (parent.startsWith(root + '/')) return shortenHint(parent.slice(root.length + 1))
  if (home && (parent === home || parent.startsWith(home + '/'))) return shortenHint('~' + parent.slice(home.length))
  return shortenHint(parent)
}

export function urlLabel(url: string): string {
  try {
    const u = new URL(url)
    const rest = (u.pathname + u.search).replace(/\/$/, '')
    const short = rest.length > 40 ? rest.slice(0, 39) + '…' : rest
    return u.host.replace(/^www\./, '') + short
  } catch {
    return url.length > 50 ? url.slice(0, 49) + '…' : url
  }
}

const TEXT_EXT = new Set(
  (
    'ts tsx js jsx mjs cjs mts cts json jsonc md mdx txt log py rs go java kt kts swift c h cc cpp hpp cs rb php ' +
    'sh bash zsh fish ps1 yml yaml toml ini cfg conf env css scss sass less sql xml lock vue svelte astro lua ' +
    'dart scala ex exs erl clj r jl nix tf hcl gradle properties csv tsv graphql gql proto dockerfile makefile'
  ).split(' '),
)

/** Whether a file is best opened in the editor rather than its default app. */
export function isTextFile(path: string): boolean {
  const name = baseName(path).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return true // LICENSE, Makefile, .gitignore
  return TEXT_EXT.has(name.slice(dot + 1))
}

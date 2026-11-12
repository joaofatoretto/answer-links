import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Answer, Ref } from '../types'
import type { Candidate } from './refs'
import { baseName, collapse, findCandidates, isTextFile, linkify, parentHint, resolvePath, urlLabel } from './refs'

const answers = atom({ plugin: 'answer-links', key: 'answers' } as const, [] as Answer[])

/** How many recent answers keep their buttons, and how many buttons one answer gets. */
const KEEP = 40
const MAX_REFS = 12

type Dollar = EngineInterface

/** How many path-like tokens one answer may check on disk. */
const MAX_CHECKS = 80

/**
 * The refs an answer names that exist on disk (paths) or are URLs, in order,
 * deduplicated: the first MAX_REFS, and how many more there were.
 */
export async function collectRefs(
  text: string,
  bases: readonly string[],
  home: string | undefined,
  stat: (path: string) => Promise<'file' | 'dir' | 'other' | undefined>,
): Promise<{ refs: Ref[]; more: number; paths: Record<string, 'file' | 'dir'> }> {
  const refs: Ref[] = []
  const paths: Record<string, 'file' | 'dir'> = {}
  const seen = new Set<string>()
  let more = 0
  let checks = 0

  const add = (ref: Ref) => {
    if (refs.length < MAX_REFS) refs.push(ref)
    else more += 1
  }

  for (const c of findCandidates(text)) {
    if (c.kind === 'url') {
      if (seen.has(c.url)) continue
      seen.add(c.url)
      add({ kind: 'url', target: c.url, label: urlLabel(c.url) })
      continue
    }

    // A relative path is tried against each base in turn: the folder the
    // session is in now, then the project root it started in.
    let abs: string | undefined
    let base = bases[0] ?? '/'
    let kind: 'file' | 'dir' | undefined
    for (const b of bases) {
      if (checks >= MAX_CHECKS) break
      const p = resolvePath(c.path, b, home)
      if (p === undefined || seen.has(p)) break
      checks += 1
      const k = await stat(p)
      if (k === 'file' || k === 'dir') {
        abs = p
        base = b
        kind = k
        break
      }
      if (c.path.startsWith('/') || c.path.startsWith('~')) break
    }
    if (abs === undefined || kind === undefined) continue
    seen.add(abs)
    paths[abs] = kind

    const name = baseName(abs)
    add({
      kind,
      target: abs,
      label: kind === 'dir' ? `${name}/` : c.line ? `${name}:${c.line}` : name,
      hint: parentHint(abs, base, home),
      line: kind === 'file' ? c.line : undefined,
    })
  }

  return { refs, more, paths }
}

/** The answer a transcript block closes, if any: the block is the whole answer or its last part. */
export function answerFor(list: readonly Answer[], blockText: string): Answer | undefined {
  const block = collapse(blockText)
  if (block.length === 0) return undefined
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i]
    if (a.text === block || (block.length >= 20 && a.text.endsWith(block))) return a
  }
  return undefined
}

/** The answer a transcript block belongs to, if any: the block is the whole answer or a part of it. */
export function answerContaining(list: readonly Answer[], blockText: string): Answer | undefined {
  const block = collapse(blockText)
  if (block.length === 0) return undefined
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i]
    if (a.text === block || (block.length >= 20 && a.text.includes(block))) return a
  }
  return undefined
}

/** What a path's link points at: a `file:` URL the terminal can open too, `#L<n>` for a line. */
export function pathHref(base: string, abs: string, line?: number): string {
  return base + encodeURI(abs) + (line ? `#L${line}` : '')
}

/** The folders an answer's relative paths resolve against, newest field first. */
function basesOf(answer: Answer): readonly string[] {
  return answer.bases ?? (answer.cwd ? [answer.cwd] : [])
}

/** The href for a token of this answer's text, or undefined when it should stay plain. */
export function hrefFor(answer: Answer, base: string, home: string | undefined, c: Candidate): string | undefined {
  if (c.kind === 'url') return c.url
  if (c.isFileUrl || !answer.paths) return undefined
  for (const b of basesOf(answer)) {
    const abs = resolvePath(c.path, b, home)
    const kind = abs === undefined ? undefined : answer.paths[abs]
    if (abs !== undefined && kind) return pathHref(base, abs, kind === 'file' ? c.line : undefined)
  }
  return undefined
}

/**
 * The absolute path and fragment a `file:` link points at, however the surface
 * spells it: `file:///p`, `file://wsl.localhost/<distro>/p`, `file://wsl$/<distro>/p`,
 * a Windows UNC path, or a bare absolute path.
 */
export function pathOfHref(href: string): { path: string; fragment?: string } | undefined {
  let rest = href.replace(/\\/g, '/')
  const hash = rest.indexOf('#')
  const fragment = hash >= 0 ? rest.slice(hash + 1) : undefined
  if (hash >= 0) rest = rest.slice(0, hash)
  rest = rest.replace(/\?.*$/, '')

  if (/^file:/i.test(rest)) rest = rest.replace(/^file:(\/\/)?/i, '/')
  rest = rest.replace(/^\/+/, '/')
  // A WSL host, wherever it landed (the surface may have put the session's
  // folder before it): what follows it and the distro's name is the path.
  const wsl = /\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i.exec(rest)
  if (wsl) rest = wsl[1] ?? '/'
  if (!rest.startsWith('/')) return undefined
  try {
    return { path: decodeURI(rest), fragment }
  } catch {
    return { path: rest, fragment }
  }
}

/** Turns a pressed link back into what it opens. */
export function refFromHref(answer: Answer, href: string): Ref | undefined {
  if (/^https?:/i.test(href)) return { kind: 'url', target: href, label: urlLabel(href) }
  const parsed = pathOfHref(href)
  if (!parsed) return undefined
  const abs = parsed.path.length > 1 ? parsed.path.replace(/\/$/, '') : parsed.path
  const kind = answer.paths?.[abs] ?? 'file'
  const line = /^L(\d+)$/.exec(parsed.fragment ?? '')?.[1]
  const name = baseName(abs)
  return {
    kind,
    target: abs,
    label: kind === 'dir' ? `${name}/` : line ? `${name}:${line}` : name,
    line: line ? Number(line) : undefined,
  }
}

type Host = 'wsl' | 'mac' | 'linux'
let host: Host | undefined

async function detectHost($: Dollar): Promise<Host> {
  if (host) return host
  if (await $.fs.exists('/mnt/c/Windows/explorer.exe')) host = 'wsl'
  else if (await $.fs.exists('/System/Library/CoreServices')) host = 'mac'
  else host = 'linux'
  return host
}

/**
 * Links point at `file:///<absolute path>`: the surface resolves a `file:` URL
 * with a host (`file://wsl.localhost/...`) against the session's folder.
 */
const FILE_BASE = 'file://'

async function tryRun($: Dollar, argv: string[]): Promise<boolean> {
  try {
    const r = await $.process.run(argv, { timeoutMs: 15000 })
    // explorer.exe answers 1 even when it opened the thing.
    return r.exitCode === 0 || argv[0] === 'explorer.exe'
  } catch {
    return false
  }
}

async function systemOpen($: Dollar, h: Host, target: string, isUrl: boolean): Promise<boolean> {
  if (h === 'mac') return tryRun($, ['open', target])
  if (h === 'linux') return tryRun($, ['xdg-open', target])
  if (isUrl) return tryRun($, ['explorer.exe', target])
  const win = await $.process.run(['wslpath', '-w', target]).catch(() => undefined)
  const path = win?.exitCode === 0 ? win.stdout.trim() : target
  return tryRun($, ['explorer.exe', path])
}

export async function openRef($: Dollar, ref: Ref): Promise<void> {
  const h = await detectHost($)
  let ok = false

  if (ref.kind === 'file' && isTextFile(ref.target)) {
    const at = ref.line ? `${ref.target}:${ref.line}` : ref.target
    ok = await tryRun($, ['code', '-g', at])
  }
  if (!ok) ok = await systemOpen($, h, ref.target, ref.kind === 'url')

  $.ui.toast(ok ? `Opened ${ref.label}` : `Couldn't open ${ref.target}`)
}

const ICON: Record<Ref['kind'], string> = { file: '📄', dir: '📁', url: '🔗' }

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || e.reason !== 'answer' || e.answer.trim() === '') return next(e)

    try {
      const cwd = await $.session.cwd()
      const root = await $.session.root()
      const bases = root === cwd ? [cwd] : [cwd, root]
      const home = await $.env.get('HOME')
      const { refs, more, paths } = await collectRefs(e.answer, bases, home, async path => {
        try {
          return (await $.fs.stat(path)).kind
        } catch {
          return undefined
        }
      })

      if (refs.length > 0) {
        const entry: Answer = { text: collapse(e.answer), refs, paths, bases, ...(more > 0 ? { more } : {}) }
        await update($, answers, list => [...list.filter(a => a.text !== entry.text), entry].slice(-KEEP))
      }
    } catch {
      // Never hold up the end of a turn over the buttons.
    }

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)

    const list = await read($, answers)
    const answer = answerContaining(list, e.props.text)
    if (!answer) return next(e)
    const isLast = answerFor(list, e.props.text) === answer

    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const base = FILE_BASE
    const home = await $.env.get('HOME')
    const linked = linkify(e.props.text, c => hrefFor(answer, base, home, c))

    // Nothing to link: the engine draws the text as always.
    const body =
      linked === e.props.text ? (
        await next(e)
      ) : (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text>{e.props.isFirstOfReply ? '●' : ' '}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            <Markdown
              key="answer"
              text={linked}
              onLinkPress={link => {
                const ref = refFromHref(answer, link.href)
                if (ref) void openRef($, ref)
                else $.ui.toast(`Couldn't read the link ${link.href}`)
              }}
            />
          </Box>
        </Box>
      )

    if (!isLast) return body

    return (
      <Box flexDirection="column">
        {body}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1} marginTop={1} paddingLeft={2}>
          {answer.refs.map(ref => (
            <Button key={`${ref.kind}:${ref.target}:${ref.line ?? ''}`} onPress={() => openRef($, ref)}>
              {ICON[ref.kind]} {ref.label}
              {ref.hint ? <Text dimColor> {ref.hint}</Text> : ''}
            </Button>
          ))}
          {answer.more ? <Text dimColor>+{answer.more} more</Text> : ''}
        </Box>
      </Box>
    )
  })
}

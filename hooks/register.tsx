import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Answer, Ref } from '../types'
import { baseName, collapse, findCandidates, isTextFile, parentHint, resolvePath, urlLabel } from './refs'

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
  cwd: string,
  home: string | undefined,
  stat: (path: string) => Promise<'file' | 'dir' | 'other' | undefined>,
): Promise<{ refs: Ref[]; more: number }> {
  const refs: Ref[] = []
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

    if (checks >= MAX_CHECKS) continue

    const abs = resolvePath(c.path, cwd, home)
    if (abs === undefined || seen.has(abs)) continue
    checks += 1
    const kind = await stat(abs)
    if (kind !== 'file' && kind !== 'dir') continue
    seen.add(abs)

    const name = baseName(abs)
    add({
      kind,
      target: abs,
      label: kind === 'dir' ? `${name}/` : c.line ? `${name}:${c.line}` : name,
      hint: parentHint(abs, cwd, home),
      line: kind === 'file' ? c.line : undefined,
    })
  }

  return { refs, more }
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

type Host = 'wsl' | 'mac' | 'linux'
let host: Host | undefined

async function detectHost($: Dollar): Promise<Host> {
  if (host) return host
  if (await $.fs.exists('/mnt/c/Windows/explorer.exe')) host = 'wsl'
  else if (await $.fs.exists('/System/Library/CoreServices')) host = 'mac'
  else host = 'linux'
  return host
}

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
      const home = await $.env.get('HOME')
      const { refs, more } = await collectRefs(e.answer, cwd, home, async path => {
        try {
          return (await $.fs.stat(path)).kind
        } catch {
          return undefined
        }
      })

      if (refs.length > 0) {
        const entry: Answer = { text: collapse(e.answer), refs, ...(more > 0 ? { more } : {}) }
        await update($, answers, list => [...list.filter(a => a.text !== entry.text), entry].slice(-KEEP))
      }
    } catch {
      // Never hold up the end of a turn over the buttons.
    }

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary) return next(e)

    const answer = answerFor(await read($, answers), e.props.text)
    if (!answer) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const original = await next(e)

    return (
      <Box flexDirection="column">
        {original}
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

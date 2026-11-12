import { expect, test } from 'claude-code/testing'

import { answerFor, collectRefs, hrefFor, refFromHref } from './register'
import { findCandidates, linkify, shortenHint } from './refs'

const CWD = '/home/me/proj'
const HOME = '/home/me'
const DISK: Record<string, 'file' | 'dir'> = {
  '/home/me/proj/src/app.ts': 'file',
  '/home/me/proj/README.md': 'file',
  '/home/me/proj/src': 'dir',
  '/home/me/notes.md': 'file',
}
const stat = async (p: string) => DISK[p]

test('finds paths, file:line, folders and URLs, in order', async () => {
  const text = [
    'Changed `src/app.ts:42` and README.md.',
    'See the folder src/ and ~/notes.md, plus https://example.com/docs/x.',
    'Also `missing.ts` and /etc/nowhere.',
  ].join('\n')

  const { refs, more } = await collectRefs(text, [CWD], HOME, stat)

  expect(refs.map(r => `${r.kind} ${r.label}`)).toEqual([
    'file app.ts:42',
    'dir src/',
    'file notes.md',
    'url example.com/docs/x',
  ])
  expect(refs[0].line).toBe(42)
  expect(refs[0].hint).toBe('src')
  expect(refs[2].hint).toBe('~')
  expect(more).toBe(0)
})

test('a bare file name counts only in backticks', async () => {
  const { refs } = await collectRefs('Edit `README.md`, not README.md alone.', [CWD], HOME, stat)
  expect(refs.map(r => r.label)).toEqual(['README.md'])
})

test('past 12 refs, the rest are counted, not drawn', async () => {
  const text = Array.from({ length: 15 }, (_, i) => `https://example.com/p${i}`).join(' ')
  const { refs, more } = await collectRefs(text, [CWD], HOME, stat)
  expect(refs.length).toBe(12)
  expect(more).toBe(3)
})

test('a long folder hint keeps its last two segments', () => {
  expect(shortenHint('src')).toBe('src')
  expect(shortenHint('packages/web/src/components/forms')).toBe('…/components/forms')
  expect(shortenHint('a/very-long-folder-name-here/another-quite-long-folder')).toBe('…/another-quite-long-folder')
})

test('a relative path is tried against the project root when the session moved', async () => {
  const text = 'See `src/app.ts:3` and src/.'
  const { refs } = await collectRefs(text, ['/home/me/proj/sub', CWD], HOME, stat)
  expect(refs.map(r => r.label)).toEqual(['app.ts:3', 'src/'])
  const answer = { text: '', refs: [], bases: ['/home/me/proj/sub', CWD], paths: { '/home/me/proj/src/app.ts': 'file' } as const }
  expect(hrefFor(answer, BASE, HOME, findCandidates(text)[0])).toBe(`${BASE}/home/me/proj/src/app.ts#L3`)
})

test('a URL is not also read as a path', () => {
  const kinds = findCandidates('Open https://github.com/a/b/c now').map(c => c.kind)
  expect(kinds).toEqual(['url'])
})

test('a bold or emphasized URL leaves its markers out', () => {
  const urls = findCandidates('Fiz: **https://claude.ai/artifact/EGeN** e *https://x.dev/a*. ~~https://y.dev~~')
    .filter(c => c.kind === 'url')
    .map(c => c.kind === 'url' && c.url)
  expect(urls).toEqual(['https://claude.ai/artifact/EGeN', 'https://x.dev/a', 'https://y.dev'])
  const linked = linkify('Fiz: **https://claude.ai/artifact/EGeN**', c => (c.kind === 'url' ? c.url : undefined))
  expect(linked).toBe('Fiz: **[https://claude.ai/artifact/EGeN](https://claude.ai/artifact/EGeN)**')
})

test('only the block that closes the answer gets buttons', () => {
  const list = [{ text: 'Intro text here. Final part with src/app.ts done.', refs: [] }]
  expect(answerFor(list, 'Final part with   src/app.ts done.')).toBe(list[0])
  expect(answerFor(list, 'Intro text here.')).toBeUndefined()
  expect(answerFor(list, 'Something else entirely')).toBeUndefined()
})

test('the final answer draws a button per ref under the text', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('fs.exists', () => ({ value: true }))
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'HOME' ? HOME : 'Ubuntu' }))
  on('state.get', () => ({
    value: {
      value: [{ text: 'Done, see x.', refs: [{ kind: 'url', target: 'https://x.dev', label: 'x.dev' }], more: 3 }],
      version: 1,
    },
  }))

  const ui = await $.ui.mount({
    plugin: 'answer-links',
    component: 'AssistantMessage',
    surface: 'terminal',
    props: { text: 'Done, see x.', isFirstOfReply: true },
  })

  expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
  expect(await ui.find({ type: 'Button', key: 'url:https://x.dev:' })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /more/ }))?.text).toBe('+3 more')
  await ui.unmount()
})

const BASE = 'file://'
const ANSWER = {
  text: '',
  refs: [],
  cwd: CWD,
  paths: { '/home/me/proj/src/app.ts': 'file', '/home/me/proj/src': 'dir', '/home/me/notes.md': 'file' } as const,
}

test('paths that exist become links in the text; the rest stay plain', () => {
  const text = 'Changed `src/app.ts:42`, the folder src/ and ~/notes.md, not /etc/nowhere. See https://x.dev.'
  const out = linkify(text, c => hrefFor(ANSWER, BASE, HOME, c))
  expect(out).toBe(
    'Changed [`src/app.ts:42`](file:///home/me/proj/src/app.ts#L42), ' +
      'the folder [src/](file:///home/me/proj/src) and ' +
      '[~/notes.md](file:///home/me/notes.md), not /etc/nowhere. ' +
      'See [https://x.dev](https://x.dev).',
  )
})

test('fenced code and links already written are left alone', () => {
  const text = 'See [the app](https://a.dev/src/app.ts).\n```\ncat src/app.ts\n```\nThen src/app.ts.'
  const out = linkify(text, c => hrefFor(ANSWER, BASE, HOME, c))
  expect(out).toBe(
    'See [the app](https://a.dev/src/app.ts).\n```\ncat src/app.ts\n```\n' +
      'Then [src/app.ts](file:///home/me/proj/src/app.ts).',
  )
})

test('a pressed link turns back into the file, line and kind it opens', () => {
  expect(refFromHref(ANSWER, `${BASE}/home/me/proj/src/app.ts#L42`)).toEqual({
    kind: 'file',
    target: '/home/me/proj/src/app.ts',
    label: 'app.ts:42',
    line: 42,
  })
  expect(refFromHref(ANSWER, `${BASE}/home/me/proj/src`)?.kind).toBe('dir')
  expect(refFromHref(ANSWER, 'https://x.dev')?.kind).toBe('url')
  expect(refFromHref(ANSWER, 'file:///home/me/proj/src/app.ts#L7')?.line).toBe(7)
  expect(refFromHref(ANSWER, 'file://wsl$/Ubuntu/home/me/proj/src/')?.kind).toBe('dir')
  expect(refFromHref(ANSWER, '\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.md')?.target).toBe('/home/me/notes.md')
  expect(refFromHref(ANSWER, 'file:///home/me/proj/wsl.localhost/Ubuntu/home/me/notes.md')?.target).toBe('/home/me/notes.md')
  expect(refFromHref(ANSWER, 'mailto:x@y.z')).toBeUndefined()
})

test('a block with paths is drawn as linked markdown, buttons under it', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('fs.exists', () => ({ value: true }))
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'HOME' ? HOME : 'Ubuntu' }))
  on('state.get', () => ({
    value: {
      value: [
        {
          text: 'Edited src/app.ts today.',
          refs: [{ kind: 'file', target: '/home/me/proj/src/app.ts', label: 'app.ts', hint: 'src' }],
          paths: { '/home/me/proj/src/app.ts': 'file' },
          cwd: CWD,
        },
      ],
      version: 1,
    },
  }))

  const ui = await $.ui.mount({
    plugin: 'answer-links',
    component: 'AssistantMessage',
    surface: 'terminal',
    props: { text: 'Edited src/app.ts today.', isFirstOfReply: true },
  })

  expect(await ui.find({ type: 'Text', text: /engine/ })).toBeFalsy()
  expect(await ui.find({ type: 'Markdown', key: 'answer' })).toBeTruthy()
  expect(await ui.find({ type: 'Button', key: 'file:/home/me/proj/src/app.ts:' })).toBeTruthy()
  await ui.unmount()
})

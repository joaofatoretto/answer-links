import { expect, test } from 'claude-code/testing'

import { answerFor, collectRefs } from './register'
import { findCandidates, shortenHint } from './refs'

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

  const { refs, more } = await collectRefs(text, CWD, HOME, stat)

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
  const { refs } = await collectRefs('Edit `README.md`, not README.md alone.', CWD, HOME, stat)
  expect(refs.map(r => r.label)).toEqual(['README.md'])
})

test('past 12 refs, the rest are counted, not drawn', async () => {
  const text = Array.from({ length: 15 }, (_, i) => `https://example.com/p${i}`).join(' ')
  const { refs, more } = await collectRefs(text, CWD, HOME, stat)
  expect(refs.length).toBe(12)
  expect(more).toBe(3)
})

test('a long folder hint keeps its last two segments', () => {
  expect(shortenHint('src')).toBe('src')
  expect(shortenHint('packages/web/src/components/forms')).toBe('…/components/forms')
  expect(shortenHint('a/very-long-folder-name-here/another-quite-long-folder')).toBe('…/another-quite-long-folder')
})

test('a URL is not also read as a path', () => {
  const kinds = findCandidates('Open https://github.com/a/b/c now').map(c => c.kind)
  expect(kinds).toEqual(['url'])
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

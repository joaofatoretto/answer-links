/** One thing the answer named that a click can open. */
export type Ref = {
  kind: 'file' | 'dir' | 'url'
  /** An absolute path, or the URL. */
  target: string
  /** What the button says: a file's name, a folder's name, a URL's host and path. */
  label: string
  /** Drawn dim after the label: the parent folder, relative to the session. */
  hint?: string
  /** The line the answer pointed at (`file.ts:42`). */
  line?: number
}

/** A final answer, whitespace collapsed, what it named, and how many refs past the cap were left out. */
export type Answer = { text: string; refs: Ref[]; more?: number }

declare module 'claude-code' {
  interface PluginState {
    'answer-links': { answers: Answer[] }
  }
}

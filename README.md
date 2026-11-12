# answer-links

A Claude Code mod. When Claude finishes a turn, the files, folders and links its final answer names show up as buttons right under the answer, in the transcript. Click a button to open it.

- **Files**: code and text files open in VS Code at the line the answer gave (`file.ts:42`). Other files (images, PDFs, HTML) open in their default app.
- **Folders** open in the file manager (Explorer on WSL, Finder on macOS, `xdg-open` on Linux).
- **Links** (`http`, `https`) open in the default browser.

The same paths and links are also clickable inside the answer's own text, and open the same way. A ctrl+click there hands the link to the terminal instead.

Only paths that exist on disk get a button or a link, so prose that only looks like a path is skipped. A bare file name counts only inside backticks. Each answer gets at most 12 buttons; past that, a dim `+N more` says how many were left out. Buttons wrap onto new lines with a blank line between rows, and a long parent folder is cut to its last two segments (`…/components/forms`). Subagent turns and the text between tool calls get none.

A plain click works in the fullscreen terminal (`"tui": "fullscreen"`) and on the desktop app.

## Install

In a Claude Code terminal session:

```
/plugin install answer-links --marketplace joaofatoretto/answer-links
```

Then run `/reload-plugins`, or start a new session.

## Develop

```
claude plugin validate <absolute path to answer-links>
claude plugin test <absolute path to answer-links>
```

MIT licensed.

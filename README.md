# TARDIS 3 (JavaScript edition)

> *"It's bigger on the inside."*

Packs a whole project into **one well-labelled document** for pasting into a chat window,
and applies the AI's reply back to your files with a diff preview, a backup and an undo.

## Run it

| Goal | Command |
|---|---|
| Open the GUI | `node tardis.js` |
| GUI in a chromeless app window (Chrome/Edge) | `node tardis.js --app` |
| Pack from the terminal | `node tardis.js . --copy --budget 100k` |
| Apply the reply on the clipboard | `node tardis.js apply` |
| Undo the last apply | `node tardis.js undo` |
| Install a `tardis` command | `npm install -g .` |
| Run the tests | `node --test` |

Requirements: **Node.js 18+**, nothing else. Optional: `git` (exact `.gitignore` handling,
time travel, remote repositories) and the npm package `gpt-tokenizer` (exact token counts
for OpenAI models; used automatically when installed).

## Files

| File | Role |
|---|---|
| `tardis.js` | Engine, local server and command line, in 16 numbered sections. |
| `ui.html` | The interface. Served by `tardis.js`; must sit next to it. |
| `tardis.test.js` | Tests for Node's built-in runner. |
| `package.json` | Metadata; defines the `tardis` command. |

## How the GUI works

`node tardis.js` starts a small server on `127.0.0.1` (a free port) and opens your browser.
The page is only a view: every action calls the server's JSON API, which does the real work
with full access to your files and git. Closing the tab stops the server (`--stay` keeps it).

Security: the server listens on localhost only, every API call needs a random per-run token
that only the page knows, and requests with a foreign `Host` header are refused.

### Tab 1 - Pack a project

| Area | What it does |
|---|---|
| Project box | Folder path or Git URL; **Browse...** opens the built-in folder picker; recent projects are suggested. |
| 1 What to pack | Git time travel (*now* / *changed since...* / *as it was at...*), hidden files, ignore rules, size limit, glob filters. |
| 2 Size | Token budget and what to do when over: *Trim to fit* or *Split into parts*. |
| 3 Output | Format, secret redaction, line numbers, map only. |
| 4 Task | A template or your own instructions, placed after the snapshot. |
| File tree | Tick to include. Tokens per file and folder, share bars, and reasons. Right-click: Full / Condensed / Leave out / Automatic / Focus on imports. |
| Token map | The coloured strip above the tree: one segment per top-level folder. Click to filter. |
| Preview | Exactly what will be copied. Click a file in the tree to jump to it. |
| Live | Rescans automatically when files change on disk. |

Shortcuts: **Ctrl/Cmd+Enter** copy (or apply, on tab 2), **/** find, **Esc** close.

### Tab 2 - Apply the AI's reply

Paste the reply; TARDIS lists every file it would change with a coloured diff. Risky changes
(abbreviated files, guessed file names, failed edits) are unticked with a note. **Apply**
backs up originals to `.tardis/backups/` first; **Undo last apply** restores them.
**Copy fix-up request** writes the follow-up message asking the AI to resend what failed.

## Command line

`node tardis.js --help` lists everything. The options, snapshot format, reply format,
condensed views, priorities and stored files are the same as in the Python edition, with
these differences:

| Topic | JavaScript edition |
|---|---|
| GUI toolkit | Browser page served locally (was Tk). |
| Exact token counts | `gpt-tokenizer` if installed (was `tiktoken`); flag `--tokenizer exact`. |
| Python outlines | Indentation-based (was Python's `ast`); same output shape. |
| Save from the GUI | Downloads through the browser. |
| Drag a folder onto the window | Not possible in a browser (pages never receive folder paths); use Browse or paste the path. |
| Profiles | Same `.tardis.json` format - profiles are interchangeable between editions. |
| New | Live mode, token map, fix-up request, dark theme, `--app`, `--port`, `--no-open`, `--stay`. |

## Use as a library

```js
const T = require('./tardis.js');
const opts = { ...T.defaultOptions('path/to/project'), budget: 100000 };
const scan = T.scanProject(opts);
const doc = T.buildDocument(scan, opts);          // doc.parts, doc.tokens, doc.items ...
const { changes } = T.parseReply(replyText, T.listFiles(opts.root));
const planned = T.evaluateChanges(changes, opts.root);   // inspect before writing
T.applyChanges(planned.filter((p) => p.ok), opts.root);
```

## Limitations

- Outlines for non-Python languages are regex heuristics.
- Unified-diff replies are not applied; ask for complete files or EDIT blocks.
- Only Markdown snapshots can be read back by `apply`.
- Secret detection and import resolution are heuristic.
- Live mode needs recursive file watching (Windows, macOS, or Linux with Node 20+).
- Scans run synchronously in the server; the page shows a spinner while it waits.
# TARDIS (JavaScript edition) — Tree And Repo Dump In Single-file

> *"It's bigger on the inside."*

TARDIS packs an entire project into **one well-labelled document** — a map of the folder
structure plus the contents of every file — ready to paste into a chat window. When the AI
replies with changes, TARDIS applies them back to your files with a diff preview, a backup and
an undo. This is the Node.js edition; it shares its document format and its saved-state files
with the Python edition, so the two can be mixed on the same projects.

## Requirements

| Requirement | For | Notes |
|---|---|---|
| Node.js 18+ | everything | no dependencies |
| a web browser | the GUI | the GUI is a local web app; it never leaves your machine |
| git | `.gitignore` accuracy, time travel, remote repos | optional |
| `gpt-tokenizer` | exact token counts for OpenAI models | optional: `npm i gpt-tokenizer` |
| `xclip` / `wl-clipboard` | clipboard in **terminal** mode on Linux | the GUI uses the browser's clipboard |

## Install and run

```bash
npm install -g .        # gives you the `tardis` command  (or: node tardis.js)
tardis                  # opens the GUI in your browser
npm test                # runs the test suite
```

## Quick start

**GUI:** `tardis` → pick a folder (or paste a GitHub URL) → adjust the budget / task if you like
→ **Copy to clipboard** → paste into the chat. When the AI replies: tab **2 · Apply**, paste,
review the diffs, **Apply**. Keyboard: `Ctrl/⌘+Enter` copies, `Alt+R` rescans.

**Terminal:**

```bash
tardis . --copy --budget 100k --template "Find bugs"
tardis apply              # reads the reply from the clipboard, shows diffs, asks y/n
tardis undo
```

## How the GUI works

The GUI is a single page served from `127.0.0.1` by `lib/server.js`. Every request carries a
random token minted at start-up (the URL you are sent to contains it), so other web pages
cannot talk to the server. The server holds the current scan in memory; the page only holds
your ticks. Heavy work (scanning, building the document) is one POST each; the page polls
progress while a scan runs.

| Area | What it does |
|---|---|
| Project box | A path or a git URL. Remembers recent projects. **Browse…** opens a folder picker that runs on the server, so it works for any folder on the machine. |
| Auto-rescan | Watches the folder (`fs.watch`) and rescans when files change. |
| 1 · What to pack | Time travel (now / changed since / as of), hidden files, `.gitignore`, lock files, secret-looking files, size limit, include/exclude globs. |
| 2 · Size | Token budget; trim to fit or split into parts. The bottom meter shows how full you are. |
| 3 · Output | Markdown / XML / plain text; redaction; line numbers; map only. |
| 4 · Task | Built-in or saved task templates; free text; "ask for replies TARDIS can apply". |
| File tree | Tick = include. Right-click: Full / Condensed / Leave out / Automatic / Focus on imports / Add imports / Add importers. Tokens and a share bar per file and folder; heat colours for the biggest items; sort by size; find-as-you-type. Orange = trimmed by the budget. |
| Preview | Exactly what will be copied; click a file to jump to it. Part selector for split snapshots. |
| Bottom bar | Language breakdown, **Download** (one file per part), **Copy**. |
| Tab 2 | Paste or open a reply; each file shows New / Modified / Delete / No change / Can't apply with notes; risky changes are unticked; coloured diff; Apply; Undo. |

## Commands and options

`tardis [pack] PATH|URL [options]` (no PATH opens the GUI)

| Option | Effect |
|---|---|
| `-o FILE` / `-c` | output file (`-` = stdout) / copy to clipboard |
| `-f markdown\|xml\|text` | output format |
| `-a` | include hidden files |
| `-i GLOB`, `-x GLOB`, `--omit GLOB`, `--condense GLOB` | filters (gitignore syntax, repeatable) |
| `-n` | line numbers |
| `--max-size KB` | condense/omit larger files (256) |
| `--include-locks`, `--include-secrets`, `--no-ignore`, `--no-redact`, `--tree-only` | as named |
| `--budget TOKENS`, `--split` | token ceiling; split instead of trim |
| `--since REF`, `--at REF`, `--no-diff` | git time travel |
| `--focus FILE`, `--with-importers` | only a file plus its imports |
| `--task TEXT`, `--template NAME`, `--no-reply-format` | the task appended after the snapshot |
| `--profile NAME`, `--save-profile NAME` | profiles in `.tardis.json` |
| `--tokenizer auto\|estimate\|tiktoken` | counting method |
| `--port N`, `--no-open`, `--gui` | GUI options |

`tardis apply [FILE|-] [--to DIR] [-y] [--dry-run] [--all]`, `tardis undo [DIR]`,
`tardis menu install|remove`, `tardis templates`.

## The document, the reply format and everything else

The snapshot format, condensed views, budgets, priorities, secret handling, git time travel,
profiles and the apply/undo safety rules are identical to the Python edition — see its README
for the full specification. In short:

- Files appear as `### FILE n/N: \`path\`` headings with fenced code; condensed views are tagged
  `(condensed)`; the map tags `[omitted: reason]`, `[condensed: …]`, `[modified]`.
- The AI is asked to reply with `### FILE:`, `### EDIT:` (SEARCH/REPLACE) and `### DELETE:`
  blocks; informal styles are understood too.
- Secrets are replaced with `[REDACTED:kind#n]` and restored on the way back.
- Applying backs originals up to `.tardis/backups/<timestamp>/` and `tardis undo` reverts.

## Files TARDIS writes

| Path | Purpose |
|---|---|
| `~/.tardis/state.json` | recent projects, per-project sessions, your templates |
| `<project>/.tardis.json` | named profiles |
| `<project>/.tardis/backups/…` | originals saved before an apply (+ a `.gitignore` so git ignores the folder) |
| temp folder `tardis-*` | clones of remote repositories, removed on exit |

## Limitations

- Outlines for languages other than Python are regex heuristics; the Python outline is
  indentation-based (no parser), so unusual formatting can confuse it.
- Diff-style replies are not applied; ask for complete files or EDIT blocks.
- `fs.watch` with `recursive: true` needs Node 20+ on Linux.
- Clipboard *reading* in the browser depends on the browser's permission prompt; `Ctrl+V` into
  the box always works.
#!/usr/bin/env node
'use strict';
/**
 * @file tardis.js — command-line entry point.
 *
 *   tardis                          open the GUI (local web app)
 *   tardis [pack] PATH|URL [opts]   write / copy a snapshot
 *   tardis apply [FILE|-] [opts]    apply an AI reply (default: clipboard)
 *   tardis undo [DIR]               revert the last apply
 *   tardis menu install|remove      right-click "Pack with TARDIS"
 *   tardis templates                list task templates
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const core = require('./lib/core');
const applyLib = require('./lib/apply');
const state = require('./lib/state');
const clip = require('./lib/clipboard');

const say = (m = '') => process.stderr.write(m + '\n');

// ---------------------------------------------------------------------------
// A tiny option parser (no dependencies). spec: {name: {alias, type, help}}
// type: 'bool' | 'str' | 'list'
// ---------------------------------------------------------------------------
function parseArgs(argv, spec) {
  const out = { _: [] };
  const byAlias = {};
  for (const [name, s] of Object.entries(spec)) if (s.alias) byAlias[s.alias] = name;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-') { out._.push(a); continue; }
    let name, value = null;
    if (a.startsWith('--')) { [name, value] = a.slice(2).split(/=(.*)/s); }
    else { name = byAlias[a.slice(1)] || a.slice(1); }
    if (!spec[name]) throw new core.TardisError(`Unknown option: ${a} (see --help)`);
    if (spec[name].type === 'bool') out[name] = true;
    else {
      if (value === null || value === undefined) value = argv[++i];
      if (value === undefined) throw new core.TardisError(`Option --${name} needs a value.`);
      if (spec[name].type === 'list') (out[name] = out[name] || []).push(value); else out[name] = value;
    }
  }
  return out;
}
function helpFor(spec, usage) {
  const lines = [usage, ''];
  for (const [name, s] of Object.entries(spec)) lines.push(`  ${(s.alias ? `-${s.alias}, ` : '    ') + '--' + name + (s.type === 'bool' ? '' : ' ' + (s.meta || 'VALUE'))}`.padEnd(28) + s.help);
  return lines.join('\n');
}

const PACK_SPEC = {
  output: { alias: 'o', type: 'str', meta: 'FILE', help: "output file; '-' = stdout (default: <project>.tardis.md here, unless --copy)" },
  copy: { alias: 'c', type: 'bool', help: 'copy to the clipboard' },
  format: { alias: 'f', type: 'str', meta: 'FMT', help: 'markdown | xml | text' },
  hidden: { alias: 'a', type: 'bool', help: 'include hidden files (dotfiles)' },
  include: { alias: 'i', type: 'list', meta: 'GLOB', help: 'only these paths (repeatable)' },
  exclude: { alias: 'x', type: 'list', meta: 'GLOB', help: 'drop these paths (repeatable)' },
  omit: { type: 'list', meta: 'GLOB', help: 'keep in the map, no contents' },
  condense: { type: 'list', meta: 'GLOB', help: 'include only a condensed view' },
  'line-numbers': { alias: 'n', type: 'bool', help: 'prefix content lines with numbers' },
  'max-size': { type: 'str', meta: 'KB', help: 'larger files are condensed or omitted (default 256)' },
  'include-locks': { type: 'bool', help: 'include lock and minified files' },
  'include-secrets': { type: 'bool', help: 'include .env, *.pem, ...' },
  'no-ignore': { type: 'bool', help: 'ignore .gitignore and the junk-folder list' },
  'no-redact': { type: 'bool', help: 'keep secret-looking values' },
  'tree-only': { type: 'bool', help: 'structure map only' },
  budget: { type: 'str', meta: 'TOKENS', help: 'token ceiling, e.g. 100k' },
  split: { type: 'bool', help: 'over budget: split into parts instead of trimming' },
  since: { type: 'str', meta: 'REF', help: 'only what changed since this git ref' },
  at: { type: 'str', meta: 'REF', help: 'the project as it was at this git ref' },
  'no-diff': { type: 'bool', help: 'with --since: leave the diff out' },
  focus: { type: 'list', meta: 'FILE', help: 'only this file (or glob) + its imports' },
  'with-importers': { type: 'bool', help: 'with --focus: also files that import it' },
  task: { type: 'str', meta: 'TEXT', help: 'instructions for the AI, placed after the snapshot' },
  template: { type: 'str', meta: 'NAME', help: 'a named task (prefix match allowed)' },
  'no-reply-format': { type: 'bool', help: 'leave out the how-to-reply section' },
  profile: { type: 'str', meta: 'NAME', help: 'load settings from .tardis.json' },
  'save-profile': { type: 'str', meta: 'NAME', help: 'save these settings as a profile' },
  tokenizer: { type: 'str', meta: 'MODE', help: 'auto | estimate | tiktoken (gpt-tokenizer)' },
  port: { type: 'str', meta: 'N', help: 'GUI: port to listen on (default: random)' },
  'no-open': { type: 'bool', help: 'GUI: do not open a browser tab' },
  gui: { type: 'bool', help: 'open the GUI with PATH preloaded' },
  quiet: { alias: 'q', type: 'bool', help: 'no summary on stderr' },
  version: { alias: 'V', type: 'bool', help: 'print the version' },
  help: { alias: 'h', type: 'bool', help: 'this help' },
};
const APPLY_SPEC = {
  to: { type: 'str', meta: 'DIR', help: 'folder to change (default: current folder)' },
  yes: { alias: 'y', type: 'bool', help: 'apply without asking' },
  'dry-run': { type: 'bool', help: 'only show what would change' },
  all: { type: 'bool', help: 'also apply changes that were flagged (!)' },
  help: { alias: 'h', type: 'bool', help: 'this help' },
};

/** Build Options from parsed args, with an optional profile underneath. */
async function optionsFromArgs(a, root) {
  let o = core.defaultOptions(root), selData = null;
  if (a.profile) {
    const prof = (await state.loadProfiles(root))[a.profile];
    if (!prof) throw new core.TardisError(`No profile named "${a.profile}" in ${path.join(root, state.PROFILE_FILE)}.`);
    o = core.mergeOptions(o, prof.options || {});
    selData = prof.selection || null;
  }
  if (a.format) o.fmt = a.format;
  if (a.hidden) o.include_hidden = true;
  if (a['line-numbers']) o.line_numbers = true;
  if (a['include-locks']) o.include_locks = true;
  if (a['include-secrets']) o.include_secrets = true;
  if (a['tree-only']) o.tree_only = true;
  if (a.since) o.since = a.since;
  if (a.at) o.at = a.at;
  if (a.task) o.task = a.task;
  for (const [k, key] of [['include', 'include_globs'], ['exclude', 'exclude_globs'], ['omit', 'omit_globs'], ['condense', 'condense_globs']]) if (a[k]) o[key] = core.splitGlobs(a[k]);
  if (a['max-size']) o.max_size_kb = Math.max(1, parseInt(a['max-size'], 10) || 256);
  if (a['no-ignore']) o.use_ignore = false;
  if (a['no-redact']) o.redact = false;
  if (a['no-diff']) o.include_diff = false;
  if (a['no-reply-format']) o.reply_format = false;
  if (a.budget) o.budget = core.parseTokens(a.budget);
  if (a.split) o.over = 'split';
  if (a.template) { const t = await state.findTemplate(a.template); o.task = t + (a.task ? '\n\n' + o.task : ''); }
  return { o, selData };
}

function printSummary(scan, doc, dests) {
  const art = ['    _|_    ', '  _|___|_  ', ' | [] [] | ', ' | [] [] | ', ' | [] []o| ', ' |_______| '];
  const side = ['', `${core.APP_NAME} v${core.VERSION}`, core.APP_LONG, `"${core.TAGLINE}"`, '', ''];
  say();
  art.forEach((a, i) => say(`  ${a}  ${side[i]}`.trimEnd()));
  say();
  const g = scan.git;
  say(`  Project  : ${scan.name}${g.inside ? ` (git: ${g.branch || '?'} @ ${g.commit || 'no commits'})` : ''}`);
  if (scan.opts.at) say(`  Time     : as it was at ${scan.opts.at} (${scan.atSha.slice(0, 10)})`);
  if (scan.opts.since) say(`  Scope    : ${core.plural(Object.keys(scan.changes).length, 'file')} changed since ${scan.opts.since}, ${scan.deleted.length} deleted`);
  say(`  Included : ${core.plural(doc.filesFull, 'file')} in full${doc.filesCondensed ? `, ${doc.filesCondensed} condensed` : ''}, ${core.plural(doc.lines, 'line')}`);
  const shown = Object.entries(doc.omittedCounts).filter(([c]) => c !== 'unchanged').sort((x, y) => y[1] - x[1]);
  if (shown.length) say(`  Map only : ${shown.map(([c, n]) => `${n} ${core.REASON_LABELS[c] || c}`).join(', ')}`);
  if (scan.hiddenSkipped) say(`  Hidden   : ${core.plural(scan.hiddenSkipped, 'hidden item')} stayed behind the perception filter (use --hidden)`);
  let size = `~${core.fmtInt(doc.tokens)} tokens`;
  if (doc.budget) { size += ` of a ${core.fmtInt(doc.budget)} budget`; if (doc.parts.length > 1) size += ` per part -> ${doc.parts.length} parts`; }
  else size += ` (${core.contextNote(doc.tokens)})`;
  say(`  Size     : ${size}   [${doc.counter}]`);
  if (doc.trimmed || doc.squeezed) {
    say(`  Budget   : ${doc.squeezed} condensed and ${doc.trimmed} left out to fit, lowest priority first:`);
    const cut = doc.items.filter((it) => it.auto);
    cut.slice(0, 8).forEach((it) => say(`               ${it.mode !== 'off' ? 'condensed' : 'left out '}  ${it.e.rel}`));
    if (cut.length > 8) say(`               ...and ${cut.length - 8} more (tagged in the map)`);
  }
  if (doc.overBudget) say('  WARNING  : still over budget - raise it, exclude more, or use --split');
  if (doc.redacted) say(`  Redacted : ${core.plural(doc.redacted, 'secret-looking value')} (--no-redact to keep them)`);
  for (const d of dests) say(`  Output   : ${d}`);
  if (doc.secrets.length && !doc.redacted) { say(); say('  Spoilers! Possible secrets in the packed text:'); doc.secrets.slice(0, 10).forEach(([rel, line, kind]) => say(`    - ${rel}:${line}  (${kind})`)); }
  say();
  say(doc.filesFull || doc.filesCondensed || scan.opts.tree_only ? '  Fantastic! Allons-y.' : '  Hmm. Nothing to pack - check the folder and the filters.');
  say();
}

const ask = (q) => new Promise((resolve) => { const rl = readline.createInterface({ input: process.stdin, output: process.stderr }); rl.question(q, (a) => { rl.close(); resolve(a); }); });
const partPaths = (file, n) => (n === 1 ? [file] : Array.from({ length: n }, (_, k) => { const ext = path.extname(file); return file.slice(0, -ext.length) + `.part${k + 1}` + ext; }));

async function cmdPack(argv) {
  const a = parseArgs(argv, PACK_SPEC);
  if (a.help) { say(helpFor(PACK_SPEC, 'usage: tardis [pack] PATH|URL [options]   (no PATH = open the GUI)')); return 0; }
  if (a.version) { console.log(`${core.APP_NAME} ${core.VERSION}`); return 0; }
  core.TOKENS.configure(a.tokenizer || 'auto');
  const src = a._[0] || '';
  if (a.gui || !src) {
    const { startServer } = require('./lib/server');
    const { url } = await startServer({ port: parseInt(a.port || '0', 10) || 0, open: !a['no-open'], initial: src });
    say(`  TARDIS is running at ${url}`); say('  (Ctrl-C stops it. The GUI only answers this computer.)');
    return new Promise(() => {});               // keep serving until Ctrl-C
  }
  let root, source = '';
  if (core.isRemote(src)) { say('  Vworp... fetching the repository.'); ({ root, url: source } = await core.cloneRemote(src, !!(a.since || a.at))); }
  else { root = path.resolve(src.replace(/^~(?=$|[/\\])/, os.homedir())); if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new core.TardisError(`Not a folder: ${root}`); }
  const { o, selData } = await optionsFromArgs(a, root);
  o.source = source;
  if (a['save-profile']) { const profiles = await state.loadProfiles(root); profiles[a['save-profile']] = { options: core.pickOptions(o), selection: {} }; await state.saveProfiles(root, profiles); }
  const ext = core.FORMAT_EXT[o.fmt];
  const safe = path.basename(root).replace(/[^\w.-]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'project';
  const defaultOut = path.join(process.cwd(), `${safe}.tardis${ext}`);
  const toStdout = a.output === '-';
  let outPath = null;
  if (a.output && !toStdout) { outPath = path.resolve(a.output); if (fs.existsSync(outPath) && fs.statSync(outPath).isDirectory()) outPath = path.join(outPath, path.basename(defaultOut)); }
  else if (!a.output && !a.copy) outPath = defaultOut;
  let skipRel = '';
  if (outPath && outPath.startsWith(root + path.sep)) skipRel = path.relative(root, outPath).replace(/\\/g, '/');
  const scan = await core.scanProject(o, { skipRel });
  let selection = selData ? state.expandSelection(selData, scan.entries) : {};
  if (a.focus) {
    const wanted = new core.GlobSet(a.focus);
    const starts = scan.entries.filter((e) => a.focus.includes(e.rel) || wanted.matches(e.rel)).map((e) => e.rel);
    if (!starts.length) throw new core.TardisError('--focus matched no files: ' + a.focus.join(', '));
    selection = core.focusSelection(scan, starts, !!a['with-importers']).sel;
  }
  const doc = await core.buildDocument(scan, o, selection);
  const dests = [];
  if (a.copy) {
    let ok = true;
    for (let k = 0; k < doc.parts.length && ok; k++) {
      ok = await clip.copyToClipboard(doc.parts[k]);
      if (!ok) break;
      if (doc.parts.length > 1) {
        if (k === doc.parts.length - 1) say(`  Part ${k + 1} of ${doc.parts.length} is on the clipboard - that is the last one.`);
        else if (!process.stdin.isTTY) { say(`  Part 1 of ${doc.parts.length} is on the clipboard; use -o to get every part as a file.`); break; }
        else await ask(`  Part ${k + 1} of ${doc.parts.length} is on the clipboard. Paste it, then press Enter for part ${k + 2}... `);
      }
    }
    if (ok) dests.push('clipboard');
    else { say('Could not reach the clipboard (on Linux install xclip or wl-clipboard). Writing a file instead.'); if (!outPath && !toStdout) outPath = defaultOut; }
  }
  if (outPath) { await fs.promises.mkdir(path.dirname(outPath), { recursive: true }); const files = partPaths(outPath, doc.parts.length); for (let k = 0; k < files.length; k++) { await fs.promises.writeFile(files[k], doc.parts[k]); dests.push(files[k]); } }
  if (toStdout) { process.stdout.write(doc.text); dests.push('stdout'); }
  if (!a.quiet) printSummary(scan, doc, dests);
  return 0;
}

const STATUS_LABEL = { new: 'New file', modified: 'Modified', delete: 'Delete', unchanged: 'No change', problem: "Can't apply" };

async function cmdApply(argv) {
  const a = parseArgs(argv, APPLY_SPEC);
  if (a.help) { say(helpFor(APPLY_SPEC, "usage: tardis apply [FILE|-] [options]   (no FILE = the clipboard)")); return 0; }
  const src = a._[0];
  let text;
  if (src === '-') text = fs.readFileSync(0, 'utf8');
  else if (src) { if (!fs.existsSync(src)) throw new core.TardisError(`File not found: ${src}`); text = core.decode(fs.readFileSync(src)); }
  else { text = (await clip.readClipboard()) || ''; if (!text.trim()) throw new core.TardisError('The clipboard is empty. Copy the AI reply first, or pass a file.'); }
  const root = path.resolve((a.to || '.').replace(/^~(?=$|[/\\])/, os.homedir()));
  const { changes, info } = applyLib.parseReply(text, await core.listFiles(root));
  const planned = await applyLib.evaluateChanges(changes, root);
  if (!planned.length) throw new core.TardisError('No file changes found in that text. TARDIS looks for "### FILE: path" followed by a code block.');
  say(); say(`  Changes found for ${root}:`); say();
  for (const p of planned) {
    say(`   ${p.ok ? ' ' : '!'} ${STATUS_LABEL[p.status].padEnd(11)} ${p.path}  ${p.added || p.removed ? `+${p.added} -${p.removed}` : ''}`);
    for (const n of p.notes) say(`       note: ${n}`);
  }
  if (info.skipped) say(`  (${info.skipped} code block(s) without a file name were ignored)`);
  if (info.unsupported.length) say(`  (diff-style blocks are not supported - ask for complete files or EDIT blocks: ${info.unsupported.slice(0, 5).join(', ')})`);
  for (const pr of info.problems) say(`  problem: ${pr}`);
  say();
  const todo = planned.filter((p) => ['new', 'modified', 'delete'].includes(p.status) && (p.ok || a.all));
  if (a['dry-run'] || !todo.length) { say(todo.length ? '  Dry run - nothing written.' : '  Nothing to apply.'); return 0; }
  if (!a.yes) {
    if (src === '-' || !process.stdin.isTTY) throw new core.TardisError('Cannot ask for confirmation here - add --yes.');
    for (;;) {
      const ans = (await ask(`  Apply ${core.plural(todo.length, 'change')}? [y]es / [n]o / [d]iff: `)).trim().toLowerCase();
      if (ans.startsWith('d')) { for (const p of todo) console.log(applyLib.diffPreview(p).join('\n')); continue; }
      if (!ans.startsWith('y')) { say('  Nothing written.'); return 1; }
      break;
    }
  }
  const { done, backup } = await applyLib.applyChanges(todo, root);
  say(`  Fantastic! ${core.plural(done, 'change')} applied. Originals are in ${backup}  ("tardis undo" reverts).`);
  return 0;
}

async function cmdUndo(argv) {
  const root = path.resolve(argv[0] || '.');
  const { n, name } = await applyLib.undoLast(root);
  say(name ? `  Timey-wimey! Apply ${name} undone (${core.plural(n, 'file')} restored).` : '  Nothing to undo here.');
  return name ? 0 : 1;
}

/** Right-click "Pack with TARDIS" (Windows registry, GNOME/KDE files, macOS hint). */
async function cmdMenu(argv) {
  const remove = ['remove', 'uninstall'].includes(argv[0]);
  const script = path.resolve(__filename), node = process.execPath;
  if (process.platform === 'win32') {
    const { execFileSync } = require('child_process');
    for (const [key, arg] of [['HKCU\\Software\\Classes\\Directory\\shell\\TARDIS', '%1'], ['HKCU\\Software\\Classes\\Directory\\Background\\shell\\TARDIS', '%V']]) {
      if (remove) { try { execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' }); } catch { /* absent */ } continue; }
      execFileSync('reg', ['add', key, '/ve', '/d', 'Pack with TARDIS', '/f'], { stdio: 'ignore' });
      execFileSync('reg', ['add', key + '\\command', '/ve', '/d', `"${node}" "${script}" --gui "${arg}"`, '/f'], { stdio: 'ignore' });
    }
    say(remove ? '  Removed the Explorer right-click entry.' : '  Done. Right-click any folder in Explorer -> "Pack with TARDIS".');
  } else if (process.platform === 'darwin') {
    say('  macOS needs one manual step: Automator -> new "Quick Action" -> "Workflow receives: folders in Finder" -> "Run Shell Script" (pass input: as arguments) with:');
    say(`      "${node}" "${script}" --gui "$1"`);
    say('  Save it as "Pack with TARDIS".');
  } else {
    const nautilus = path.join(os.homedir(), '.local/share/nautilus/scripts/Pack with TARDIS');
    const dolphin = path.join(os.homedir(), '.local/share/kio/servicemenus/tardis.desktop');
    if (remove) { for (const f of [nautilus, dolphin]) { try { fs.unlinkSync(f); } catch { /* absent */ } } say('  Removed the file-manager entries.'); return 0; }
    fs.mkdirSync(path.dirname(nautilus), { recursive: true });
    fs.writeFileSync(nautilus, `#!/bin/sh\nexec "${node}" "${script}" --gui "\${1:-$PWD}"\n`, { mode: 0o755 });
    fs.mkdirSync(path.dirname(dolphin), { recursive: true });
    fs.writeFileSync(dolphin, `[Desktop Entry]\nType=Service\nMimeType=inode/directory;\nActions=tardis\n\n[Desktop Action tardis]\nName=Pack with TARDIS\nExec="${node}" "${script}" --gui %f\n`, { mode: 0o755 });
    say('  Done. GNOME Files: right-click -> Scripts -> "Pack with TARDIS". KDE Dolphin: right-click -> "Pack with TARDIS".');
  }
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    const cmd = argv[0];
    if (cmd === 'apply') return await cmdApply(argv.slice(1));
    if (cmd === 'undo') return await cmdUndo(argv.slice(1));
    if (cmd === 'menu') return await cmdMenu(argv.slice(1));
    if (cmd === 'templates') { for (const [k, v] of Object.entries(await state.allTemplates())) console.log(`${k}\n    ${v}\n`); return 0; }
    return await cmdPack(cmd === 'pack' || cmd === 'gui' || cmd === 'serve' ? argv.slice(1) : argv);
  } catch (err) {
    if (err instanceof core.TardisError) { say(`Error: ${err.message}`); return 2; }
    console.error(err); return 1;
  }
}
if (require.main === module) main().then((code) => { if (typeof code === 'number') process.exitCode = code; });
module.exports = { main, parseArgs };
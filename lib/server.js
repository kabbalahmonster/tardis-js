'use strict';
/**
 * @file lib/server.js — the local HTTP server behind the GUI.
 *
 * Binds to 127.0.0.1 only. Every API call must carry the random token that
 * was minted at start-up (sent as the X-Tardis-Token header, or ?t= for
 * downloads), so a web page you happen to have open cannot read your files.
 *
 * The server keeps ONE session in memory: the current scan, its document and
 * an optional file watcher. The GUI is stateless apart from the selection.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const core = require('./core');
const apply = require('./apply');
const state = require('./state');

const UI_DIR = path.join(__dirname, '..', 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

class Session {
  constructor() {
    this.scan = null; this.doc = null; this.options = null; this.selection = {};
    this.source = ''; this.seq = 0; this.progress = { busy: false, message: '' };
    this.watcher = null; this.changed = false; this.remotes = new Map();
  }
}

const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 200 * 1024 * 1024) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});
const expand = (p) => String(p || '').replace(/^~(?=$|[/\\])/, os.homedir());

/** Plain-data summary of a document for the UI (no full text). */
function docSummary(doc, partIndex = 0, previewLimit = 400000) {
  const items = {};
  for (const it of doc.items) items[it.e.rel] = { mode: it.mode, note: it.note, code: it.code, auto: it.auto, label: it.label, pinned: it.pinned };
  const text = doc.parts[Math.min(partIndex, doc.parts.length - 1)] || '';
  return {
    tokens: doc.tokens, partTokens: doc.partTokens, parts: doc.parts.length, items,
    filesFull: doc.filesFull, filesCondensed: doc.filesCondensed, filesOff: doc.filesOff,
    lines: doc.lines, secrets: doc.secrets.slice(0, 20), redacted: doc.redacted, anchors: doc.anchors,
    fileTokens: doc.fileTokens, budget: doc.budget, overBudget: doc.overBudget, trimmed: doc.trimmed,
    squeezed: doc.squeezed, counter: doc.counter, languages: doc.languages,
    preview: { index: Math.min(partIndex, doc.parts.length - 1), text: text.slice(0, previewLimit), truncated: text.length > previewLimit, length: text.length },
  };
}

function startWatch(ses) {
  stopWatch(ses);
  if (!ses.scan || core.isRemote(ses.source)) return false;
  try {
    ses.watcher = fs.watch(ses.scan.root, { recursive: true }, (_ev, name) => {
      const rel = String(name || '').replace(/\\/g, '/');
      if (/^\.(git|tardis)(\/|$)/.test(rel) || /node_modules/.test(rel) || core.SNAPSHOT_RE && false) return;
      ses.changed = true;
    });
    ses.watcher.on('error', () => stopWatch(ses));
    return true;
  } catch { ses.watcher = null; return false; }
}
function stopWatch(ses) { if (ses.watcher) { try { ses.watcher.close(); } catch { /* ignore */ } ses.watcher = null; } }

/** Resolves a source (folder or URL) to a local folder, cloning if needed. */
async function resolveSource(ses, source, opts) {
  if (!core.isRemote(source)) return { root: expand(source), remote: '' };
  let got = ses.remotes.get(source);
  if (!got) { ses.progress.message = 'fetching the repository'; got = await core.cloneRemote(source, !!(opts.since || opts.at)); ses.remotes.set(source, got); }
  else if (opts.since || opts.at) await core.ensureHistory(got.root);
  return { root: got.root, remote: got.url };
}

/** All API routes. Each returns a JSON-serialisable object or throws. */
async function handleApi(ses, route, body) {
  switch (route) {
    case 'state': {
      const st = await state.loadState();
      return { recent: st.recent || [], templates: await state.allTemplates(), builtin: Object.keys(core.TEMPLATES), version: core.VERSION, home: os.homedir() };
    }
    case 'session': {                 // {action:'get'|'set', key, data}
      const st = await state.loadState();
      st.sessions = st.sessions || {};
      if (body.action === 'set') { st.sessions[body.key] = body.data; st.recent = [body.key].concat((st.recent || []).filter((r) => r !== body.key)).slice(0, 12); await state.saveState(st); return { ok: true }; }
      return { data: st.sessions[body.key] || null };
    }
    case 'templates': {               // {action:'save'|'delete', name, text}
      const st = await state.loadState();
      st.templates = st.templates || {};
      if (body.action === 'save') st.templates[body.name] = body.text; else delete st.templates[body.name];
      await state.saveState(st);
      return { templates: await state.allTemplates() };
    }
    case 'profiles': {                // {action:'list'|'save'|'delete', name, data}
      if (!ses.scan) return { profiles: {} };
      const profiles = await state.loadProfiles(ses.scan.root);
      if (body.action === 'save') { profiles[body.name] = body.data; await state.saveProfiles(ses.scan.root, profiles); }
      if (body.action === 'delete') { delete profiles[body.name]; await state.saveProfiles(ses.scan.root, profiles); }
      return { profiles };
    }
    case 'browse': {                  // {path} -> folders inside it
      let p = expand(body.path || os.homedir());
      if (!fs.existsSync(p)) p = os.homedir();
      p = path.resolve(p);
      const dirs = [];
      try { for (const d of await fsp.readdir(p, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith('.')) dirs.push({ name: d.name, path: path.join(p, d.name) }); } catch { /* unreadable */ }
      dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      const roots = process.platform === 'win32' ? 'CDEFGH'.split('').map((l) => `${l}:\\`).filter((d) => fs.existsSync(d)) : ['/'];
      return { path: p, parent: path.dirname(p) === p ? null : path.dirname(p), dirs, roots, home: os.homedir() };
    }
    case 'scan': {                    // {source, options, selection} -> scan + doc
      const seq = ++ses.seq;
      ses.progress = { busy: true, message: 'scanning' };
      try {
        const opts = core.mergeOptions(core.defaultOptions('.'), body.options || {});
        const { root, remote } = await resolveSource(ses, body.source, opts);
        opts.root = root; opts.source = remote;
        core.TOKENS.ensure();
        const scan = await core.scanProject(opts, { shouldStop: () => seq !== ses.seq, progress: (m) => { ses.progress.message = m; } });
        if (seq !== ses.seq) throw new core.ScanCancelled();
        ses.progress.message = 'building the document';
        const sel = body.selectionData ? state.expandSelection(body.selectionData, scan.entries) : (body.selection || {});
        for (const e of scan.entries) if (!e.skip) e.view(e.default, opts.redact, opts.line_numbers);
        const doc = await core.buildDocument(scan, opts, sel);
        ses.scan = scan; ses.doc = doc; ses.options = opts; ses.selection = sel; ses.source = body.source; ses.changed = false;
        if (ses.watcher) startWatch(ses);
        return { scan: { name: scan.name, root: scan.root, git: scan.git, refs: scan.refs, method: scan.method, hiddenSkipped: scan.hiddenSkipped, changes: scan.changes, deleted: scan.deleted, entries: scan.entries.map((e) => e.toJSON()) }, selection: sel, doc: docSummary(doc) };
      } finally { if (seq === ses.seq) ses.progress = { busy: false, message: '' }; }
    }
    case 'build': {                   // {options, selection, part} -> doc
      if (!ses.scan) throw new core.TardisError('Scan a project first.');
      const opts = { ...ses.options, ...core.pickOptions(core.mergeOptions(ses.options, body.options || {})) };
      ses.selection = body.selection || {};
      ses.options = opts;
      ses.doc = await core.buildDocument(ses.scan, opts, ses.selection);
      return { doc: docSummary(ses.doc, body.part || 0), entries: ses.scan.entries.map((e) => e.toJSON()) };
    }
    case 'part': {                    // {index} -> full text of one part
      if (!ses.doc) throw new core.TardisError('Nothing to copy yet.');
      return { text: ses.doc.parts[body.index || 0] || '' };
    }
    case 'preview': {                 // {index} -> truncated text of one part
      if (!ses.doc) throw new core.TardisError('Nothing to preview yet.');
      return docSummary(ses.doc, body.index || 0).preview;
    }
    case 'focus': {                   // {rels, importers, mode:'focus'|'add'|'importers'}
      if (!ses.scan) throw new core.TardisError('Scan a project first.');
      const byRel = new Map(ses.scan.entries.map((e) => [e.rel, e]));
      const starts = (body.rels || []).filter((r) => byRel.has(r));
      for (const r of starts) await byRel.get(r).load();
      ses.scan._graph = null;
      const graph = ses.scan.importGraph();
      if (body.mode === 'focus') { const { sel, keep } = core.focusSelection(ses.scan, starts); return { selection: sel, count: keep.size - starts.length }; }
      const startSet = new Set(starts);
      const extra = body.mode === 'add' ? [...core.importClosure(graph, startSet)].filter((r) => !startSet.has(r))
        : Object.entries(graph).filter(([, t]) => [...t].some((x) => startSet.has(x))).map(([src]) => src);
      return { related: extra };
    }
    case 'watch': {                   // {on}
      if (body.on) return { on: startWatch(ses) };
      stopWatch(ses); return { on: false };
    }
    case 'status': return { busy: ses.progress.busy, message: ses.progress.message, changed: ses.changed, watching: !!ses.watcher };
    case 'apply/analyze': {           // {to, text} -> planned changes with diffs
      const root = expand(body.to);
      const known = ses.scan && path.resolve(root) === ses.scan.root ? new Set(ses.scan.entries.map((e) => e.rel)) : await core.listFiles(root);
      const { changes, info } = apply.parseReply(body.text || '', known);
      const planned = await apply.evaluateChanges(changes, root);
      return { info, planned: planned.map((p) => ({ path: p.path, status: p.status, notes: p.notes, ok: p.ok, added: p.added, removed: p.removed, diff: apply.diffPreview(p).slice(0, 4000) })) };
    }
    case 'apply/run': {               // {to, text, paths} -> applies the chosen ones
      const root = expand(body.to);
      const known = await core.listFiles(root);
      const { changes } = apply.parseReply(body.text || '', known);
      const planned = (await apply.evaluateChanges(changes, root)).filter((p) => (body.paths || []).includes(p.path) && ['new', 'modified', 'delete'].includes(p.status));
      const { done, backup } = await apply.applyChanges(planned, root);
      ses.changed = true;
      return { done, backup: path.basename(backup) };
    }
    case 'apply/undo': { const r = await apply.undoLast(expand(body.to)); ses.changed = true; return r; }
    default: throw new core.TardisError(`Unknown API route: ${route}`);
  }
}

/** Opens the default browser on a URL (best effort). */
function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* the URL is printed anyway */ }
}

/**
 * Starts the server. Resolves to {url, close}. `initial` is a folder or URL
 * to preload; `open` controls whether a browser tab is opened.
 */
function startServer({ port = 0, open = true, initial = '' } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const ses = new Session();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/api/')) {
        const given = req.headers['x-tardis-token'] || url.searchParams.get('t');
        if (given !== token) return json(res, 403, { ok: false, error: 'Bad token - reopen TARDIS from the terminal.' });
        const route = url.pathname.slice(5);
        if (route === 'download') {               // GET: a part as a file
          if (!ses.doc) return json(res, 400, { ok: false, error: 'Nothing to download yet.' });
          const k = parseInt(url.searchParams.get('part') || '0', 10);
          const ext = core.FORMAT_EXT[ses.options.fmt] || '.md';
          const name = (ses.scan.name.replace(/[^\w.-]+/g, '_') || 'project') + '.tardis' + (ses.doc.parts.length > 1 ? `.part${k + 1}` : '') + ext;
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
          return res.end(ses.doc.parts[k] || '');
        }
        const body = req.method === 'POST' ? await readBody(req) : {};
        const data = await handleApi(ses, route, body);
        return json(res, 200, { ok: true, ...data });
      }
      // static UI
      let file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      file = path.join(UI_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(UI_DIR) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      if (err instanceof core.ScanCancelled) return json(res, 200, { ok: false, cancelled: true });
      const known = err instanceof core.TardisError;
      if (!known) console.error(err);
      return json(res, known ? 400 : 500, { ok: false, error: known ? err.message : `${err.name}: ${err.message}` });
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?t=${token}` + (initial ? `&src=${encodeURIComponent(initial)}` : '');
      if (open) openBrowser(url);
      resolve({ url, close: () => { stopWatch(ses); server.close(); } });
    });
  });
}

module.exports = { startServer };
'use strict';
/**
 * @file ui/app.js — the TARDIS GUI.
 *
 * The browser keeps only view state (the selection map, what is expanded,
 * which part is shown). Every heavy operation is one POST to the local
 * server, which holds the scan and builds the document.
 *
 * Sections: API wrapper · state · tab 1 controls · scanning · tree ·
 * preview · copy/download · profiles/templates · tab 2 (apply) ·
 * folder picker · misc (context menu, toasts, shortcuts).
 */

// ----- API wrapper --------------------------------------------------------
const params = new URLSearchParams(location.search);
const TOKEN = params.get('t') || sessionStorage.getItem('tardis-token') || '';
sessionStorage.setItem('tardis-token', TOKEN);
const INITIAL = params.get('src') || '';
history.replaceState(null, '', location.pathname);      // keep the token out of the URL bar

async function api(route, body = {}) {
  const res = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tardis-Token': TOKEN }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (data.cancelled) throw Object.assign(new Error('cancelled'), { cancelled: true });
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}
const $ = (sel) => document.querySelector(s(sel));
const s = (x) => (x.startsWith('#') || x.startsWith('.') ? x : '#' + x);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, w) => `${fmtInt(n)} ${w}${n === 1 ? '' : 's'}`;
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// ----- state ---------------------------------------------------------------
const S = {
  source: '', key: '', scan: null, entries: [], byRel: new Map(), doc: null,
  sel: {}, pendingSel: null, open: new Set(), sortBy: 'name', part: 0, selectedRel: null,
  templates: {}, builtin: [], recent: [], busy: false, watching: false,
  apply: { planned: [], ticks: {}, selected: null, raw: '' },
};
const OPTION_IDS = ['include_hidden', 'use_ignore', 'include_locks', 'include_secrets', 'redact', 'line_numbers', 'tree_only', 'include_diff', 'reply_format'];

function readOptions() {
  const o = {};
  for (const id of OPTION_IDS) o[id] = $(id).checked;
  o.max_size_kb = Math.max(1, parseInt($('max_size_kb').value, 10) || 256);
  o.exclude_globs = splitGlobs($('exclude_globs').value);
  o.include_globs = splitGlobs($('include_globs').value);
  o.omit_globs = []; o.condense_globs = [];
  o.fmt = $('fmt').value;
  o.budget = parseTokens($('budget').value);
  o.over = document.querySelector('input[name=over]:checked').value;
  const mode = $('time').value, ref = ($('ref').value.trim().split(/\s+/)[0] || '');
  o.since = mode === 'since' ? ref : '';
  o.at = mode === 'at' ? ref : '';
  o.task = $('task').value.trim();
  return o;
}
function writeOptions(o) {
  for (const id of OPTION_IDS) if (id in o) $(id).checked = !!o[id];
  if (o.max_size_kb) $('max_size_kb').value = o.max_size_kb;
  $('exclude_globs').value = (o.exclude_globs || []).join(', ');
  $('include_globs').value = (o.include_globs || []).join(', ');
  $('fmt').value = o.fmt || 'markdown';
  $('budget').value = formatTokens(o.budget || 0);
  document.querySelector(`input[name=over][value=${o.over === 'split' ? 'split' : 'trim'}]`).checked = true;
  $('time').value = o.since ? 'since' : o.at ? 'at' : 'now';
  $('ref').value = o.since || o.at || '';
  $('task').value = o.task || '';
  syncTime();
}
const splitGlobs = (v) => v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
function parseTokens(v) {
  const t = String(v).trim().toLowerCase().replace(/[, _]/g, '');
  if (!t || ['0', 'none', 'nolimit', 'off'].includes(t)) return 0;
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(t);
  return m ? Math.round(parseFloat(m[1]) * { '': 1, k: 1e3, m: 1e6 }[m[2]]) : 0;
}
const formatTokens = (n) => (!n ? 'No limit' : n % 1e6 === 0 ? `${n / 1e6}M` : n % 1e3 === 0 ? `${n / 1e3}k` : String(n));

// ----- status / toasts -----------------------------------------------------
function status(msg, kind = '') { const e = $('status'); e.textContent = msg; e.className = 'status ' + kind; }
function toast(msg, err = false) { const t = el('div', 'toast' + (err ? ' err' : ''), msg); $('toasts').appendChild(t); setTimeout(() => t.remove(), 4200); }

// ----- scanning ------------------------------------------------------------
let pollTimer = null;
function pollProgress() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!S.busy) return;
    try { const st = await api('status'); if (st.busy) status(`Vworp… vworp… ${st.message || 'scanning'}.`, 'busy'); } catch { /* ignore */ }
    pollProgress();
  }, 400);
}

/** Opens a project: restores its saved session, then scans. */
async function openProject(source) {
  source = source.trim().replace(/^"|"$/g, '');
  if (!source) return;
  const remote = /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/|gh:)|^(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//.test(source);
  if (source !== S.key) {
    await saveSession();
    S.key = source; S.sel = {}; S.pendingSel = null; S.part = 0; S.open = new Set();
    $('profile').value = '';
    if (!remote) {
      try { const { data } = await api('session', { action: 'get', key: source }); if (data) { writeOptions(data.options || {}); S.pendingSel = data.selection || null; } } catch { /* fine */ }
    }
    if (!remote) $('apply-to').value = source;
  }
  S.source = source;
  await scan();
}

async function scan() {
  if (!S.source) return;
  S.busy = true; status('Vworp… vworp… scanning the project.', 'busy'); pollProgress();
  try {
    const body = { source: S.source, options: readOptions() };
    if (S.pendingSel) body.selectionData = S.pendingSel; else body.selection = S.sel;
    const r = await api('scan', body);
    S.pendingSel = null;
    S.scan = r.scan; S.sel = r.selection || {}; S.doc = r.doc; S.part = Math.min(S.part, r.doc.parts - 1);
    setEntries(r.scan.entries);
    $('ref-list').replaceChildren(...r.scan.refs.map((x) => Object.assign(el('option'), { value: x })));
    if (!S.open.size) for (const e of S.entries) { const top = e.rel.split('/')[0]; if (e.rel.includes('/')) S.open.add(top); }
    renderTree(); renderPreview(); renderStats(); afterDoc();
    await refreshProfiles();
    if ($('watch').checked) await api('watch', { on: true });
    await saveSession();
  } catch (err) {
    if (!err.cancelled) status(err.message, 'err');
  } finally { S.busy = false; clearTimeout(pollTimer); }
}
function setEntries(entries) { S.entries = entries; S.byRel = new Map(entries.map((e) => [e.rel, e])); }

/** Re-renders the document after a tick / option change (no rescan). */
const build = debounce(async () => {
  if (!S.scan) return;
  try {
    const r = await api('build', { options: readOptions(), selection: S.sel, part: S.part });
    S.doc = r.doc; setEntries(r.entries); S.part = Math.min(S.part, r.doc.parts - 1);
    refreshRows(); renderPreview(); renderStats(); afterDoc();
  } catch (err) { status(err.message, 'err'); }
}, 150);

function afterDoc() {
  const d = S.doc, n = d.parts;
  if (d.secrets.length && !d.redacted) { const [rel, line, kind] = d.secrets[0]; status(`Spoilers! Possible ${kind} in ${rel}:${line}${d.secrets.length > 1 ? ` (+${d.secrets.length - 1} more)` : ''} — tick "Redact secrets" or check before you share.`, 'err'); }
  else if (d.overBudget) status('Still over budget: everything TARDIS may trim is gone. Untick more, raise the budget, or choose "Split into parts".', 'err');
  else if (!S.entries.length) status('Hmm. Nothing to pack here — check the folder and the filters.', 'err');
  else {
    let msg = `Fantastic! ${plural(d.filesFull + d.filesCondensed, 'file')} folded into ${n > 1 ? `${n} parts.` : 'one document.'}`;
    if (d.trimmed || d.squeezed) msg += ` To fit the budget: ${d.squeezed} condensed, ${d.trimmed} left out (orange rows).`;
    if (d.redacted) msg += ` ${plural(d.redacted, 'secret')} redacted.`;
    if (S.scan.hiddenSkipped) msg += ` ${plural(S.scan.hiddenSkipped, 'hidden item')} stayed behind the perception filter.`;
    status(msg);
  }
}

// ----- tree ----------------------------------------------------------------
const intent = (e) => S.sel[e.rel] || (e.skip ? 'off' : e.default);
const checkable = (e) => !e.skip || e.forceable;
function choose(e, mode) { if (mode === null) delete S.sel[e.rel]; else S.sel[e.rel] = mode; }

/** Builds the nested structure and renders expanded nodes only. */
function renderTree() {
  const find = $('find').value.trim().toLowerCase();
  const ftok = S.doc ? S.doc.fileTokens : {};
  const mk = () => ({ dirs: new Map(), files: [], tok: 0 });
  const top = mk();
  for (const e of S.entries) {
    if (find && !e.rel.toLowerCase().includes(find)) continue;
    const t = ftok[e.rel] || 0;
    let node = top; node.tok += t;
    const parts = e.rel.split('/');
    for (const d of parts.slice(0, -1)) { if (!node.dirs.has(d)) node.dirs.set(d, mk()); node = node.dirs.get(d); node.tok += t; }
    node.files.push(e);
  }
  const total = Math.max(1, Object.values(ftok).reduce((a, b) => a + b, 0));
  const container = $('tree');
  container.replaceChildren();
  const addNode = (node, parent, prefix) => {
    let rows = node.files.map((e) => ({ kind: 'f', name: e.rel.split('/').pop(), e, tok: ftok[e.rel] || 0 }));
    rows = rows.concat([...node.dirs.entries()].map(([name, sub]) => ({ kind: 'd', name, sub, tok: sub.tok })));
    if (S.sortBy === 'tokens') rows.sort((a, b) => b.tok - a.tok);
    for (const r of rows) {
      if (r.kind === 'f') { parent.appendChild(fileRow(r.e, total)); continue; }
      const drel = prefix + r.name;
      const wrap = el('div');
      const row = el('div', 'row dir');
      row.dataset.dir = drel;
      const isOpen = !!find || S.open.has(drel);
      const name = el('span', 'name');
      const caret = el('span', 'caret', isOpen ? '▾' : '▸');
      const cb = el('input'); cb.type = 'checkbox';
      name.append(caret, cb, el('span', '', r.name + '/'));
      row.append(name, el('span', 'tok'), el('span', 'bar'), el('span', 'info'));
      wrap.appendChild(row);
      const kids = el('div', 'children');
      wrap.appendChild(kids);
      parent.appendChild(wrap);
      caret.onclick = () => { if (S.open.has(drel)) S.open.delete(drel); else S.open.add(drel); renderTree(); };
      cb.onchange = () => toggleDir(drel, cb.checked);
      row.oncontextmenu = (ev) => openMenu(ev, drel, true);
      if (isOpen) addNode(r.sub, kids, drel + '/'); else kids.classList.add('hidden');
      paintDir(row, r.sub, total);
    }
  };
  addNode(top, container, '');
  refreshRows();
}
function fileRow(e, total) {
  const row = el('div', 'row file');
  row.dataset.rel = e.rel;
  const name = el('span', 'name');
  const cb = el('input'); cb.type = 'checkbox'; cb.disabled = !checkable(e);
  name.append(el('span', 'caret', ''), cb, el('span', '', e.rel.split('/').pop()));
  row.append(name, el('span', 'tok'), el('span', 'bar'), el('span', 'info'));
  cb.onchange = () => { if (intent(e) !== 'off') choose(e, 'off'); else choose(e, e.skip ? 'full' : null); refreshRows(); build(); };
  row.onclick = (ev) => { if (ev.target === cb) return; S.selectedRel = e.rel; document.querySelectorAll('.row.selected').forEach((x) => x.classList.remove('selected')); row.classList.add('selected'); jumpTo(e.rel); };
  row.oncontextmenu = (ev) => openMenu(ev, e.rel, false);
  return row;
}
/** Updates ticks, tokens, bars and notes in place after a build. */
function refreshRows() {
  const ftok = S.doc ? S.doc.fileTokens : {}, items = S.doc ? S.doc.items : {};
  const total = Math.max(1, Object.values(ftok).reduce((a, b) => a + b, 0));
  for (const row of document.querySelectorAll('.row.file')) {
    const e = S.byRel.get(row.dataset.rel);
    if (!e) continue;
    const it = items[e.rel], tok = ftok[e.rel] || 0, mode = intent(e);
    const cb = row.querySelector('input');
    cb.checked = checkable(e) && mode !== 'off';
    const badge = row.querySelector('.badge');
    if (mode === 'condensed' && checkable(e)) { if (!badge) row.querySelector('.name').appendChild(el('span', 'badge', 'condensed')); }
    else if (badge) badge.remove();
    row.querySelector('.tok').textContent = tok ? fmtInt(tok) : '';
    paintBar(row, tok, total);
    let info = e.note, cls = 'row file';
    if (it && !readOptions().tree_only) {
      if (it.auto && it.mode === 'off') { info = 'trimmed to fit budget'; cls += ' budget'; }
      else if (it.auto) { info = 'condensed to fit budget'; cls += ' budget'; }
      else if (it.mode === 'condensed') info = it.label || 'condensed';
      else if (it.mode === 'off') { info = it.note; cls += ' omit'; }
      else info = it.note || e.change || '';
    } else if (e.skip) cls += ' omit';
    if (S.selectedRel === e.rel) cls += ' selected';
    row.querySelector('.info').textContent = info;
    row.className = cls + heatClass(tok, total);
  }
  for (const row of document.querySelectorAll('.row.dir')) {
    const prefix = row.dataset.dir + '/';
    let tok = 0, tot = 0, on = 0;
    for (const e of S.entries) if (e.rel.startsWith(prefix)) { tok += ftok[e.rel] || 0; if (checkable(e)) { tot++; if (intent(e) !== 'off') on++; } }
    const cb = row.querySelector('input');
    cb.checked = tot > 0 && on === tot; cb.indeterminate = on > 0 && on < tot; cb.disabled = tot === 0;
    row.querySelector('.tok').textContent = tok ? fmtInt(tok) : '';
    paintBar(row, tok, total);
    row.className = 'row dir' + heatClass(tok, total);
  }
}
const paintDir = () => {};
function paintBar(row, tok, total) { const share = tok / total; row.querySelector('.bar').textContent = tok ? '█'.repeat(Math.max(1, Math.round(share * 10))) + (share >= 0.03 ? ` ${(share * 100).toFixed(0)}%` : '') : ''; }
function heatClass(tok, total) { const sh = tok / total; return sh >= 0.2 ? ' hot3' : sh >= 0.08 ? ' hot2' : sh >= 0.03 ? ' hot1' : ''; }
function toggleDir(drel, on) {
  const files = S.entries.filter((e) => e.rel.startsWith(drel + '/') && checkable(e));
  for (const e of files) choose(e, on && !e.skip ? null : on ? null : 'off');   // folders never force withheld files in
  refreshRows(); build();
}

// ----- context menu --------------------------------------------------------
let menuTarget = null;
function openMenu(ev, target, isDir) {
  ev.preventDefault();
  menuTarget = { target, isDir };
  const m = $('ctx');
  m.classList.remove('hidden');
  m.style.left = Math.min(ev.clientX, window.innerWidth - 280) + 'px';
  m.style.top = Math.min(ev.clientY, window.innerHeight - 220) + 'px';
}
document.addEventListener('click', () => $('ctx').classList.add('hidden'));
$('ctx').addEventListener('click', async (ev) => {
  const act = ev.target.dataset.act;
  if (!act || !menuTarget) return;
  const { target, isDir } = menuTarget;
  const files = S.entries.filter((e) => checkable(e) && (isDir ? e.rel.startsWith(target + '/') : e.rel === target));
  if (['full', 'condensed', 'off', 'auto'].includes(act)) { for (const e of files) choose(e, act === 'auto' ? null : act); }
  else {
    try {
      const r = await api('focus', { rels: files.map((e) => e.rel), mode: act });
      if (act === 'focus') { S.sel = r.selection; toast(`Focus: ${files.length} selected + ${r.count} imported file(s).`); }
      else { for (const rel of r.related.concat(files.map((e) => e.rel))) { const e = S.byRel.get(rel); if (e && checkable(e)) choose(e, e.skip ? 'full' : null); } toast(r.related.length ? `${r.related.length} related file(s) ticked.` : 'No local imports found for that selection.'); }
    } catch (err) { toast(err.message, true); }
  }
  refreshRows(); build();
});

// ----- preview -------------------------------------------------------------
function renderPreview() {
  const pv = S.doc.preview, pre = $('preview');
  const partSel = $('part');
  if (S.doc.parts > 1) {
    partSel.classList.remove('hidden');
    partSel.replaceChildren(...S.doc.partTokens.map((t, i) => Object.assign(el('option', '', `Part ${i + 1} of ${S.doc.parts}  (~${fmtInt(t)} tokens)`), { value: i })));
    partSel.value = pv.index;
    $('copy').textContent = `Copy part ${pv.index + 1} of ${S.doc.parts}`;
  } else { partSel.classList.add('hidden'); $('copy').textContent = 'Copy to clipboard (Allons-y!)'; }
  // wrap file headings so we can jump to them
  const anchors = Object.entries(S.doc.anchors).filter(([, [p]]) => p === pv.index);
  let html = escapeHtml(pv.text);
  for (const [rel, [, anchor]] of anchors) {
    const needle = escapeHtml(anchor);
    const i = html.indexOf(needle);
    if (i >= 0) html = html.slice(0, i) + `<span class="anchor" data-rel="${escapeHtml(rel)}">${needle}</span>` + html.slice(i + needle.length);
  }
  if (pv.truncated) html += `\n\n<span class="anchor">[Preview stops here. The full text is ${fmtInt(pv.length)} characters and is copied / downloaded in full.]</span>`;
  pre.innerHTML = html;
}
const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
async function jumpTo(rel) {
  if (!S.doc || !S.doc.anchors[rel]) return;
  const [part] = S.doc.anchors[rel];
  if (part !== S.part) { S.part = part; await showPart(part); }
  const span = $('preview').querySelector(`.anchor[data-rel="${CSS.escape(rel)}"]`);
  if (span) { span.scrollIntoView({ block: 'start' }); document.querySelectorAll('.preview mark').forEach((m) => m.replaceWith(...m.childNodes)); const mark = el('mark'); span.parentNode.insertBefore(mark, span); mark.appendChild(span); }
  else status('That file is past the end of the preview — the full document still contains it.');
}
async function showPart(i) { S.part = i; try { const pv = await api('preview', { index: i }); S.doc.preview = pv; renderPreview(); } catch (err) { toast(err.message, true); } }
$('part').onchange = () => showPart(parseInt($('part').value, 10));

function renderStats() {
  const d = S.doc, limit = d.budget || 200000;
  const fill = $('meter-fill');
  fill.style.width = Math.min(100, d.tokens * 100 / limit) + '%';
  fill.classList.toggle('over', d.overBudget);
  const files = `${plural(d.filesFull + d.filesCondensed, 'file')}${d.filesCondensed ? ` (${d.filesCondensed} condensed)` : ''}`;
  const size = d.budget ? `~${fmtInt(d.tokens)} / ${fmtInt(d.budget)} tokens` : `~${fmtInt(d.tokens)} tokens (${(d.tokens * 100 / 200000).toFixed(0)}% of a 200k context)`;
  $('stats').textContent = `${size}   |   ${files}   |   ${plural(d.lines, 'line')}`;
  const colors = ['#1b5e9e', '#2e8b57', '#b45309', '#7b3fa0', '#b00020', '#607d8b'];
  $('langs').replaceChildren(...d.languages.slice(0, 6).map(([name, pct], i) => { const sp = el('span', '', `${name} ${pct.toFixed(0)}%`); sp.style.width = Math.max(8, pct * 2) + 'px'; sp.style.background = colors[i]; sp.title = `${name}: ${pct.toFixed(1)}% of included lines`; return sp; }));
}

// ----- copy / download -----------------------------------------------------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = el('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}
$('copy').onclick = async () => {
  if (!S.doc) return toast('Nothing to pack yet — pick a project folder first.', true);
  const n = S.doc.parts, k = S.part;
  try {
    const { text } = await api('part', { index: k });
    if (!(await copyText(text))) return toast('Could not reach the clipboard — use Download instead.', true);
    if (n === 1) toast(`Geronimo! ~${fmtInt(S.doc.tokens)} tokens copied. Paste away — then bring the reply to tab 2.`);
    else if (k + 1 < n) { await showPart(k + 1); toast(`Part ${k + 1} of ${n} copied. Paste it, then click again for part ${k + 2}.`); }
    else { await showPart(0); toast(`Part ${n} of ${n} copied — that was the last one.`); }
    await saveSession();
  } catch (err) { toast(err.message, true); }
};
$('download').onclick = () => { if (!S.doc) return; for (let k = 0; k < S.doc.parts; k++) { const a = el('a'); a.href = `/api/download?t=${TOKEN}&part=${k}`; a.download = ''; a.click(); } };

// ----- sessions, profiles, templates --------------------------------------
async function saveSession() {
  if (!S.key || !S.scan || /^(?:https?:|git@|ssh:|git:|gh:|github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)/.test(S.key)) return;
  try { await api('session', { action: 'set', key: S.key, data: { options: readOptions(), selection: compressSelection() } }); } catch { /* fine */ }
}
/** Mirrors lib/state.js compressSelection so sessions stay compact. */
function compressSelection() {
  const total = {}, off = {};
  for (const e of S.entries) {
    if (!checkable(e)) continue;
    const parts = e.rel.split('/');
    for (let i = 1; i < parts.length; i++) { const d = parts.slice(0, i).join('/') + '/'; total[d] = (total[d] || 0) + 1; if (S.sel[e.rel] === 'off') off[d] = (off[d] || 0) + 1; }
  }
  const dead = new Set(Object.keys(total).filter((d) => off[d] === total[d]));
  const out = { full: [], condensed: [], off: [] };
  for (const [rel, mode] of Object.entries(S.sel)) {
    const parts = rel.split('/');
    if (mode === 'off' && parts.slice(1).some((_, i) => dead.has(parts.slice(0, i + 1).join('/') + '/'))) continue;
    out[mode].push(rel);
  }
  const parent = (d) => { const p = d.slice(0, -1); return p.includes('/') ? p.slice(0, p.lastIndexOf('/')) + '/' : ''; };
  out.off = [...dead].filter((d) => !dead.has(parent(d))).sort().concat(out.off);
  return out;
}
async function refreshProfiles() {
  const { profiles } = await api('profiles', { action: 'list' });
  const sel = $('profile');
  const current = sel.value;
  sel.replaceChildren(Object.assign(el('option', '', '(last session)'), { value: '' }), ...Object.keys(profiles).sort().map((n) => Object.assign(el('option', '', n), { value: n })));
  sel.value = current && profiles[current] ? current : '';
}
$('profile').onchange = async () => {
  const name = $('profile').value;
  if (!name || !S.scan) return;
  const { profiles } = await api('profiles', { action: 'list' });
  if (profiles[name]) { writeOptions(profiles[name].options || {}); S.pendingSel = profiles[name].selection || {}; await scan(); toast(`Profile "${name}" loaded.`); }
};
$('profile-save').onclick = async () => {
  if (!S.scan) return;
  const name = prompt('Save the current settings and ticks as a profile named:', $('profile').value);
  if (!name || !name.trim()) return;
  await api('profiles', { action: 'save', name: name.trim(), data: { options: readOptions(), selection: compressSelection() } });
  await refreshProfiles(); $('profile').value = name.trim();
  toast(`Profile "${name.trim()}" saved in .tardis.json (commit it to share it).`);
};
$('profile-delete').onclick = async () => {
  const name = $('profile').value;
  if (!name || !confirm(`Delete profile "${name}"?`)) return;
  await api('profiles', { action: 'delete', name }); await refreshProfiles(); toast(`Profile "${name}" deleted.`);
};
function renderTemplates() {
  const sel = $('template');
  sel.replaceChildren(Object.assign(el('option', '', '(no task – just the snapshot)'), { value: '' }), ...Object.keys(S.templates).map((n) => Object.assign(el('option', '', n), { value: n })));
}
$('template').onchange = () => { $('task').value = S.templates[$('template').value] || ''; build(); };
$('template-save').onclick = async () => {
  const text = $('task').value.trim();
  if (!text) return toast('Type a task first, then save it as a template.', true);
  const name = prompt('Name for this task template:');
  if (!name || !name.trim()) return;
  const r = await api('templates', { action: 'save', name: name.trim(), text });
  S.templates = r.templates; renderTemplates(); $('template').value = name.trim(); toast(`Task template "${name.trim()}" saved.`);
};

// ----- tab 1 control wiring ------------------------------------------------
function syncTime() {
  const mode = $('time').value;
  $('ref').disabled = mode === 'now';
  $('include_diff').disabled = mode !== 'since';
}
$('time').onchange = () => { if ($('time').value !== 'now' && !$('ref').value.trim()) { const first = $('ref-list').firstChild; $('ref').value = first ? first.value : 'HEAD'; } syncTime(); scan(); };
$('ref').onchange = () => scan();
for (const id of ['include_hidden', 'use_ignore', 'include_locks', 'include_secrets', 'max_size_kb']) $(id).onchange = () => scan();
for (const id of ['exclude_globs', 'include_globs']) $(id).onkeydown = (ev) => { if (ev.key === 'Enter') scan(); };
for (const id of ['redact', 'line_numbers', 'tree_only', 'include_diff', 'reply_format', 'fmt']) $(id).onchange = () => build();
$('budget').onchange = () => build();
document.querySelectorAll('input[name=over]').forEach((r) => { r.onchange = () => build(); });
$('task').oninput = debounce(() => build(), 500);
$('source').onkeydown = (ev) => { if (ev.key === 'Enter') openProject($('source').value); };
$('source').onchange = () => { if (S.recent.includes($('source').value)) openProject($('source').value); };
$('rescan').onclick = () => scan();
$('browse').onclick = () => pickFolder($('source').value).then((p) => { if (p) { $('source').value = p; openProject(p); } });
$('find').oninput = debounce(renderTree, 250);
$('sort').onclick = () => { S.sortBy = S.sortBy === 'tokens' ? 'name' : 'tokens'; $('sort').textContent = S.sortBy === 'tokens' ? 'Name' : 'Tokens ↓'; renderTree(); };
$('expand-all').onclick = () => { for (const e of S.entries) { const parts = e.rel.split('/'); for (let i = 1; i < parts.length; i++) S.open.add(parts.slice(0, i).join('/')); } renderTree(); };
$('collapse-all').onclick = () => { S.open.clear(); renderTree(); };
$('check-all').onclick = () => { for (const e of S.entries) if (checkable(e)) choose(e, null); refreshRows(); build(); };
$('check-none').onclick = () => { for (const e of S.entries) if (checkable(e)) choose(e, 'off'); refreshRows(); build(); };
$('watch').onchange = async () => {
  const r = await api('watch', { on: $('watch').checked });
  S.watching = r.on;
  if ($('watch').checked && !r.on) { toast('Watching is not available here (remote project, or the folder cannot be watched).', true); $('watch').checked = false; }
  if (r.on) watchLoop();
};
async function watchLoop() {
  while (S.watching) {
    await new Promise((r) => setTimeout(r, 1500));
    try { const st = await api('status'); if (!st.watching) { S.watching = false; $('watch').checked = false; break; } if (st.changed && !S.busy) { toast('Files changed — rescanning.'); await scan(); } } catch { break; }
  }
}

// ----- tabs ----------------------------------------------------------------
document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => { document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b)); document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab)); }; });

// ----- tab 2: apply --------------------------------------------------------
const LABELS = { new: 'New file', modified: 'Modified', delete: 'Delete', unchanged: 'No change', problem: "Can't apply" };
const analyze = debounce(async () => {
  const text = $('reply').value, to = $('apply-to').value.trim();
  const list = $('changes');
  list.replaceChildren(); $('diff').replaceChildren(); S.apply.planned = []; S.apply.ticks = {};
  if (!text.trim() || !to) { applySummary(); return; }
  try {
    const r = await api('apply/analyze', { to, text });
    S.apply.planned = r.planned;
    r.planned.forEach((p, i) => {
      const usable = ['new', 'modified', 'delete'].includes(p.status);
      S.apply.ticks[i] = usable && p.ok;
      const row = el('div', 'change' + (p.notes.length && (!p.ok || p.status === 'problem') ? ' warn' : '') + (p.status === 'unchanged' ? ' dim' : ''));
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = S.apply.ticks[i]; cb.disabled = !usable;
      cb.onchange = () => { S.apply.ticks[i] = cb.checked; applySummary(); };
      cb.onclick = (ev) => ev.stopPropagation();
      row.append(cb, el('span', '', p.path), el('span', '', LABELS[p.status] || p.status), el('span', '', p.added || p.removed ? `+${p.added} −${p.removed}` : ''), el('span', 'notes', p.notes.join('; ')));
      row.onclick = () => { S.apply.selected = i; document.querySelectorAll('.change').forEach((x) => x.classList.remove('selected')); row.classList.add('selected'); showDiff(p); };
      list.appendChild(row);
    });
    applySummary(r.info);
    const first = r.planned.findIndex((p) => ['new', 'modified', 'delete'].includes(p.status));
    if (first >= 0) list.children[first].click();
  } catch (err) { status(err.message, 'err'); }
}, 500);
function applySummary(info) {
  const n = Object.values(S.apply.ticks).filter(Boolean).length;
  $('apply-run').textContent = n ? `Apply ${plural(n, 'change')}` : 'Apply changes';
  const bits = [];
  const flagged = S.apply.planned.filter((p, i) => p.notes.length && !S.apply.ticks[i] && ['new', 'modified'].includes(p.status)).length;
  if (S.apply.planned.length) bits.push(`${plural(S.apply.planned.length, 'file')} found`);
  if (flagged) bits.push(`${flagged} flagged and unticked — read the notes`);
  if (info) { if (info.skipped) bits.push(`${info.skipped} code block(s) without a file name ignored`); if (info.unsupported.length) bits.push('diff-style blocks are not supported: ask for complete files or EDIT blocks'); bits.push(...info.problems.slice(0, 2)); }
  $('apply-summary').textContent = bits.join('  |  ');
}
function showDiff(p) {
  const pre = $('diff');
  pre.replaceChildren(...p.notes.map((n) => el('span', 'note', 'NOTE: ' + n + '\n')));
  const lines = p.status === 'unchanged' ? ['(identical to the file you already have)'] : p.diff;
  for (const ln of lines) pre.appendChild(el('span', ln.startsWith('@@') || ln.startsWith('+++') || ln.startsWith('---') ? 'hunk' : ln.startsWith('+') ? 'add' : ln.startsWith('-') ? 'del' : '', ln + '\n'));
}
$('reply').oninput = analyze;
$('apply-to').onchange = analyze;
$('reply-clear').onclick = () => { $('reply').value = ''; analyze(); };
$('reply-paste').onclick = async () => { try { $('reply').value = await navigator.clipboard.readText(); analyze(); } catch { $('reply').focus(); toast('Your browser would not share the clipboard — press Ctrl+V in the box instead.'); } };
$('apply-browse').onclick = () => pickFolder($('apply-to').value).then((p) => { if (p) { $('apply-to').value = p; analyze(); } });
$('apply-run').onclick = async () => {
  const paths = S.apply.planned.filter((p, i) => S.apply.ticks[i]).map((p) => p.path);
  if (!paths.length) return toast('Nothing is ticked to apply.', true);
  try {
    const r = await api('apply/run', { to: $('apply-to').value.trim(), text: $('reply').value, paths });
    toast(`Fantastic! ${plural(r.done, 'change')} applied. Originals are safe in .tardis/backups/${r.backup} — "Undo last apply" puts them back.`);
    analyze();
    if (S.scan && $('apply-to').value.trim() === S.source) scan();
  } catch (err) { toast(err.message, true); }
};
$('undo').onclick = async () => {
  try {
    const r = await api('apply/undo', { to: $('apply-to').value.trim() });
    toast(r.name ? `Timey-wimey! Apply ${r.name} undone (${plural(r.n, 'file')} restored).` : 'Nothing to undo in that folder.');
    analyze(); if (S.scan && $('apply-to').value.trim() === S.source) scan();
  } catch (err) { toast(err.message, true); }
};

// ----- folder picker ------------------------------------------------------
function pickFolder(start) {
  return new Promise((resolve) => {
    const dlg = $('picker');
    let current = '';
    const load = async (p) => {
      const r = await api('browse', { path: p });
      current = r.path; $('picker-path').value = r.path;
      const crumbs = $('picker-crumbs'); crumbs.replaceChildren();
      const parts = r.path.split(/[\\/]/).filter(Boolean);
      let acc = r.path.startsWith('/') ? '/' : '';
      parts.forEach((part, i) => { acc += (i === 0 && !r.path.startsWith('/') ? '' : '') + part + (r.path.startsWith('/') || i > 0 ? '' : '\\'); const a = el('a', '', part); const target = r.path.startsWith('/') ? '/' + parts.slice(0, i + 1).join('/') : parts.slice(0, i + 1).join('\\') + (i === 0 ? '\\' : ''); a.onclick = () => load(target); crumbs.append(a, ' / '); });
      const list = $('picker-list'); list.replaceChildren();
      if (r.parent) { const up = el('li', '', '↑ ..'); up.onclick = () => load(r.parent); list.appendChild(up); }
      for (const d of r.dirs) { const li = el('li', '', '📁 ' + d.name); li.onclick = () => load(d.path); list.appendChild(li); }
    };
    $('picker-go').onclick = () => load($('picker-path').value);
    $('picker-path').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); load($('picker-path').value); } };
    $('picker-home').onclick = () => load('~');
    dlg.onclose = () => resolve(dlg.returnValue === 'use' ? current : null);
    load(start || '~').then(() => dlg.showModal()).catch((e) => { toast(e.message, true); resolve(null); });
  });
}

// ----- shortcuts + start ---------------------------------------------------
document.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter' && $('tab-pack').classList.contains('active')) { ev.preventDefault(); $('copy').click(); }
  if (ev.altKey && ev.key.toLowerCase() === 'r') { ev.preventDefault(); scan(); }
});
window.addEventListener('beforeunload', () => { if (S.scan) navigator.sendBeacon && saveSession(); });

(async function init() {
  try {
    const st = await api('state');
    S.templates = st.templates; S.builtin = st.builtin; S.recent = st.recent;
    $('recent-list').replaceChildren(...st.recent.map((r) => Object.assign(el('option'), { value: r })));
    renderTemplates();
  } catch (err) { status(err.message, 'err'); }
  syncTime();
  if (INITIAL) { $('source').value = INITIAL; openProject(INITIAL); }
})();
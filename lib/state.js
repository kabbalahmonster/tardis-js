'use strict';
/**
 * @file lib/state.js — remembered state.
 *
 *   ~/.tardis/state.json      recent projects, per-project sessions, user templates
 *   <project>/.tardis.json    named profiles (commit it to share)
 *
 * Both files use the same schema as the Python edition of TARDIS, so the two
 * can be used side by side on the same projects.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { TEMPLATES, TardisError } = require('./core');

const STATE_FILE = path.join(os.homedir(), '.tardis', 'state.json');
const PROFILE_FILE = '.tardis.json';

async function readJson(file) {
  try { const d = JSON.parse(await fsp.readFile(file, 'utf8')); return d && typeof d === 'object' ? d : {}; }
  catch { return {}; }
}
/** Atomic write (temp file + rename) so a crash never leaves half a file. */
async function writeJson(file, data) {
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 1));
    await fsp.rename(tmp, file);
    return true;
  } catch { return false; }
}
const loadState = () => readJson(STATE_FILE);
const saveState = (s) => writeJson(STATE_FILE, s);
const loadProfiles = async (root) => (await readJson(path.join(root, PROFILE_FILE))).profiles || {};
const saveProfiles = (root, profiles) => writeJson(path.join(root, PROFILE_FILE), { version: 1, profiles });

/** All templates: built-in plus the user's own. */
async function allTemplates() { return { ...TEMPLATES, ...((await loadState()).templates || {}) }; }
async function findTemplate(name) {
  const pool = await allTemplates();
  const low = name.toLowerCase();
  for (const [k, v] of Object.entries(pool)) if (k.toLowerCase() === low) return v;
  const hits = Object.entries(pool).filter(([k]) => k.toLowerCase().startsWith(low));
  if (hits.length === 1) return hits[0][1];
  throw new TardisError(`No task template called "${name}". Try: ${Object.keys(pool).join(', ')}`);
}

/**
 * Stores a whole unticked folder as "folder/" so new files in it stay off.
 * sel: {rel: 'full'|'condensed'|'off'} -> {full:[], condensed:[], off:[]}
 */
function compressSelection(sel, entries) {
  const total = {}, off = {};
  for (const e of entries) {
    if (!e.checkable) continue;
    const parts = e.rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/') + '/';
      total[d] = (total[d] || 0) + 1;
      if (sel[e.rel] === 'off') off[d] = (off[d] || 0) + 1;
    }
  }
  const dead = new Set(Object.keys(total).filter((d) => off[d] === total[d]));
  const out = { full: [], condensed: [], off: [] };
  for (const [rel, mode] of Object.entries(sel).sort()) {
    const parts = rel.split('/');
    if (mode === 'off' && parts.slice(1).some((_, i) => dead.has(parts.slice(0, i + 1).join('/') + '/'))) continue;
    (out[mode] || (out[mode] = [])).push(rel);
  }
  const parent = (d) => (d.slice(0, -1).includes('/') ? d.slice(0, -1).slice(0, d.slice(0, -1).lastIndexOf('/')) + '/' : '');
  out.off = [...dead].filter((d) => !dead.has(parent(d))).sort().concat(out.off);
  return out;
}
function expandSelection(data, entries) {
  const files = {};
  for (const mode of ['full', 'condensed', 'off']) for (const rel of data[mode] || []) if (!rel.endsWith('/')) files[rel] = mode;
  const dirs = (data.off || []).filter((d) => d.endsWith('/'));
  const sel = {};
  for (const e of entries) {
    if (e.rel in files) sel[e.rel] = files[e.rel];
    else if (e.checkable && dirs.some((d) => e.rel.startsWith(d))) sel[e.rel] = 'off';
  }
  return sel;
}

module.exports = { STATE_FILE, PROFILE_FILE, loadState, saveState, loadProfiles, saveProfiles, allTemplates, findTemplate, compressSelection, expandSelection };
'use strict';
/**
 * @file lib/core.js — the TARDIS engine.
 *
 * Everything that turns a folder into a snapshot document lives here:
 *
 *   1. Knowledge base      what is junk, binary, a lock file, a secret...
 *   2. Helpers             sizes, languages, decoding, token counting
 *   3. Ignore patterns     a .gitignore-compatible matcher
 *   4. Secrets             find / redact / restore secret-looking values
 *   5. Condensed views     outlines, samples, sketches, image facts
 *   6. Data model          Options, Entry, ScanResult
 *   7. Git                 info, file lists, time travel, remote clones
 *   8. Scanning            find the files and classify them
 *   9. Import graph        "follow the imports"
 *  10. Priorities + plan   which files matter, what the budget gives up first
 *  11. Rendering           the three output formats, trimming, splitting
 *
 * The module is framework-free and has no dependencies. Functions that touch
 * the disk or git are async; pure text transformations are sync so they can
 * be unit-tested without fixtures.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const VERSION = '2.0.0';
const APP_NAME = 'TARDIS';
const APP_LONG = 'Tree And Repo Dump In Single-file';
const TAGLINE = "It's bigger on the inside.";

/** A problem worth showing to the user (as opposed to a bug). */
class TardisError extends Error {}
/** Thrown inside a scan that has been superseded by a newer one. */
class ScanCancelled extends Error {}

// ===========================================================================
// 1. Knowledge base
// ===========================================================================
const VCS_DIRS = new Set(['.git', '.hg', '.svn', '.tardis']);
/** Never hand-written source. Skipped whenever ignore rules are on. */
const JUNK_DIRS = new Set([
  'node_modules', 'bower_components', 'jspm_packages', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.venv', 'venv',
  '.eggs', '.ipynb_checkpoints', '.idea', '.vs', '.gradle', '.terraform',
  '.serverless', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache',
  '.cache', '.angular', '.dart_tool', '.bundle', 'Pods', 'DerivedData', '.sass-cache',
]);
/** Usually build output. Only skipped when git is NOT there to tell us better. */
const BUILD_DIRS = new Set(['build', 'dist', 'out', 'target', 'coverage',
  'htmlcov', 'obj', '_build', 'site-packages']);
const JUNK_FILE_GLOBS = ['.DS_Store', 'Thumbs.db', 'desktop.ini', '*.pyc', '*.pyo',
  '*.pyd', '*.class', '*.o', '*.obj', '*.swp', '*.swo', '*~', '*.orig', '*.rej',
  '.coverage', 'npm-debug.log*', 'yarn-error.log*', '.tardis.json'];
const GENERATED_GLOBS = ['*.min.js', '*.min.css', '*.min.mjs', '*.map',
  '*.bundle.js', '*.chunk.js'];
const SECRET_GLOBS = ['.env', '.env.*', '*.env', '*.pem', '*.key', '*.p12', '*.pfx',
  '*.jks', '*.keystore', '*.kdbx', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  '.npmrc', '.pypirc', '.netrc', '.htpasswd', 'credentials.json', 'credentials.yml',
  'credentials.yaml', 'secrets.json', 'secrets.yml', 'secrets.yaml', 'secrets.toml',
  '*.tfvars', '*.tfstate', '*.tfstate.backup', 'service-account*.json'];
const SECRET_SAFE_WORDS = ['example', 'sample', 'template', '.dist', 'defaults'];

const LOCK_FILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
  'bun.lock', 'bun.lockb', 'cargo.lock', 'poetry.lock', 'pipfile.lock', 'pdm.lock',
  'uv.lock', 'composer.lock', 'gemfile.lock', 'go.sum', 'flake.lock', 'mix.lock',
  'pubspec.lock', 'podfile.lock', 'packages.lock.json', 'deno.lock',
  'gradle.lockfile', 'conan.lock',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']);
const BINARY_EXTS = new Set(`png jpg jpeg gif bmp ico icns webp tif tiff psd ai heic avif
mp3 wav ogg flac m4a aac mp4 mov avi mkv webm wmv flv
zip tar gz tgz bz2 xz 7z rar zst jar war ear whl egg deb rpm dmg iso apk ipa
ttf otf woff woff2 eot pdf doc docx xls xlsx ppt pptx odt ods odp
exe dll so dylib a lib o obj pyc pyo pyd class wasm bin dat
db sqlite sqlite3 mdb pkl pickle npy npz parquet h5 hdf5 pt pth onnx
safetensors ckpt lockb`.split(/\s+/));

const LANG_BY_NAME = {
  dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake', gemfile: 'ruby', rakefile: 'ruby', vagrantfile: 'ruby',
  brewfile: 'ruby', jenkinsfile: 'groovy', justfile: 'makefile', pipfile: 'toml',
  'go.mod': 'go', '.gitignore': 'gitignore', '.dockerignore': 'gitignore',
  '.npmignore': 'gitignore', '.gitattributes': 'gitattributes', '.editorconfig': 'ini',
  '.bashrc': 'bash', '.zshrc': 'bash', '.bash_profile': 'bash', '.profile': 'bash',
};
const LANG_BY_EXT = {
  py: 'python', pyi: 'python', pyw: 'python', ipynb: 'json', js: 'javascript',
  mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript', mts: 'typescript',
  cts: 'typescript', tsx: 'tsx', vue: 'vue', svelte: 'svelte', astro: 'astro',
  html: 'html', htm: 'html', xhtml: 'html', css: 'css', scss: 'scss', sass: 'sass',
  less: 'less', json: 'json', jsonc: 'jsonc', json5: 'json5', jsonl: 'json',
  ndjson: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini',
  conf: 'ini', properties: 'properties', env: 'dotenv', xml: 'xml', xsd: 'xml',
  xsl: 'xml', plist: 'xml', csproj: 'xml', svg: 'svg', md: 'markdown',
  markdown: 'markdown', mdx: 'mdx', rst: 'rst', txt: 'text', adoc: 'asciidoc',
  tex: 'latex', org: 'org', sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'fish',
  ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch', c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
  cs: 'csharp', fs: 'fsharp', vb: 'vbnet', java: 'java', kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', groovy: 'groovy', gradle: 'groovy', go: 'go', rs: 'rust',
  swift: 'swift', m: 'objectivec', mm: 'objectivec', dart: 'dart', zig: 'zig',
  nim: 'nim', rb: 'ruby', erb: 'erb', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua',
  r: 'r', jl: 'julia', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell',
  ml: 'ocaml', clj: 'clojure', cljs: 'clojure', lisp: 'lisp', el: 'lisp',
  scm: 'scheme', sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  prisma: 'prisma', tf: 'hcl', hcl: 'hcl', tfvars: 'hcl', nix: 'nix', cmake: 'cmake',
  mk: 'makefile', csv: 'csv', tsv: 'csv', log: 'text', diff: 'diff', patch: 'diff',
  lock: 'text', gd: 'gdscript', sol: 'solidity', vim: 'vim', asm: 'asm', s: 'asm',
  glsl: 'glsl', wgsl: 'wgsl', j2: 'jinja', jinja: 'jinja', hbs: 'handlebars',
  ejs: 'ejs', pug: 'pug', twig: 'twig',
};
const LANG_DISPLAY = {
  python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript', jsx: 'JSX',
  tsx: 'TSX', html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON', jsonc: 'JSON',
  json5: 'JSON', yaml: 'YAML', toml: 'TOML', xml: 'XML', svg: 'SVG', sql: 'SQL',
  bash: 'Shell', cpp: 'C++', csharp: 'C#', fsharp: 'F#', vbnet: 'VB.NET', c: 'C',
  php: 'PHP', markdown: 'Markdown', mdx: 'MDX', text: 'Text', objectivec: 'Objective-C',
  graphql: 'GraphQL', hcl: 'Terraform/HCL', ini: 'INI', csv: 'CSV',
  powershell: 'PowerShell', latex: 'LaTeX', rst: 'reStructuredText', dotenv: 'dotenv',
  cmake: 'CMake',
};
const DOC_LANGS = new Set(['markdown', 'mdx', 'rst', 'text', 'asciidoc', 'org', 'latex']);
const DATA_LANGS = new Set(['json', 'jsonc', 'json5', 'yaml', 'toml', 'ini', 'csv',
  'xml', 'svg', 'dotenv', 'properties', 'gitignore', 'gitattributes']);
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'requirements.txt', 'cargo.toml', 'go.mod', 'makefile', 'dockerfile',
  'docker-compose.yml', 'docker-compose.yaml', 'tsconfig.json', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'gemfile', 'composer.json', 'cmakelists.txt',
  'pipfile', 'deno.json', 'justfile']);
const LOW_DIRS = new Set(['fixtures', 'fixture', 'mocks', '__mocks__', 'vendor',
  'third_party', 'examples', 'example', 'samples', 'migrations', 'snapshots',
  '__snapshots__', 'testdata', 'assets', 'static', 'public', 'locale', 'locales',
  'i18n', 'data']);
const ENTRY_STEMS = new Set(['main', 'index', 'app', 'cli', 'server', '__main__',
  'manage', 'lib', 'mod', '__init__']);
const TEST_DIRS = new Set(['test', 'tests', 'spec', 'specs', '__tests__', 'e2e']);
const TEST_NAME_RE = /(^test_|_test\.|\.test\.|\.spec\.|^conftest\.)/;
const REASON_LABELS = {
  binary: 'binary', large: 'too large', lock: 'lock file',
  generated: 'generated/minified', secret: 'possible secrets', symlink: 'symlink',
  unreadable: 'unreadable', special: 'special', user: 'left out by user',
  budget: 'trimmed to fit the budget', unchanged: 'unchanged',
};
const FORMAT_EXT = { markdown: '.md', xml: '.xml', text: '.txt' };

/** Built-in task templates (the GUI adds user-defined ones). */
const TEMPLATES = {
  'Explain the project': 'Explain this project: what it does, how it is structured, how the main pieces fit together, and where a newcomer should start reading.',
  'Code review': 'Review this code as a senior engineer would. List concrete problems (bugs, risky patterns, unclear code, missing error handling) ordered by severity, each with the file and a suggested fix.',
  'Find bugs': 'Look for bugs. For each one give the file, the faulty code, why it is wrong, and a corrected version.',
  'Security audit': 'Audit this project for security problems (injection, unsafe deserialization, leaked secrets, missing authorization, path traversal, insecure defaults). Rank findings by severity and propose fixes.',
  'Write tests': 'Write tests for the most important untested behaviour, using the test framework and conventions the project already uses.',
  'Refactor': 'Suggest and carry out refactorings that make the code simpler and easier to maintain without changing behaviour. Explain each change briefly.',
  'Improve docs': 'Improve the documentation: make the README accurately describe setup, usage and structure, and add docstrings or comments where they genuinely help.',
};
const SR_START = '<<<<<<< SEARCH', SR_MID = '=======', SR_END = '>>>>>>> REPLACE';
/** The instructions appended to every snapshot so replies can be applied. */
const REPLY_FORMAT = [
  'If your answer changes, creates or deletes files, please use this format so the changes can be applied automatically (the rest of your answer can be normal prose):',
  '- Changed or new file: a line "### FILE: relative/path", then ONE fenced code block containing the COMPLETE new contents of the file. Never shorten it with "..." or "rest unchanged".',
  '- If the file itself contains code fences, use a longer outer fence (four or more backticks).',
  '- Small change to a big file: a line "### EDIT: relative/path", then a fenced code block holding one or more SEARCH/REPLACE pairs, with the SEARCH text copied exactly from the file:',
  '      ' + SR_START, '      lines exactly as they are now', '      ' + SR_MID,
  '      the lines that should replace them', '      ' + SR_END,
  '- Deleted file: the single line "### DELETE: relative/path".',
  '- Files shown here as "condensed" are incomplete: never send one back as a complete FILE. Use EDIT for the parts you can see, or ask for the full file first.',
  '- Keep any [REDACTED:...] placeholders exactly as they are.',
  '- Only include files that actually change.',
];

const BT = '`';
const FENCE = BT.repeat(3);
const CONDENSE_CAP = 8 * 1024 * 1024;   // largest file we read just to condense it
const CHARS_PER_TOKEN = 3.6;

// ===========================================================================
// 2. Helpers and token counting
// ===========================================================================
function humanSize(n) {
  if (n < 1024) return `${Math.round(n)} B`;
  for (const unit of ['KB', 'MB', 'GB']) {
    n /= 1024;
    if (n < 1024 || unit === 'GB') return `${n.toFixed(1)} ${unit}`;
  }
  return `${n.toFixed(1)} GB`;
}
const fmtInt = (n) => Number(n).toLocaleString('en-US');
const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? '' : 's'}`;
const langName = (code) => LANG_DISPLAY[code] || code.charAt(0).toUpperCase() + code.slice(1);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function contextNote(tokens) {
  const pct = tokens * 100 / 200000;
  return pct < 1 ? 'under 1% of a 200k context' : `${pct.toFixed(0)}% of a 200k context`;
}

/** Language from a file name (used for fences, statistics and condensing). */
function detectLanguage(name) {
  const low = name.toLowerCase();
  if (LANG_BY_NAME[low]) return LANG_BY_NAME[low];
  if (low.startsWith('dockerfile')) return 'dockerfile';
  if (low.startsWith('.env')) return 'dotenv';
  const dot = low.lastIndexOf('.');
  return dot >= 0 ? (LANG_BY_EXT[low.slice(dot + 1)] || 'text') : 'text';
}
const extOf = (name) => { const d = name.lastIndexOf('.'); return d >= 0 ? name.slice(d + 1).toLowerCase() : ''; };

/** "tests/, *.md" -> ['tests/', '*.md'] (also accepts arrays and newlines). */
function splitGlobs(values) {
  const out = [];
  for (const v of [].concat(values || [])) {
    for (const p of String(v).split(/[,\n]/)) if (p.trim()) out.push(p.trim());
  }
  return out;
}

/** '100k' -> 100000, '1.5m' -> 1500000, 'No limit' -> 0. */
function parseTokens(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[, _]/g, '');
  if (!s || ['0', 'none', 'nolimit', 'off'].includes(s)) return 0;
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(s);
  if (!m) throw new TardisError(`Cannot read "${value}" as a token count (try 100k, 1.5m or 64000).`);
  return Math.round(parseFloat(m[1]) * { '': 1, k: 1000, m: 1000000 }[m[2]]);
}
function formatTokens(n) {
  if (!n) return 'No limit';
  if (n % 1000000 === 0) return `${n / 1000000}M`;
  if (n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });
/** Bytes -> text. UTF-8 first (with BOM), then UTF-16 with BOM, then cp1252. */
function decode(buf) {
  let text;
  if (buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le', 2);
  else if (buf[0] === 0xfe && buf[1] === 0xff) {
    try { text = new TextDecoder('utf-16be').decode(buf.subarray(2)); } catch { text = buf.toString('latin1'); }
  } else {
    try { text = UTF8_STRICT.decode(buf); } catch {
      try { text = new TextDecoder('windows-1252').decode(buf); } catch { text = buf.toString('latin1'); }
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\0/g, '');
}
const countLines = (t) => (t.match(/\n/g) || []).length + (t && !t.endsWith('\n') ? 1 : 0);

/** Lookup table of "texty" bytes; everything else counts against a file. */
const TEXT_BYTES = (() => {
  const t = new Uint8Array(256);
  for (const b of [7, 8, 9, 10, 12, 13, 27]) t[b] = 1;
  for (let b = 0x20; b < 0x100; b++) if (b !== 0x7f) t[b] = 1;
  return t;
})();
function looksBinary(buf) {
  if (!buf || !buf.length) return false;
  if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)
      || (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)) return false;
  if (buf.indexOf(0) !== -1) return true;
  let bad = 0;
  for (const b of buf) if (!TEXT_BYTES[b]) bad++;
  return bad / buf.length > 0.10;
}

/**
 * Token counter. Uses the optional `gpt-tokenizer` package when installed
 * (exact for OpenAI models); otherwise characters / 3.6, a deliberately
 * conservative estimate for code.
 */
class TokenCounter {
  constructor() { this.mode = 'auto'; this.name = `estimate: characters / ${CHARS_PER_TOKEN}`; this._encode = null; this._tried = false; }
  configure(mode) { this.mode = mode; this._tried = false; this._encode = null; this.name = `estimate: characters / ${CHARS_PER_TOKEN}`; }
  ensure() {
    if (this._tried) return;
    this._tried = true;
    if (this.mode === 'estimate') return;
    try {
      this._encode = require('gpt-tokenizer/encoding/o200k_base').encode;
      this.name = 'exact for OpenAI models: gpt-tokenizer o200k_base';
    } catch { this._encode = null; }
  }
  count(text) {
    if (!text) return 0;
    if (!this._tried) this.ensure();
    if (this._encode) { try { return this._encode(text).length; } catch { /* fall through */ } }
    return Math.floor(text.length / CHARS_PER_TOKEN) + 1;
  }
}
const TOKENS = new TokenCounter();

// ===========================================================================
// 3. .gitignore-style patterns
// ===========================================================================
/** Shell-style glob (fnmatch) -> regex source, anchored by the caller. */
function fnmatchToRegex(glob) {
  let out = '';
  for (const ch of glob) out += ch === '*' ? '.*' : ch === '?' ? '.' : escapeRe(ch);
  return out;
}
const globsRe = (globs) => new RegExp('^(?:' + globs.map(fnmatchToRegex).join('|') + ')$', 'i');
const JUNK_FILE_RE = globsRe(JUNK_FILE_GLOBS);
const GENERATED_RE = globsRe(GENERATED_GLOBS);
const SECRET_NAME_RE = globsRe(SECRET_GLOBS);
const SNAPSHOT_RE = /\.tardis(\.part\d+)?\.(md|xml|txt)$/i;   // our own output

/** One gitignore pattern body -> regex source (handles *, **, ?, [...], \). */
function globToRegex(pat) {
  let out = '', i = 0;
  const n = pat.length;
  while (i < n) {
    const ch = pat[i];
    if (ch === '*') {
      let j = i;
      while (j < n && pat[j] === '*') j++;
      const segStart = i === 0 || pat[i - 1] === '/';
      if (j - i >= 2 && segStart && j < n && pat[j] === '/') { out += '(?:.*/)?'; i = j + 1; }
      else if (j - i >= 2 && segStart && j === n) { out += '.*'; i = j; }
      else { out += '[^/]*'; i = j; }
    } else if (ch === '?') { out += '[^/]'; i++; }
    else if (ch === '[') {
      let j = i + 1;
      if (j < n && (pat[j] === '!' || pat[j] === '^')) j++;
      if (j < n && pat[j] === ']') j++;
      while (j < n && pat[j] !== ']') j++;
      if (j >= n) { out += '\\['; i++; }
      else {
        let body = pat.slice(i + 1, j);
        const neg = body[0] === '!' || body[0] === '^';
        if (neg) body = body.slice(1);
        body = body.replace(/\\/g, '\\\\').replace(/\[/g, '\\[');
        out += '[' + (neg ? '^' : '') + body + ']';
        i = j + 1;
      }
    } else if (ch === '\\' && i + 1 < n) { out += escapeRe(pat[i + 1]); i += 2; }
    else { out += escapeRe(ch); i++; }
  }
  return out;
}

/** Lines of a .gitignore -> rules [{re, negated, dirOnly}]. */
function parseIgnoreLines(lines) {
  const rules = [];
  for (const raw of lines) {
    let line = raw.replace(/[\r\n]+$/, '');
    if (!line.endsWith('\\ ')) line = line.replace(/\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) { negated = true; line = line.slice(1); }
    else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    const dirOnly = line.endsWith('/');
    line = line.replace(/\/+$/, '');
    if (!line) continue;
    const anchored = line.includes('/');
    line = line.replace(/^\/+/, '');
    const body = globToRegex(line);
    try { rules.push({ re: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`), negated, dirOnly }); }
    catch { /* unusable pattern: skip, like git would complain */ }
  }
  return rules;
}
/** Last matching rule wins; null when nothing matched. */
function rulesVerdict(rules, rel, isDir) {
  let verdict = null;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) verdict = !r.negated;
  }
  return verdict;
}
/** A pattern list tested against a file path and all its parent folders. */
class GlobSet {
  constructor(patterns) { this.rules = parseIgnoreLines(patterns || []); }
  get empty() { return this.rules.length === 0; }
  matches(rel) {
    if (this.empty) return false;
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const isDir = i < parts.length;
      const v = rulesVerdict(this.rules, parts.slice(0, i).join('/'), isDir);
      if (isDir && v) return true;
      if (!isDir) return !!v;
    }
    return false;
  }
}

// ===========================================================================
// 4. Secrets: find, redact, restore
// ===========================================================================
/** [kind, regex (global + indices), capture group holding the secret]. */
const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gd, 0],
  ['aws-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gd, 0],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/gd, 0],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gd, 0],
  ['api-key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/gd, 0],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/gd, 0],
  ['stripe-key', /\b[sr]k_live_[0-9A-Za-z]{16,}\b/gd, 0],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gd, 0],
  ['url-password', /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@/gd, 1],
  ['assigned-secret', /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|client[_-]?secret)[\w.-]*["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gdi, 1],
];
const KEYWORD_LINE_RE = /^[^\n]*(?:key|secret|token|passw|credential|auth)[^\n]*$/gim;
const HASHY_RE = /integrity|checksum|sha\d*[-:=]|\bhash|commit|digest/i;
const TOKENISH_RE = /[A-Za-z0-9+/=_-]{24,}/g;
const PLACEHOLDER_WORDS = ['example', 'changeme', 'change_me', 'placeholder', 'your',
  'xxxx', 'todo', 'dummy', 'sample', 'secret', 'password', 'redacted', '<', '>', '${',
  '{{', '%(', '****'];
const REDACTED_RE = /\[REDACTED:([a-z-]+)#(\d+)\]/g;

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const c of counts.values()) { const p = c / s.length; h -= p * Math.log2(p); }
  return h;
}
function isPlaceholder(value, needDigit) {
  const low = value.toLowerCase();
  if (PLACEHOLDER_WORDS.some((w) => low.includes(w)) || new Set(value).size < 5) return true;
  return needDigit && !/\d/.test(value);
}

/**
 * Non-overlapping spans of secret-looking values: [{start, end, kind}].
 * Three strategies: known key formats, quoted values assigned to secret-ish
 * names, and high-entropy strings on lines that mention keys/tokens.
 */
function findSecrets(text) {
  const spans = [];
  for (const [kind, re, grp] of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const val = m[grp];
      if (val === undefined) continue;
      if (kind === 'assigned-secret' && isPlaceholder(val, true)) continue;
      if (kind === 'url-password' && isPlaceholder(val, false)) continue;
      const [s, e] = m.indices[grp];
      spans.push({ start: s, end: e, kind });
    }
  }
  for (const lm of text.matchAll(KEYWORD_LINE_RE)) {
    const line = lm[0];
    if (line.length > 2000 || HASHY_RE.test(line)) continue;
    for (const tm of line.matchAll(TOKENISH_RE)) {
      const tok = tm[0];
      const digits = (tok.match(/\d/g) || []).length;
      const isHex = tok.length >= 32 && /^[0-9a-fA-F]+$/.test(tok);
      const mixed = digits >= 3 && tok.toLowerCase() !== tok && tok.toUpperCase() !== tok
        && entropy(tok) >= 4.1;
      if ((isHex && digits >= 3) || mixed) {
        spans.push({ start: lm.index + tm.index, end: lm.index + tm.index + tok.length, kind: 'high-entropy' });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out = [];
  let lastEnd = -1;
  for (const s of spans) if (s.start >= lastEnd) { out.push(s); lastEnd = s.end; }
  return out;
}

/** Returns {text, findings:[{line, kind}]}; with apply=true values are replaced. */
function redactText(text, apply = true) {
  const spans = findSecrets(text);
  if (!spans.length) return { text, findings: [] };
  const findings = spans.map((s) => ({ line: countLines(text.slice(0, s.start)) + 1 - (text.slice(0, s.start).endsWith('\n') ? 0 : 0), kind: s.kind }));
  // countLines counts a trailing partial line; we want the 1-based line number
  for (let i = 0; i < spans.length; i++) findings[i].line = (text.slice(0, spans[i].start).match(/\n/g) || []).length + 1;
  if (!apply) return { text, findings };
  let out = '', pos = 0;
  spans.forEach((s, i) => { out += text.slice(pos, s.start) + `[REDACTED:${s.kind}#${i + 1}]`; pos = s.end; });
  return { text: out + text.slice(pos), findings };
}

/** Puts real values back where the AI kept our placeholders. */
function restoreRedactions(newText, original) {
  if (!newText.includes('[REDACTED:')) return { text: newText, restored: 0, unresolved: 0 };
  const spans = findSecrets(original);
  let restored = 0;
  const text = newText.replace(REDACTED_RE, (whole, kind, num) => {
    const n = parseInt(num, 10);
    if (n >= 1 && n <= spans.length && spans[n - 1].kind === kind) { restored++; return original.slice(spans[n - 1].start, spans[n - 1].end); }
    return whole;
  });
  const unresolved = (text.match(/\[REDACTED:/g) || []).length;
  return { text, restored, unresolved };
}

// ===========================================================================
// 5. Condensed views
// ===========================================================================
const indentOf = (line) => line.length - line.replace(/^[ \t]+/, '').length;
const isBlank = (line) => !line.trim();

/**
 * Python outline without a parser: indentation does the work. Keeps
 * decorators, def/class headers (multi-line), docstrings; collapses function
 * bodies and long statement continuations. Functions of 2 body lines or
 * fewer are kept whole.
 */
function outlinePython(text) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const out = [];
  const n = lines.length;
  const endsWithColon = (l) => l.replace(/#.*$/, '').trimEnd().endsWith(':');
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { out.push(line); i++; continue; }
    const s = line.trim();
    const indent = indentOf(line);
    if (s.startsWith('@')) { out.push(line); i++; continue; }
    const m = /^(?:async\s+)?(def|class)\b/.exec(s);
    if (m) {
      let j = i;
      while (j < n && !endsWithColon(lines[j]) && j < i + 20) j++;
      for (let k = i; k <= j && k < n; k++) out.push(lines[k]);
      i = Math.min(j + 1, n);
      // docstring
      let k = i;
      while (k < n && isBlank(lines[k])) k++;
      if (k < n && indentOf(lines[k]) > indent && /^("""|''')/.test(lines[k].trim())) {
        const q = lines[k].trim().slice(0, 3);
        let e = k;
        if (!(lines[k].trim().length > 3 && lines[k].trim().endsWith(q))) { e = k + 1; while (e < n && !lines[e].includes(q)) e++; }
        const span = Math.min(e, n - 1) - k + 1;
        if (span <= 12) for (let x = k; x <= Math.min(e, n - 1); x++) out.push(lines[x]);
        else { for (let x = k; x < k + 8; x++) out.push(lines[x]); out.push(' '.repeat(indentOf(lines[k])) + '[...]'); out.push(lines[Math.min(e, n - 1)]); }
        i = Math.min(e, n - 1) + 1;
      }
      if (m[1] === 'def') {
        let e = i, count = 0, inner = indent + 4;
        while (e < n && (isBlank(lines[e]) || indentOf(lines[e]) > indent)) { if (!isBlank(lines[e])) { count++; inner = indentOf(lines[e]); } e++; }
        while (e > i && isBlank(lines[e - 1])) e--;
        if (count <= 2) for (let x = i; x < e; x++) out.push(lines[x]);
        else out.push(' '.repeat(Math.min(inner, indent + 8)) + `...  # ${plural(count, 'more line')}`);
        i = e;
      }
      continue;
    }
    out.push(line);
    i++;
    // statement continuation / compound statement body
    let e = i;
    while (e < n && (isBlank(lines[e]) || (indentOf(lines[e]) > indent && !/^\s*(?:async\s+)?(?:def|class)\b/.test(lines[e])))) e++;
    while (e > i && isBlank(lines[e - 1])) e--;
    const cont = lines.slice(i, e);
    const nonBlank = cont.filter((l) => !isBlank(l)).length;
    if (nonBlank <= 3) out.push(...cont);
    else { let shown = 0; for (const l of cont) { if (shown >= 2) break; out.push(l); if (!isBlank(l)) shown++; } out.push(' '.repeat(indent + 4) + `...  # ${plural(nonBlank - 2, 'more line')}`); }
    i = e;
  }
  return out.length ? out.join('\n') + '\n' : null;
}

const SKEL_DECL = /^(?:(?:export|default|public|private|protected|internal|static|final|abstract|sealed|override|open|virtual|inline|async|suspend|unsafe|extern|declare|partial|data|pub(?:\([a-z:]+\))?)\s+)*(import|from|package|using|use|require|include|module|namespace|mod|class|interface|struct|enum|trait|impl|protocol|extension|object|record|type|union|function\*?|func|fn|fun|def|sub|typedef|template|const|static|var|let|val|export|describe|it|test)\b/;
const SKEL_METHOD = /^(?!(?:if|for|while|switch|catch|return|else|do|try|with|new|throw|await|yield|case|foreach|elif|unless|until|when|match|lock|using|sizeof|typeof|delete|function)\b)(?:[\w$<>\[\],?*&~]+\s+)*[\w$~:]+\s*\([^()]*\)\s*(?::\s*[\w<>\[\],. |?]+)?\s*(?:const\s*)?\{\s*$/;
const SKEL_COMMENT = /^(?:\/\/|\/\*|\*|#|--|"""|''')/;

/** Regex skeleton for brace/keyword languages: keeps declaration lines. */
function outlineGeneric(text) {
  const lines = text.split('\n');
  const decl = new Array(lines.length).fill(false);
  lines.forEach((raw, i) => {
    const s = raw.trimStart();
    if (!s || raw.length > 400) return;
    const pad = raw.slice(0, raw.length - s.length);
    const width = (pad.match(/\t/g) || []).length * 4 + (pad.match(/ /g) || []).length;
    if (width > 8) return;
    if (/^(?:@|#\[|#include|#define)/.test(s)) { decl[i] = true; return; }
    const m = SKEL_DECL.exec(s);
    if (m) {
      const kw = m[1];
      if (['const', 'static', 'var', 'let', 'val', 'use', 'type'].includes(kw) && width > 0 && !s.includes('=>') && !s.includes('function')) return;
      if (['it', 'test', 'describe', 'require', 'include'].includes(kw) && !s.includes('(')) return;
      decl[i] = true;
    } else if (SKEL_METHOD.test(s)) decl[i] = true;
    else if (width === 0 && /^[A-Za-z]/.test(s) && s.includes('(') && /[{)]\s*$/.test(s)
      && !s.split('(')[0].includes('=') && !/^(?:if|for|while|switch|return|else)\b/.test(s)) decl[i] = true;
  });
  if (decl.filter(Boolean).length < 2) return null;
  const keep = decl.slice();
  lines.forEach((_, i) => {              // doc comments above kept lines
    if (!decl[i]) return;
    let j = i - 1, k = 0;
    while (j >= 0 && k < 6 && !decl[j] && SKEL_COMMENT.test(lines[j].trimStart())) { keep[j] = true; j--; k++; }
  });
  const out = [];
  let gap = 0;
  lines.forEach((raw, i) => {
    if (keep[i]) { if (gap) out.push(`    ... [${plural(gap, 'line')}]`); out.push(raw); gap = 0; }
    else if (raw.trim()) gap++;
  });
  if (gap) out.push(`    ... [${plural(gap, 'line')}]`);
  return out.join('\n') + '\n';
}

function outlineHeadings(text) {
  const lines = text.split('\n');
  const heads = [];
  let fenced = false;
  lines.forEach((ln, i) => {
    const s = ln.trim();
    if (s.startsWith(FENCE) || s.startsWith('~~~')) { fenced = !fenced; return; }
    if (fenced || !s) return;
    const next = i + 1 < lines.length ? lines[i + 1].trim() : '';
    if (/^#{1,6}\s/.test(s)) heads.push([i, ln.trimEnd()]);
    else if (next.length >= 3 && /^(?:=+|-+|~+|\^+)$/.test(next) && /^[A-Za-z0-9]/.test(s)) heads.push([i, ln.trimEnd()]);
  });
  if (heads.length < 3) return null;
  const out = heads.map(([i, ln], k) => {
    const end = k + 1 < heads.length ? heads[k + 1][0] : lines.length;
    return `${ln}   [${plural(end - i - 1, 'line')}]`;
  });
  return [out.join('\n') + '\n', 'headings only'];
}

function condenseRows(lines, total, keep) {
  if (total <= keep + 16) return null;
  const shown = lines.slice(0, keep + 1).map((l) => (l.length <= 400 ? l : l.slice(0, 400) + ' ...'));
  return [shown.join('\n') + `\n... [${fmtInt(total - shown.length)} more lines]\n`, `first ${shown.length} of ${fmtInt(total)} lines`];
}

function condenseJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const out = [];
  const short = (v) => { const s = JSON.stringify(v); return s.length <= 60 ? s : s.slice(0, 57) + '...'; };
  const walk = (v, ind, key, depth) => {
    if (out.length > 400) return;
    const pre = ' '.repeat(ind) + (key !== null ? JSON.stringify(key) + ': ' : '');
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
      const keys = Object.keys(v);
      if (depth >= 6) { out.push(pre + `{ ... ${plural(keys.length, 'key')} }`); return; }
      out.push(pre + '{');
      keys.slice(0, 30).forEach((k) => walk(v[k], ind + 2, k, depth + 1));
      if (keys.length > 30) out.push(' '.repeat(ind + 2) + `... [${fmtInt(keys.length - 30)} more keys]`);
      out.push(' '.repeat(ind) + '}');
    } else if (Array.isArray(v) && v.length) {
      if (depth >= 6) { out.push(pre + `[ ... ${plural(v.length, 'item')} ]`); return; }
      out.push(pre + `[   <- ${plural(v.length, 'item')}${v.length > 1 ? ', only the first is shown' : ''}`);
      walk(v[0], ind + 2, null, depth + 1);
      out.push(' '.repeat(ind) + ']');
    } else out.push(pre + short(v));
  };
  walk(data, 0, null, 0);
  return [out.join('\n') + '\n', 'JSON structure sketch, not the real data'];
}

function condenseNotebook(text) {
  let nb;
  try { nb = JSON.parse(text); } catch { return null; }
  if (!nb || !Array.isArray(nb.cells)) return null;
  const out = [];
  nb.cells.forEach((cell, idx) => {
    if (!cell || typeof cell !== 'object') return;
    const kind = cell.cell_type || 'code';
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
    out.push(`# %% [${kind}] cell ${idx + 1}`);
    if (kind === 'code') { out.push(src.replace(/\n+$/, '')); if (cell.outputs && cell.outputs.length) out.push('# (output stripped)'); }
    else out.push(...src.split('\n').map((l) => (l ? '# ' + l : '#')));
    out.push('');
  });
  const lang = (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.language) || 'python';
  return [out.join('\n') + '\n', `notebook as a script, ${plural(nb.cells.length, 'cell')}, outputs stripped`, String(lang)];
}

function headSample(text, n = 40) {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= n + 10) return null;
  return [lines.slice(0, n).join('\n') + `\n... [${fmtInt(lines.length - n)} more lines]\n`, `first ${n} of ${fmtInt(lines.length)} lines`];
}

/**
 * A shorter stand-in for a file: [text, label, language] or null when no
 * view is at least 20% shorter than the original.
 */
function condense(rel, lang, text) {
  const name = rel.split('/').pop();
  const ext = extOf(name);
  let out = null;
  if (ext === 'ipynb') { const nb = condenseNotebook(text); if (nb) return nb; }
  else if (['csv', 'tsv', 'jsonl', 'ndjson'].includes(ext)) {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    out = condenseRows(lines, lines.length, ext === 'csv' || ext === 'tsv' ? 5 : 3);
  } else if (['json', 'jsonc', 'json5'].includes(lang)) out = condenseJson(text);
  else if (['markdown', 'mdx', 'rst', 'asciidoc'].includes(lang)) out = outlineHeadings(text);
  else if (!DOC_LANGS.has(lang) && !DATA_LANGS.has(lang)) {
    const body = (lang === 'python' ? outlinePython(text) : null) || outlineGeneric(text);
    if (body) out = [body, 'outline: signatures kept, bodies collapsed'];
  }
  if (!out) out = headSample(text);
  if (!out || out[0].length > text.length * 0.8) return null;
  return [out[0], out[1], lang];
}

/** 'PNG image, 1200x630' from the first bytes of an image file. */
function imageInfo(head) {
  try {
    if (head.length >= 24 && head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return `PNG image, ${head.readUInt32BE(16)}x${head.readUInt32BE(20)}`;
    if (head.length >= 10 && ['GIF87a', 'GIF89a'].includes(head.toString('latin1', 0, 6)))
      return `GIF image, ${head.readUInt16LE(6)}x${head.readUInt16LE(8)}`;
    if (head.length >= 26 && head.toString('latin1', 0, 2) === 'BM')
      return `BMP image, ${head.readInt32LE(18)}x${Math.abs(head.readInt32LE(22))}`;
    if (head.length >= 30 && head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP') {
      const kind = head.toString('latin1', 12, 16);
      let w, h;
      if (kind === 'VP8X') { w = 1 + head.readUIntLE(24, 3); h = 1 + head.readUIntLE(27, 3); }
      else if (kind === 'VP8L') { const b0 = head[21], b1 = head[22], b2 = head[23], b3 = head[24]; w = 1 + (((b1 & 0x3f) << 8) | b0); h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)); }
      else if (kind === 'VP8 ') { w = head.readUInt16LE(26) & 0x3fff; h = head.readUInt16LE(28) & 0x3fff; }
      else return 'WebP image';
      return `WebP image, ${w}x${h}`;
    }
    if (head[0] === 0xff && head[1] === 0xd8) {
      let i = 2;
      while (i + 9 < head.length) {
        if (head[i] !== 0xff) { i++; continue; }
        const marker = head[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
          return `JPEG image, ${head.readUInt16BE(i + 7)}x${head.readUInt16BE(i + 5)}`;
        i += 2 + head.readUInt16BE(i + 2);
      }
      return 'JPEG image';
    }
  } catch { /* malformed header: fall through */ }
  return '';
}

// ===========================================================================
// 6. Data model
// ===========================================================================
/** Keys that profiles and sessions persist (shared with the Python edition). */
const OPTION_KEYS = ['include_hidden', 'use_ignore', 'include_locks', 'include_secrets',
  'redact', 'max_size_kb', 'include_globs', 'exclude_globs', 'omit_globs',
  'condense_globs', 'fmt', 'line_numbers', 'tree_only', 'budget', 'over', 'since',
  'at', 'include_diff', 'task', 'reply_format'];

/** The full option set with defaults. `root` is the project folder. */
function defaultOptions(root = '.') {
  return {
    root, include_hidden: false, use_ignore: true, include_locks: false,
    include_secrets: false, redact: true, max_size_kb: 256, include_globs: [],
    exclude_globs: [], omit_globs: [], condense_globs: [], fmt: 'markdown',
    line_numbers: false, tree_only: false, budget: 0, over: 'trim', since: '', at: '',
    include_diff: true, task: '', reply_format: true, source: '',
  };
}
/** Merge a saved option dict into defaults, ignoring wrong-typed values. */
function mergeOptions(base, d) {
  const out = { ...base };
  for (const k of OPTION_KEYS) {
    if (d && k in d && d[k] !== undefined && typeof d[k] === typeof base[k]
        && Array.isArray(d[k]) === Array.isArray(base[k])) out[k] = Array.isArray(d[k]) ? d[k].map(String) : d[k];
  }
  return out;
}
const pickOptions = (o) => Object.fromEntries(OPTION_KEYS.map((k) => [k, o[k]]));

function numberLines(text) {
  if (!text) return text;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const w = Math.max(2, String(lines.length).length);
  return lines.map((ln, i) => `${String(i + 1).padStart(w)} |${ln ? ' ' + ln : ''}`).join('\n') + '\n';
}

/**
 * One file of the project. `skip` is '' when the file is included by default,
 * otherwise a reason code; `forceable` means the user may still include it.
 * `view()` produces the text actually placed in the document, cached per
 * (mode, redact, numbered).
 */
class Entry {
  constructor(rel, abs) {
    this.rel = rel; this.abs = abs; this.size = 0; this.lang = 'text'; this.skip = '';
    this.note = ''; this.forceable = false; this.default = 'full'; this.link = '';
    this.blob = ''; this.repo = ''; this.change = ''; this.lines = 0;
    this._text = null; this._cond = false; this._views = new Map();
  }
  get loaded() { return this._text !== null; }
  get checkable() { return !this.skip || this.forceable; }

  /** Raw bytes from disk or, for time travel, from the git object store. */
  async readBytes(limit = 0) {
    try {
      if (this.blob) {
        const data = await git(this.repo, ['cat-file', 'blob', this.blob], { timeout: 120000 });
        return data && limit ? data.subarray(0, limit) : data;
      }
      if (!limit) return await fsp.readFile(this.abs);
      const fh = await fsp.open(this.abs, 'r');
      try { const buf = Buffer.alloc(limit); const { bytesRead } = await fh.read(buf, 0, limit, 0); return buf.subarray(0, bytesRead); }
      finally { await fh.close(); }
    } catch { return null; }
  }
  async load(data = null) {
    if (this._text !== null) return true;
    if (data === null) data = await this.readBytes();
    if (data === null) return false;
    this._text = decode(data);
    this.lines = countLines(this._text);
    return true;
  }
  /** Computes the condensed view if needed (loads the file first). */
  async ensureCondensed() {
    if (this._cond !== false) return this._cond;
    this._cond = null;
    if (await this.load()) { try { this._cond = condense(this.rel, this.lang, this._text); } catch { this._cond = null; } }
    return this._cond;
  }
  condensed() { return this._cond === false ? null : this._cond; }
  /** {body, label, lang, tokens, findings} for a mode. Sync: text must be loaded. */
  view(mode, redact = false, numbered = false) {
    const key = `${mode}|${redact}|${numbered}`;
    let v = this._views.get(key);
    if (!v) {
      let text, label = '', lang = this.lang;
      if (mode === 'condensed' && this.condensed()) [text, label, lang] = this._cond;
      else text = this._text || '';
      const r = redactText(text, redact);
      text = r.text;
      if (numbered) text = numberLines(text);
      v = { body: text, label, lang, tokens: TOKENS.count(text), findings: r.findings };
      this._views.set(key, v);
    }
    return v;
  }
  /** The plain data the GUI needs (no text). */
  toJSON() {
    return { rel: this.rel, size: this.size, lang: this.lang, skip: this.skip, note: this.note,
      forceable: this.forceable, default: this.default, change: this.change, lines: this.lines,
      loaded: this.loaded };
  }
}

// ===========================================================================
// 7. Git
// ===========================================================================
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

/** Runs git in `root`; resolves to stdout (Buffer) or null on any failure. */
function git(root, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, ...args], { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024, timeout, env: GIT_ENV, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout));
  });
}
async function gitText(root, args, opts) {
  const out = await git(root, args, opts);
  return out ? out.toString('utf8').trim() : '';
}

async function gitInfo(root) {
  const info = {};
  if ((await gitText(root, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return info;
  info.inside = 'yes';
  info.branch = await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  info.commit = await gitText(root, ['rev-parse', '--short', 'HEAD']);
  info.last = await gitText(root, ['log', '-1', '--format=%cd  %s', '--date=short']);
  info.remote = (await gitText(root, ['config', '--get', 'remote.origin.url'])).replace(/(?<=:\/\/)[^/@]+@/, '');
  info.dirty = (await gitText(root, ['status', '--porcelain', '--untracked-files=no'])) ? 'yes' : '';
  return info;
}

/** Suggestions for the time-travel box, most useful first. */
async function gitRefs(root) {
  const names = (await gitText(root, ['for-each-ref', '--sort=-committerdate', '--count=40',
    '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags']))
    .split('\n').filter((n) => n && !n.endsWith('/HEAD'));
  const current = await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const out = ['main', 'master', 'origin/main', 'origin/master', 'develop'].filter((n) => names.includes(n) && n !== current);
  out.push('HEAD  (uncommitted changes only)', 'HEAD~1  (the previous commit)');
  for (const n of names) if (!out.includes(n) && n !== current) out.push(n);
  const log = await gitText(root, ['log', '-12', '--format=%h  %s']);
  for (const ln of log.split('\n')) if (ln) out.push(ln.slice(0, 70));
  return out;
}

async function resolveRef(root, ref) {
  ref = String(ref || '').trim();
  if (!ref || ref.startsWith('-')) throw new TardisError(`"${ref}" is not a usable git reference.`);
  const sha = await gitText(root, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
  if (!sha) throw new TardisError(`Git does not know "${ref}". Use a branch, tag or commit that exists in this repository.`);
  return sha;
}

/** Tracked + untracked-but-not-ignored files, exactly as git sees them. */
async function gitList(root) {
  if ((await gitText(root, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return null;
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeout: 180000 });
  if (!out) return null;
  return out.toString('utf8').split('\0').filter(Boolean);
}

/** Files as of a commit: [{rel, sha, size, mode}]. */
async function gitTree(root, sha) {
  const out = await git(root, ['ls-tree', '-r', '-l', '-z', sha], { timeout: 180000 });
  if (!out) throw new TardisError('Could not read that commit from git.');
  const files = [];
  for (const rec of out.toString('utf8').split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const bits = rec.slice(0, tab).split(/\s+/);
    if (bits.length < 4 || bits[1] !== 'blob') continue;
    files.push({ rel: rec.slice(tab + 1), sha: bits[2], size: /^\d+$/.test(bits[3]) ? parseInt(bits[3], 10) : 0, mode: bits[0] });
  }
  return files;
}

/** What changed between the merge base of `since` and now (or atSha). */
async function gitChanges(root, since, atSha = '') {
  const sinceSha = await resolveRef(root, since);
  const base = (await gitText(root, ['merge-base', sinceSha, atSha || 'HEAD'])) || sinceSha;
  const rng = [base].concat(atSha ? [atSha] : []);
  const raw = (await git(root, ['diff', '--name-status', '-z', '-M', '--relative', ...rng], { timeout: 120000 }) || Buffer.alloc(0)).toString('utf8');
  const toks = raw.split('\0');
  const changes = {}, deleted = [];
  for (let i = 0; i < toks.length && toks[i];) {
    const code = toks[i][0];
    if ((code === 'R' || code === 'C') && i + 2 < toks.length) {
      changes[toks[i + 2]] = code === 'R' ? `renamed from ${toks[i + 1]}` : 'added';
      i += 3;
    } else if (i + 1 < toks.length) {
      if (code === 'D') deleted.push(toks[i + 1]); else changes[toks[i + 1]] = code === 'A' ? 'added' : 'modified';
      i += 2;
    } else break;
  }
  if (!atSha) {
    const others = (await git(root, ['ls-files', '-z', '--others', '--exclude-standard']) || Buffer.alloc(0)).toString('utf8');
    for (const p of others.split('\0')) if (p && !(p in changes)) changes[p] = 'added';
  }
  const diff = decode(await git(root, ['diff', '--no-ext-diff', '--no-color', '-M', '--relative', ...rng], { timeout: 120000 }) || Buffer.alloc(0));
  const stat = decode(await git(root, ['diff', '--stat', '--relative', ...rng], { timeout: 120000 }) || Buffer.alloc(0));
  return { changes, deleted, diff, stat, base };
}

/**
 * Reads many blobs through ONE `git cat-file --batch` process. Requests are
 * written all at once and the answers parsed in order from the stream:
 *   "<sha> blob <size>\n" + <size bytes> + "\n"   (or "<sha> missing\n")
 */
function readBlobs(root, shas) {
  return new Promise((resolve) => {
    const result = new Map();
    if (!shas.length) return resolve(result);
    const proc = spawn('git', ['-C', root, 'cat-file', '--batch'], { env: GIT_ENV, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.on('error', () => resolve(result));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      let pos = 0;
      while (pos < buf.length) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        const header = buf.toString('latin1', pos, nl).split(' ');
        pos = nl + 1;
        if (header.length < 3) continue;                       // "<sha> missing"
        const size = parseInt(header[2], 10);
        result.set(header[0], buf.subarray(pos, pos + size));
        pos += size + 1;
      }
      resolve(result);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(shas.join('\n') + '\n');
  });
}

// --- remote repositories ----------------------------------------------------
const REMOTE_RE = /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/|gh:)|^(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//;
const TEMP_DIRS = [];
const isRemote = (spec) => REMOTE_RE.test(String(spec || '').trim());

/** -> {url, branch, sub, name}. Understands browser URLs with /tree/branch/path. */
function parseRemote(spec) {
  let s = spec.trim().split('#')[0].split('?')[0].replace(/\/+$/, '');
  if (s.startsWith('gh:')) s = 'https://github.com/' + s.slice(3);
  else if (!/^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s)) s = 'https://' + s;
  let branch = '', sub = '';
  const m = /^(.*?)\/(?:-\/)?(tree|blob)\/([^/]+)(?:\/(.*))?$/.exec(s);
  if (m) {
    s = m[1]; branch = m[3]; sub = m[4] || '';
    if (m[2] === 'blob') sub = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/')) : '';
  }
  const name = s.split(/[/:]/).pop().replace(/\.git$/, '') || 'repo';
  return { url: s, branch, sub, name };
}

function cleanupTemp() {
  for (const d of TEMP_DIRS) {
    try {
      const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { try { fs.chmodSync(f, 0o666); } catch { /* ignore */ } } } };
      walk(d);                                                  // git objects are read-only on Windows
      fs.rmSync(d, { recursive: true, force: true });
    } catch { /* best effort */ }
  }
}
process.on('exit', cleanupTemp);

/** Clones into a temp folder (removed on exit). -> {root, url, name}. */
async function cloneRemote(spec, needHistory = false) {
  const { url, branch, sub, name } = parseRemote(spec);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'tardis-'));
  TEMP_DIRS.push(tmp);
  const dest = path.join(tmp, name);
  const args = ['clone', '--quiet'].concat(needHistory ? [] : ['--depth', '1'], branch ? ['--branch', branch] : [], ['--', url, dest]);
  const err = await new Promise((resolve) => execFile('git', args, { timeout: 900000, env: GIT_ENV, windowsHide: true },
    (e, _o, stderr) => resolve(e ? (String(stderr || '').trim().split('\n').pop() || e.message) : '')));
  if (err) throw new TardisError(`Could not fetch ${url} - ${err}. Is the address right, and the repository public?`);
  const root = sub ? path.join(dest, sub) : dest;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new TardisError(`"${sub}" was not found in that repository.`);
  return { root, url, name };
}
/** Time travel needs history; shallow clones get the rest on demand. */
async function ensureHistory(root) {
  if ((await gitText(root, ['rev-parse', '--is-shallow-repository'])) === 'true') {
    await git(root, ['fetch', '--unshallow', '--tags', '--quiet'], { timeout: 900000 });
    await git(root, ['fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { timeout: 900000 });
  }
}

// ===========================================================================
// 8. Scanning
// ===========================================================================
const isJunkDir = (name) => JUNK_DIRS.has(name) || name.endsWith('.egg-info');
function isSecretName(name) {
  const low = name.toLowerCase();
  if (SECRET_SAFE_WORDS.some((w) => low.includes(w))) return false;
  return SECRET_NAME_RE.test(low);
}

/** Filter for paths that came from git (already .gitignore-clean). */
function listedPathOk(rel, opts, counters) {
  const parts = rel.split('/');
  if (parts.some((p) => VCS_DIRS.has(p))) return false;
  if (!opts.include_hidden && parts.some((p) => p.startsWith('.'))) { counters.hidden++; return false; }
  if (parts.slice(0, -1).some(isJunkDir)) return false;
  const name = parts[parts.length - 1];
  return !(JUNK_FILE_RE.test(name) || SNAPSHOT_RE.test(name));
}

/** Manual walk with a built-in .gitignore interpreter (when git can't help). */
async function walk(root, startRel, opts, shouldStop, counters) {
  const found = [];
  const recurse = async (dirRel, stack) => {
    const absDir = dirRel ? path.join(root, dirRel) : root;
    let items;
    try { items = (await fsp.readdir(absDir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)); }
    catch { return; }
    if (opts.use_ignore) {
      try {
        const gi = await fsp.readFile(path.join(absDir, '.gitignore'), 'utf8');
        const rules = parseIgnoreLines(gi.split('\n'));
        if (rules.length) stack = stack.concat([[dirRel, rules]]);
      } catch { /* no .gitignore here */ }
    }
    for (const d of items) {
      if (shouldStop()) throw new ScanCancelled();
      const name = d.name;
      if (VCS_DIRS.has(name) || SNAPSHOT_RE.test(name)) continue;
      if (name.startsWith('.') && !opts.include_hidden) { counters.hidden++; continue; }
      const isDir = d.isDirectory();                         // symlinks are not followed
      const rel = dirRel ? `${dirRel}/${name}` : name;
      if (opts.use_ignore) {
        if (isDir) {
          if (isJunkDir(name) || BUILD_DIRS.has(name)) continue;
          if (fs.existsSync(path.join(absDir, name, 'pyvenv.cfg'))) continue;
        } else if (JUNK_FILE_RE.test(name)) continue;
        let ignored = false;
        for (const [base, rules] of stack) {
          const v = rulesVerdict(rules, base ? rel.slice(base.length + 1) : rel, isDir);
          if (v !== null) ignored = v;
        }
        if (ignored) continue;
      }
      if (isDir) await recurse(rel, stack); else found.push(rel);
    }
  };
  await recurse(startRel, []);
  return found;
}

async function discoverFiles(root, opts, shouldStop, counters) {
  const listed = opts.use_ignore ? await gitList(root) : null;
  if (!listed) return { rels: await walk(root, '', opts, shouldStop, counters), method: 'walk' };
  const rels = [];
  const seen = new Set();
  for (const rel of listed) {
    if (shouldStop()) throw new ScanCancelled();
    if (seen.has(rel) || !listedPathOk(rel, opts, counters)) continue;
    seen.add(rel);
    let st;
    try { st = await fsp.lstat(path.join(root, rel)); } catch { continue; }
    if (st.isDirectory()) rels.push(...await walk(root, rel, opts, shouldStop, counters));   // submodule
    else rels.push(rel);
  }
  return { rels, method: 'git' };
}

async function countFileLines(abs) {
  let n = 0;
  try {
    const fh = await fsp.open(abs, 'r');
    try {
      const buf = Buffer.alloc(1 << 20);
      for (;;) { const { bytesRead } = await fh.read(buf, 0, buf.length, null); if (!bytesRead) break; for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) n++; }
    } finally { await fh.close(); }
  } catch { /* unreadable */ }
  return n;
}

/** Too big for full contents - can we still show a useful short view? */
async function condenseLarge(e, ext, data) {
  if (['csv', 'tsv', 'jsonl', 'ndjson', 'log'].includes(ext)) {
    const head = data ? data.subarray(0, 262144) : await e.readBytes(262144);
    if (!head || !head.length) return false;
    const lines = decode(head).split('\n').slice(0, -1);
    const total = data ? data.filter((b) => b === 10).length : await countFileLines(e.abs);
    const got = condenseRows(lines, Math.max(total, lines.length), ext === 'csv' || ext === 'tsv' ? 5 : 3);
    if (!got) return false;
    e._cond = [got[0], got[1], e.lang];
    e.lines = total;
  } else if (e.size <= CONDENSE_CAP) {
    if (!(await e.load(data)) || !(await e.ensureCondensed())) { e._text = null; return false; }
    e._text = null;                                   // keep memory small; reloads on demand
  } else return false;
  e.default = 'condensed';
  e.note = `too large for full contents, ${humanSize(e.size)}`;
  return true;
}

/**
 * Classifies one path. `blob` = {sha, size, mode} when reading history,
 * with its bytes in `blobData`. `unchanged` marks files outside the
 * --since scope (listed, never read).
 */
async function makeEntry(root, rel, opts, rules, { blob = null, blobData = null, change = '', unchanged = false } = {}) {
  const name = rel.split('/').pop();
  const e = new Entry(rel, path.join(root, rel));
  e.lang = detectLanguage(name);
  e.repo = root;
  e.change = change;
  const ext = extOf(name);
  if (blob) {
    e.blob = blob.sha; e.size = blob.size;
    if (blob.mode === '120000') { e.skip = 'symlink'; e.note = 'symlink'; return e; }
  } else {
    let st;
    try { st = await fsp.lstat(e.abs); } catch { e.skip = 'unreadable'; e.note = 'unreadable'; return e; }
    if (st.isSymbolicLink()) {
      try { e.link = await fsp.readlink(e.abs); } catch { e.link = '?'; }
      e.skip = 'symlink'; e.note = `symlink to ${e.link}`; return e;
    }
    if (!st.isFile()) { e.skip = 'special'; e.note = 'not a regular file'; return e; }
    e.size = st.size;
  }
  const size = humanSize(e.size);
  if (BINARY_EXTS.has(ext)) {
    let what = '';
    if (IMAGE_EXTS.has(ext) && !blob) what = imageInfo((await e.readBytes(262144)) || Buffer.alloc(0));
    e.skip = 'binary'; e.note = `${what || 'binary'}, ${size}`; return e;
  }
  if (unchanged) { e.skip = 'unchanged'; e.note = 'unchanged'; e.forceable = true; return e; }
  let data = null, head;
  if (blob) { data = blobData; head = (data || Buffer.alloc(0)).subarray(0, 8192); }
  else head = (await e.readBytes(8192)) || Buffer.alloc(0);
  if (looksBinary(head)) { e.skip = 'binary'; e.note = `binary, ${size}`; return e; }
  const low = name.toLowerCase();
  e.forceable = true;
  if (rules.omit.matches(rel)) { e.skip = 'user'; e.note = 'left out by user'; }
  else if (!opts.include_secrets && isSecretName(low)) { e.skip = 'secret'; e.note = 'withheld, may contain secrets'; }
  else if (!opts.include_locks && LOCK_FILES.has(low)) { e.skip = 'lock'; e.note = `lock file, ${size}`; }
  else if (!opts.include_locks && GENERATED_RE.test(low)) { e.skip = 'generated'; e.note = `generated/minified, ${size}`; }
  else if (e.size > opts.max_size_kb * 1024) {
    if (!(await condenseLarge(e, ext, data))) { e.skip = 'large'; e.note = `too large, ${size}`; }
  } else if (!(await e.load(data))) { e.forceable = false; e.skip = 'unreadable'; e.note = 'unreadable'; }
  else if (['ipynb', 'csv', 'tsv', 'jsonl', 'ndjson'].includes(ext) || rules.condense.matches(rel)) {
    if (await e.ensureCondensed()) e.default = 'condensed';
  }
  return e;
}

/** Files before folders at every level; the root README goes first. */
function sortKey(rel) {
  const parts = rel.split('/');
  const key = parts.slice(0, -1).map((p) => [1, p.toLowerCase(), p]);
  const name = parts[parts.length - 1];
  const first = parts.length === 1 && name.toLowerCase().startsWith('readme');
  key.push([0, first ? '' : name.toLowerCase(), name]);
  return key;
}
function compareRel(a, b) {
  const ka = sortKey(a), kb = sortKey(b);
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    for (let j = 0; j < 3; j++) if (ka[i][j] !== kb[i][j]) return ka[i][j] < kb[i][j] ? -1 : 1;
  }
  return ka.length - kb.length;
}

/**
 * The scan. Resolves to a ScanResult: {root, name, entries, git, method,
 * hiddenSkipped, opts, changes, deleted, diff, diffstat, base, atSha, refs}.
 * `progress(message)` is called every 100 files; `shouldStop()` aborts.
 */
async function scanProject(opts, { shouldStop = () => false, progress = null, skipRel = '' } = {}) {
  let root = path.resolve(opts.root.replace(/^~(?=$|[/\\])/, os.homedir()));
  let st;
  try { st = await fsp.stat(root); } catch { st = null; }
  if (!st || !st.isDirectory()) throw new TardisError(`Not a folder: ${root}`);
  opts = { ...opts, root };
  const info = await gitInfo(root);
  if ((opts.since || opts.at) && !info.inside) throw new TardisError('Time travel needs a git repository, and this folder is not one.');
  const counters = { hidden: 0 };
  const atSha = opts.at ? await resolveRef(root, opts.at) : '';
  let changes = {}, deleted = [], diff = '', diffstat = '', base = '';
  if (opts.since) ({ changes, deleted, diff, stat: diffstat, base } = await gitChanges(root, opts.since, atSha));
  const blobs = new Map();
  let rels, method;
  if (atSha) {
    method = 'git history';
    rels = [];
    for (const f of await gitTree(root, atSha)) if (listedPathOk(f.rel, opts, counters)) { rels.push(f.rel); blobs.set(f.rel, f); }
  } else ({ rels, method } = await discoverFiles(root, opts, shouldStop, counters));
  const exclude = new GlobSet(opts.exclude_globs), include = new GlobSet(opts.include_globs);
  if (!exclude.empty) rels = rels.filter((r) => !exclude.matches(r));
  if (!include.empty) rels = rels.filter((r) => include.matches(r));
  const rules = { omit: new GlobSet(opts.omit_globs), condense: new GlobSet(opts.condense_globs) };
  let blobData = new Map();
  if (atSha) {
    const cap = Math.max(opts.max_size_kb * 1024, CONDENSE_CAP);
    const want = rels.map((r) => blobs.get(r)).filter((b) => b && b.size <= cap && b.mode !== '120000' && !BINARY_EXTS.has(extOf(b.rel)));
    blobData = await readBlobs(root, want.map((b) => b.sha));
  }
  const entries = [];
  for (const rel of rels) {
    if (shouldStop()) throw new ScanCancelled();
    if (rel === skipRel) continue;
    const change = changes[rel] || '';
    const blob = blobs.get(rel) || null;
    entries.push(await makeEntry(root, rel, opts, rules, { blob, blobData: blob ? blobData.get(blob.sha) || null : null, change, unchanged: !!opts.since && !change }));
    if (progress && entries.length % 100 === 0) progress(`${fmtInt(entries.length)} files scanned`);
  }
  entries.sort((a, b) => compareRel(a.rel, b.rel));
  const refs = info.inside ? await gitRefs(root) : [];
  return { root, name: path.basename(root) || root, entries, git: info, method, hiddenSkipped: counters.hidden,
    opts, changes, deleted, diff, diffstat, base, atSha, refs, _graph: null,
    importGraph() { if (!this._graph) this._graph = buildImportGraph(this.entries); return this._graph; } };
}

/** Quick list of existing files (for matching file names in replies). */
async function listFiles(root, cap = 20000) {
  const out = new Set();
  const recurse = async (dir, rel) => {
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of items) {
      if (out.size >= cap) return;
      if (d.isDirectory()) { if (!VCS_DIRS.has(d.name) && !JUNK_DIRS.has(d.name)) await recurse(path.join(dir, d.name), rel ? `${rel}/${d.name}` : d.name); }
      else out.add(rel ? `${rel}/${d.name}` : d.name);
    }
  };
  await recurse(root, '');
  return out;
}

// ===========================================================================
// 9. Import graph
// ===========================================================================
const PY_FROM_RE = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([^\n#]*)/gm;
const PY_IMPORT_RE = /^[ \t]*import[ \t]+([^\n#]+)/gm;
const JS_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
const JS_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];
const JS_LANGS = new Set(['javascript', 'typescript', 'jsx', 'tsx', 'vue', 'svelte', 'astro', 'mdx']);
const QUOTED_IMPORTS = {
  c: /#\s*include\s*"([^"]+)"/g, cpp: /#\s*include\s*"([^"]+)"/g,
  objectivec: /#\s*(?:include|import)\s*"([^"]+)"/g,
  css: /@import\s+(?:url\()?["']([^"']+)["']/g, scss: /@(?:import|use|forward)\s+["']([^"']+)["']/g,
  less: /@import\s+["']([^"']+)["']/g, ruby: /require_relative\s+["']([^"']+)["']/g,
  php: /(?:require|include)(?:_once)?[\s(]+(?:__DIR__\s*\.\s*)?["']\/?([^"']+)["']/g,
  html: /(?:src|href)\s*=\s*["']([^"'#?:]+)["']/g,
};
const QUOTED_SUFFIXES = ['', '.rb', '.css', '.scss', '.less', '.h', '.hpp', '.php'];

const posixNorm = (p) => path.posix.normalize(p);
const posixDir = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** rel -> Set of project files it imports (best effort, by regex). */
function buildImportGraph(entries) {
  const paths = new Set(entries.map((e) => e.rel));
  const suffix = new Map(), byDir = new Map();
  for (const rel of paths) {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) { const k = parts.slice(i).join('/'); if (!suffix.has(k)) suffix.set(k, []); suffix.get(k).push(rel); }
    const d = parts.slice(0, -1).join('/');
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d).push(rel);
  }
  const goMod = entries.find((e) => e.rel === 'go.mod' && e.loaded);
  const gomod = goMod ? ((/^module\s+(\S+)/m.exec(goMod._text) || [])[1] || '') : '';
  const common = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  const near = (sfx, src) => {
    const cands = suffix.get(sfx.replace(/^\/+/, ''));
    if (!cands) return null;
    const here = src.includes('/') ? src.slice(0, src.lastIndexOf('/') + 1) : '';
    return cands.slice().sort((a, b) => common(b, here) - common(a, here) || a.length - b.length)[0];
  };
  const join = (src, spec) => { const p = posixNorm(path.posix.join(posixDir(src), spec)); return p.startsWith('..') ? null : p; };
  const graph = {};
  for (const e of entries) {
    if (!e.loaded) continue;
    const text = e._text, rel = e.rel, found = new Set();
    if (e.lang === 'python') {
      for (const m of text.matchAll(PY_FROM_RE)) {
        const dots = m[1], mod = m[2].replace(/\./g, '/'), names = m[3];
        let stem;
        if (dots) { let base = posixDir(rel); for (let i = 1; i < dots.length; i++) base = posixDir(base); stem = mod ? path.posix.join(base, mod) : base; }
        else stem = mod;
        const cands = [stem].concat(names.replace(/[()\s]+$/, '').split(',').map((n) => n.trim().split(/\s+/)[0]).filter((n) => n && n !== '*').map((n) => `${stem}/${n}`));
        for (const c of cands) for (const tail of ['.py', '/__init__.py']) {
          const p = c.replace(/^\/+|\/+$/g, '') + tail;
          const hit = dots ? (paths.has(p) ? p : null) : near(p, rel);
          if (hit) found.add(hit);
        }
      }
      for (const m of text.matchAll(PY_IMPORT_RE)) for (const name of m[1].split(',')) {
        const w = name.trim().split(/\s+/)[0];
        if (!w) continue;
        for (const tail of ['.py', '/__init__.py']) { const hit = near(w.replace(/\./g, '/') + tail, rel); if (hit) found.add(hit); }
      }
    } else if (JS_LANGS.has(e.lang)) {
      for (const m of text.matchAll(JS_IMPORT_RE)) {
        const spec = m[1];
        let bases;
        if (spec.startsWith('.')) bases = [join(rel, spec)];
        else if (spec.startsWith('@/') || spec.startsWith('~/')) bases = ['src/' + spec.slice(2), spec.slice(2), 'app/' + spec.slice(2)];
        else continue;
        for (const base of bases) {
          if (!base) continue;
          const tries = JS_SUFFIXES.map((s) => base + s);
          if (base.endsWith('.js')) tries.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
          const hit = tries.find((t) => paths.has(t));
          if (hit) { found.add(hit); break; }
        }
      }
    } else if (QUOTED_IMPORTS[e.lang]) {
      for (const m of text.matchAll(QUOTED_IMPORTS[e.lang])) {
        const base = join(rel, m[1]) || '';
        const tries = QUOTED_SUFFIXES.map((s) => base + s);
        tries.push(path.posix.join(posixDir(base), '_' + path.posix.basename(base) + '.scss'));
        const hit = tries.find((t) => paths.has(t)) || near(m[1], rel);
        if (hit) found.add(hit);
      }
    } else if (e.lang === 'go' && gomod) {
      for (const m of text.slice(0, 20000).matchAll(/"([^"\s]+)"/g)) {
        if (m[1].startsWith(gomod + '/')) for (const f of byDir.get(m[1].slice(gomod.length + 1)) || []) if (f.endsWith('.go') && !f.endsWith('_test.go')) found.add(f);
      }
    } else if (['java', 'kotlin', 'scala', 'groovy'].includes(e.lang)) {
      for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) {
        const p = m[1].replace(/\./g, '/');
        for (const cand of [p, p.slice(0, p.lastIndexOf('/'))]) {
          const hit = ['.java', '.kt', '.scala', '.groovy'].map((x) => near(cand + x, rel)).find(Boolean);
          if (hit) { found.add(hit); break; }
        }
      }
    } else if (e.lang === 'rust') {
      const d = posixDir(rel), stem = path.posix.basename(rel).replace(/\.[^.]+$/, '');
      const home = ['main', 'lib', 'mod'].includes(stem) ? d : path.posix.join(d, stem);
      for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) {
        for (const p of [`${home}/${m[1]}.rs`, `${home}/${m[1]}/mod.rs`]) { const q = p.replace(/^\/+/, ''); if (paths.has(q)) found.add(q); }
      }
    }
    found.delete(rel);
    if (found.size) graph[rel] = found;
  }
  return graph;
}
function importClosure(graph, starts) {
  const seen = new Set(starts), todo = [...seen];
  while (todo.length) for (const n of graph[todo.pop()] || []) if (!seen.has(n)) { seen.add(n); todo.push(n); }
  return seen;
}
/** Selection that keeps only `starts` plus everything they import. */
function focusSelection(scan, starts, importers = false) {
  const startSet = new Set(starts);
  const graph = scan.importGraph();
  const keep = importClosure(graph, startSet);
  if (importers) for (const [src, targets] of Object.entries(graph)) if ([...targets].some((t) => startSet.has(t))) keep.add(src);
  const sel = {};
  for (const e of scan.entries) {
    if (!e.checkable) continue;
    if (keep.has(e.rel)) { if (e.skip) sel[e.rel] = 'full'; } else sel[e.rel] = 'off';
  }
  return { sel, keep };
}

// ===========================================================================
// 10. Priorities and the plan
// ===========================================================================
/** How much a file matters (higher = trimmed later). Rough but explainable. */
function priority(e, inDegree = 0) {
  if (e.change) return 150;
  const rel = e.rel.toLowerCase(), parts = rel.split('/');
  const name = parts[parts.length - 1], dirs = parts.slice(0, -1), depth = parts.length - 1;
  const stem = name.replace(/\.[^.]*$/, '');
  if (depth === 0 && name.startsWith('readme')) return 100;
  if (MANIFESTS.has(name)) return 90 - 5 * depth;
  if (dirs.some((d) => LOW_DIRS.has(d))) return 15;
  if (dirs.some((d) => TEST_DIRS.has(d)) || TEST_NAME_RE.test(name)) return 25;
  if (/^(license|licence|changelog|history|authors|contributors|code_of_conduct|notice|copying)/.test(name)) return 10;
  if (DOC_LANGS.has(e.lang)) return depth === 0 ? 40 : 35;
  if (DATA_LANGS.has(e.lang)) return e.lang === 'csv' || e.lang === 'svg' ? 20 : 40;
  return (ENTRY_STEMS.has(stem) ? 80 : 60) - 2 * Math.min(depth, 5) + Math.min(15, 3 * inDegree);
}

/**
 * Decides, per file, full / condensed / off. `selection` holds explicit user
 * choices (pinned; the budget never touches them). Async because forcing a
 * withheld file in means reading it now.
 */
async function makePlan(scan, selection = {}) {
  const items = [];
  for (const e of scan.entries) {
    let want = selection[e.rel];
    const pinned = want !== undefined && want !== null;
    if (!pinned) want = e.skip ? 'off' : e.default;
    if (want !== 'off') {
      let ok = !e.skip || (e.forceable && await e.load());
      let note = '';
      if (ok && want === 'condensed' && !(await e.ensureCondensed())) { want = 'full'; note = 'no shorter view exists; shown in full'; }
      if (ok && want === 'full' && !(await e.load())) ok = false;
      if (ok) items.push({ e, mode: want, note, code: '', pinned, auto: '', label: '' });
      else if (e.skip && !e.forceable) items.push({ e, mode: 'off', note: e.note, code: e.skip, pinned, auto: '', label: '' });
      else items.push({ e, mode: 'off', note: 'unreadable', code: 'unreadable', pinned, auto: '', label: '' });
    } else if (e.skip) items.push({ e, mode: 'off', note: e.note, code: e.skip, pinned, auto: '', label: '' });
    else items.push({ e, mode: 'off', note: 'left out by user', code: 'user', pinned, auto: '', label: '' });
  }
  return items;
}

/**
 * Ordered list of [item, newMode]: what to give up first when over budget.
 * A file is condensed at its priority and dropped at priority + 25, so a
 * low-priority file disappears before an important one is even condensed.
 */
async function trimSteps(scan, items, redact, numbered) {
  let graph = {};
  try { graph = scan.importGraph(); } catch { /* graph is optional */ }
  const indeg = {};
  for (const targets of Object.values(graph)) for (const t of targets) indeg[t] = (indeg[t] || 0) + 1;
  const steps = [];
  for (const it of items) {
    if (it.pinned || it.mode === 'off') continue;
    const p = priority(it.e, indeg[it.e.rel] || 0);
    const tok = it.e.view(it.mode, redact, numbered).tokens;
    if (it.mode === 'full' && await it.e.ensureCondensed()) {
      if (it.e.view('condensed', redact, numbered).tokens < tok * 0.7) steps.push({ key: [p, 0, -tok], it, to: 'condensed' });
    }
    steps.push({ key: [p + 25, 1, -tok], it, to: 'off' });
  }
  steps.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  return steps.map((s) => [s.it, s.to]);
}

// ===========================================================================
// 11. Rendering
// ===========================================================================
function fenceFor(text) {
  let longest = 0;
  for (const m of text.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
  return BT.repeat(Math.max(3, longest + 1));
}
const partEnd = (k, n) => `END OF PART ${k} OF ${n} - more parts follow. Do not answer yet: reply only "Received part ${k} of ${n}" and wait for the rest.`;

/**
 * Output formats. Each one is a small object with the same methods; the
 * Markdown one is the reference, the others override what differs.
 */
const MarkdownFmt = {
  tick: BT,
  marker: 'a heading of the form "### FILE n/N: `relative/path`" followed by a fenced code block holding the file contents',
  head: (name) => [`# Project snapshot: ${name}`, '', `> Packed by ${APP_NAME} v${VERSION} (${APP_LONG}) - "${TAGLINE}"`,
    '> One document holding the folder structure and file contents of an entire project.', ''],
  heading: (title) => [`## ${title}`, ''],
  section(key, title, lines, pre = false, lang = 'text') {
    if (pre) { const f = fenceFor(lines.join('\n')); lines = [f + lang, ...lines, f]; }
    return [`## ${title}`, '', ...lines, ''];
  },
  kv: (rows) => rows.map(([k, v]) => `- **${k}:** ${v}`),
  index(rows) {
    if (!rows.length) return ['_No file contents are included._'];
    return ['| # | File | Type | Lines | Tokens |', '|--:|:-----|:-----|------:|-------:|',
      ...rows.map(([i, rel, kind, lines, tok]) => `| ${i} | \`${rel.replace(/\|/g, '\\|')}\` | ${kind} | ${fmtInt(lines)} | ${fmtInt(tok)} |`)];
  },
  file(i, n, rel, flags, meta, lang, body) {
    const fence = fenceFor(body);
    const anchor = `### FILE ${i}/${n}${flags ? ` (${flags})` : ''}: \`${rel}\``;
    return { head: ['---', '', anchor, '', `*${meta}*`, '', fence + lang], foot: [fence, ''], anchor };
  },
  partHead: (name, k, n, note) => [`# Project snapshot: ${name} - part ${k} of ${n}`, '', `> ${note}`, ''],
  partFoot: (k, n) => ['---', '', partEnd(k, n), ''],
  end: (footer) => ['---', '', footer, ''],
  close: () => [],
};
const XmlFmt = {
  ...MarkdownFmt, tick: '',
  marker: 'a <file index="n" path="relative/path" ...> line and ends with a </file> line; the text in between is the exact, unescaped file contents',
  head: (name) => [`<project_snapshot name="${escapeHtml(name)}" generator="${APP_NAME} ${VERSION}">`, ''],
  heading: () => [],
  section: (key, title, lines) => [`<${key}>`, ...lines, `</${key}>`, ''],
  kv: (rows) => rows.map(([k, v]) => `${k}: ${v}`),
  index: (rows) => rows.length ? rows.map(([i, rel, kind, lines, tok]) => `${i}. ${rel} (${kind}, ${plural(lines, 'line')}, ~${fmtInt(tok)} tokens)`) : ['(no file contents included)'],
  file(i, n, rel, flags, meta, lang) {
    const anchor = `<file index="${i}" path="${escapeHtml(rel)}"`;
    return { head: [`${anchor} of="${n}" language="${lang}"${flags ? ` view="${escapeHtml(flags)}"` : ''} note="${escapeHtml(meta)}">`], foot: ['</file>', ''], anchor };
  },
  partHead: (name, k, n, note) => [`<project_snapshot name="${escapeHtml(name)}" part="${k}" of="${n}">`, note, ''],
  partFoot: (k, n) => [partEnd(k, n), '</project_snapshot>'],
  end: (footer) => [footer],
  close: () => ['</project_snapshot>', ''],
};
const BAR = '='.repeat(80), THIN = '-'.repeat(80);
const TextFmt = {
  ...MarkdownFmt, tick: '',
  marker: 'a banner line "FILE n/N: relative/path" and ends with a line "END OF FILE: relative/path"',
  head: (name) => [BAR, `PROJECT SNAPSHOT: ${name}`, `Packed by ${APP_NAME} v${VERSION} (${APP_LONG}) - "${TAGLINE}"`, BAR, ''],
  heading: (title) => [title.toUpperCase(), THIN, ''],
  section: (key, title, lines) => [title.toUpperCase(), THIN, ...lines, ''],
  kv(rows) { const w = Math.max(...rows.map(([k]) => k.length)) + 1; return rows.map(([k, v]) => `${(k + ':').padEnd(w)} ${v}`); },
  index: (rows) => rows.length ? rows.map(([i, rel, kind, lines, tok]) => `${String(i).padStart(4)}. ${rel}  (${kind}, ${plural(lines, 'line')}, ~${fmtInt(tok)} tokens)`) : ['(no file contents included)'],
  file(i, n, rel, flags, meta) {
    const anchor = `FILE ${i}/${n}${flags ? ` (${flags})` : ''}: ${rel}`;
    return { head: [BAR, anchor, `(${meta})`, BAR], foot: [`-------- END OF FILE: ${rel} --------`, ''], anchor };
  },
  partHead: (name, k, n, note) => [BAR, `PROJECT SNAPSHOT: ${name} - PART ${k} OF ${n}`, note, BAR, ''],
  partFoot: (k, n) => [BAR, partEnd(k, n), BAR, ''],
  end: (footer) => [BAR, footer, BAR, ''],
};
const FORMATS = { markdown: MarkdownFmt, xml: XmlFmt, text: TextFmt };

/** The directory map, with one line per file and the status tags. */
function renderTree(name, items, treeOnly) {
  const node = () => ({ dirs: new Map(), files: [], total: 0, quiet: 0, same: 0 });
  const top = node();
  for (const it of items) {
    const parts = it.e.rel.split('/');
    let cur = top;
    for (const d of parts.slice(0, -1)) { if (!cur.dirs.has(d)) cur.dirs.set(d, node()); cur = cur.dirs.get(d); }
    cur.files.push([parts[parts.length - 1], it]);
  }
  const tally = (nd) => {
    nd.total = nd.files.length;
    for (const [, it] of nd.files) if (it.mode === 'off' && (it.code === 'user' || it.code === 'unchanged')) { nd.quiet++; if (it.code === 'unchanged') nd.same++; }
    for (const sub of nd.dirs.values()) { tally(sub); nd.total += sub.total; nd.quiet += sub.quiet; nd.same += sub.same; }
  };
  tally(top);
  const label = (fname, it) => {
    const e = it.e;
    if (it.code === 'symlink') return e.link ? `${fname} -> ${e.link}` : `${fname}  [symlink]`;
    const tag = e.change ? `  [${e.change}]` : '';
    if (treeOnly) {
      if (e.lines) return `${fname}  (${plural(e.lines, 'line')})${tag}`;
      return ['user', 'unchanged', 'budget', ''].includes(it.code) ? fname + tag : `${fname}  [${it.note}]`;
    }
    if (it.mode === 'full') return fname + tag;
    if (it.mode === 'condensed') return `${fname}  [condensed: ${it.label}]${tag}`;
    if (it.code === 'unchanged') return fname;
    return `${fname}  [omitted: ${it.note}]`;
  };
  const lines = [name + '/'];
  const walkNode = (nd, prefix) => {
    const kids = nd.files.map((f) => ['f', f]).concat([...nd.dirs.entries()].map((kv) => ['d', kv]));
    kids.forEach(([kind, payload], idx) => {
      const last = idx === kids.length - 1;
      const branch = last ? '└── ' : '├── ';
      if (kind === 'f') { lines.push(prefix + branch + label(payload[0], payload[1])); return; }
      const [dname, sub] = payload;
      if (!treeOnly && sub.total && sub.total === sub.quiet) {
        const what = sub.same === sub.total ? `(${plural(sub.total, 'unchanged file')})` : `[omitted: ${plural(sub.total, 'file')} left out]`;
        lines.push(`${prefix}${branch}${dname}/  ${what}`);
      } else { lines.push(prefix + branch + dname + '/'); walkNode(sub, prefix + (last ? '    ' : '│   ')); }
    });
  };
  walkNode(top, '');
  return lines.join('\n');
}

function filtersText(scan) {
  const o = scan.opts;
  const bits = ['hidden files ' + (o.include_hidden ? 'included' : 'excluded')];
  if (!o.use_ignore) bits.push('ignore rules off');
  else if (scan.method === 'git') bits.push('.gitignore respected (via git)');
  else if (scan.method === 'walk') bits.push('.gitignore and default junk-folder rules applied');
  bits.push(`files over ${o.max_size_kb} KB condensed or omitted`);
  if (!o.include_locks) bits.push('lock/minified files omitted');
  if (!o.include_secrets) bits.push('secret-looking files withheld');
  if (o.include_globs.length) bits.push('only: ' + o.include_globs.join(', '));
  if (o.exclude_globs.length) bits.push('excluded: ' + o.exclude_globs.join(', '));
  return bits.join('; ');
}

/** One file section: {rel, i, n, flags, meta, lang, body, head, foot, anchor, tokens}. */
function makeSec(fmt, i, n, it, v) {
  const e = it.e;
  let flags = '', meta;
  if (it.mode === 'condensed') {
    flags = 'condensed';
    meta = `CONDENSED VIEW (${v.label}) - not the complete file` + (e.lines ? `; the full file has ${plural(e.lines, 'line')}` : '');
  } else meta = `${langName(e.lang)} · ${plural(e.lines, 'line')} · ~${fmtInt(v.tokens)} tokens` + (v.body ? '' : ' · empty file');
  if (e.change) meta += ` · ${e.change}`;
  const { head, foot, anchor } = fmt.file(i, n, e.rel, flags, meta, v.lang, v.body);
  return { rel: e.rel, i, n, flags, meta, lang: v.lang, body: v.body, head, foot, anchor, tokens: v.tokens + TOKENS.count(head.concat(foot).join('\n')) };
}

/** Splits any single file that is bigger than a whole part, by line ranges. */
function chunkSections(fmt, secs, cap) {
  const out = [];
  for (const s of secs) {
    if (s.tokens <= cap) { out.push(s); continue; }
    const lines = s.body.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const per = Math.max(10, Math.floor(total * Math.max(cap - 80, 100) / Math.max(1, s.tokens) * 0.9));
    for (let a = 0; a < total; a += per) {
      const b = Math.min(total, a + per);
      const flags = [s.flags, a ? 'continued' : '', `lines ${a + 1}-${b} of ${total}`].filter(Boolean).join(', ');
      const body = lines.slice(a, b).join('\n') + '\n';
      const { head, foot, anchor } = fmt.file(s.i, s.n, s.rel, flags, s.meta, s.lang, body);
      out.push({ ...s, flags, body, head, foot, anchor, tokens: TOKENS.count(body) + TOKENS.count(head.concat(foot).join('\n')) });
    }
  }
  return out;
}
/** Greedy packing of sections into parts no larger than the budget. */
function packParts(frontTok, secs, tailTok, budget, overhead = 120) {
  const groups = [[]];
  let used = frontTok + overhead;
  for (const s of secs) {
    if (used + s.tokens > budget && (groups[groups.length - 1].length || groups.length === 1)) { groups.push([]); used = overhead; }
    groups[groups.length - 1].push(s);
    used += s.tokens;
  }
  if (used + tailTok > budget && groups[groups.length - 1].length && tailTok > 0) groups.push([]);
  return groups;
}

/**
 * plan -> (trim to budget) -> render -> (split into parts).
 * Resolves to a Document:
 *   {parts, partTokens, tokens, items, filesFull, filesCondensed, filesOff,
 *    lines, secrets, redacted, anchors, omittedCounts, fileTokens, budget,
 *    overBudget, trimmed, squeezed, counter, languages}
 */
async function buildDocument(scan, opts, selection = {}) {
  const fmt = FORMATS[opts.fmt] || MarkdownFmt;
  const items = await makePlan(scan, selection);
  const { redact, line_numbers: numbered, tree_only: treeOnly } = opts;
  const so = scan.opts;
  const budget = treeOnly ? 0 : opts.budget;
  const when = new Date().toISOString().slice(0, 16).replace('T', ' ');

  let diffText = '', diffNote = '';
  if (so.since && opts.include_diff && scan.diff) {
    diffText = scan.diff.replace(/\n+$/, '');
    const dtok = TOKENS.count(diffText);
    if (diffText.length > 400000 || (budget && dtok > budget * 0.4)) {
      diffText = scan.diffstat.replace(/\n+$/, '');
      diffNote = 'The full diff was too large for this snapshot; this is the summary (git diff --stat).';
    }
  }
  let tail = [];
  if (opts.task.trim()) tail = tail.concat(fmt.section('task', 'Your task', opts.task.trim().split('\n')));
  if (opts.reply_format && !treeOnly) tail = tail.concat(fmt.section('reply_format', 'How to send back file changes', REPLY_FORMAT));
  const tailTok = TOKENS.count(tail.join('\n'));

  const state = {};
  /** Everything before the file sections. Depends on the totals, hence a function. */
  const front = (sizeText, nParts) => {
    const live = state.live;
    const nFull = live.filter((it) => it.mode === 'full').length, nCond = live.length - nFull;
    const off = items.filter((it) => it.mode === 'off');
    const counts = state.counts, nRed = state.redacted;
    const g = [`This is a snapshot of the project folder "${scan.name}/", packed into one document so the whole project can be read or pasted in one go.`];
    if (nParts > 1) g.push(`Because of its size the snapshot is split into ${nParts} parts; this is part 1. Wait until you have all ${nParts} parts before answering - until then reply only "Received part k of ${nParts}".`);
    g.push('OVERVIEW: key facts and statistics about the project.');
    if (so.since) g.push('CHANGES: what changed since the chosen git reference' + (diffText ? ', followed by the diff' : '') + '. Only changed files have their contents included; in the map they are tagged [modified], [added] or [renamed ...]; everything else is unchanged.');
    if (treeOnly) g.push('DIRECTORY MAP: the complete folder tree with line counts. This is a structure-only snapshot: file contents were deliberately left out.');
    else {
      g.push('DIRECTORY MAP: the folder tree. Entries tagged [omitted: reason] exist in the project but their contents are not in this document.');
      if (nCond) g.push('Entries tagged [condensed: ...] are included as a shortened view (an outline with bodies collapsed, a sample of rows, a structure sketch). Their sections are marked CONDENSED VIEW; they are not the complete file.');
      g.push('FILE INDEX: numbered list of every included file.');
      g.push(`FILE CONTENTS: one section per file, in index order. Each section starts with ${fmt.marker}.`);
      g.push('Headings, separators and metadata lines between sections are labels, not file content.');
      if (numbered) g.push('Every content line is prefixed with its line number ("  12 | "); the prefix is not part of the file.');
      if (nRed) g.push('[REDACTED:...] placeholders stand for secret values removed before sharing. Treat them as opaque and keep them unchanged.');
    }
    g.push('All paths are relative to the project root and use forward slashes.');
    if (tail.length) g.push('After the snapshot ends you will find ' + (opts.task.trim() ? 'the task to carry out' : 'instructions for sending back file changes') + '.');
    g.push('The marker "END OF SNAPSHOT" closes the snapshot. If it is missing, the document was cut off.');
    const rows = [['Project', scan.name]];
    if (so.source) rows.push(['Source', so.source]);
    rows.push(['Snapshot taken', when]);
    const gi = scan.git;
    if (gi.inside) {
      const bits = [];
      if (gi.branch) bits.push(gi.branch === 'HEAD' ? 'detached HEAD' : `branch ${gi.branch}`);
      if (gi.commit) bits.push(`commit ${gi.commit}`);
      if (gi.dirty && !so.at) bits.push('with uncommitted changes');
      rows.push(['Git', bits.join(', ') || 'repository with no commits yet']);
      if (gi.remote) rows.push(['Remote', gi.remote]);
    }
    if (so.at) rows.push(['Time travel', `the project as it was at ${so.at} (commit ${scan.atSha.slice(0, 10)}), not as it is now`]);
    if (so.since) rows.push(['Scope', `only what changed since ${so.since} (compared with commit ${scan.base.slice(0, 10)})`]);
    if (treeOnly) rows.push(['Files', `${plural(items.length, 'file')} listed (structure only, no contents)`]);
    else {
      rows.push(['Files included', `${fmtInt(nFull)} in full${nCond ? `, ${fmtInt(nCond)} condensed` : ''} (${plural(state.lines, 'line')})`]);
      const shown = Object.entries(counts).filter(([c]) => c !== 'unchanged');
      if (shown.length) rows.push(['Listed in map only', `${fmtInt(shown.reduce((a, [, n]) => a + n, 0))} (${shown.sort((a, b) => b[1] - a[1]).map(([c, n]) => `${fmtInt(n)} ${REASON_LABELS[c] || c}`).join(', ')})`]);
    }
    if (budget) {
      if (opts.over === 'split') rows.push(['Token budget', `${fmtInt(budget)} per part - ` + (nParts > 1 ? `split into ${nParts} parts` : 'everything fits in one part')]);
      else rows.push(['Token budget', `${fmtInt(budget)} - ` + ((state.squeezed || state.trimmed) ? `to fit, ${plural(state.squeezed, 'file')} were condensed and ${fmtInt(state.trimmed)} left out, lowest priority first` : 'everything fits')]);
    }
    if (sizeText) rows.push(['Approx. size', `${sizeText} (${TOKENS.name})`]);
    if (state.lines) rows.push(['Languages', state.languages.slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(0)}%`).join(', ')]);
    if (nRed) rows.push(['Redactions', `${plural(nRed, 'secret-looking value')} replaced by [REDACTED:...] placeholders`]);
    rows.push(['Filters', filtersText(scan)]);
    let L = fmt.head(scan.name);
    L = L.concat(fmt.section('guide', 'How to read this document', g.map((x) => '- ' + x)));
    L = L.concat(fmt.section('overview', 'Overview', fmt.kv(rows)));
    if (so.since) {
      const ch = Object.entries(scan.changes).sort().map(([rel, what]) => `- ${what}: ${rel}`).concat(scan.deleted.slice().sort().map((rel) => `- deleted: ${rel}`));
      L = L.concat(fmt.section('changes', `Changes since ${so.since}`, ch.length ? ch : ['(nothing changed)']));
      if (diffText) {
        if (diffNote) L = L.concat(fmt.tick ? [`_${diffNote}_`, ''] : [diffNote, '']);
        L = L.concat(fmt.section('diff', 'Diff', diffText.split('\n'), true, 'diff'));
      }
    }
    L = L.concat(fmt.section('directory_map', 'Directory map', renderTree(scan.name, items, treeOnly).split('\n'), true));
    if (!treeOnly) {
      let idx = fmt.index(state.index);
      const t = fmt.tick;
      const auto = off.filter((it) => !['user', 'unchanged', 'budget'].includes(it.code));
      const extra = auto.slice(0, 60).map((it) => `${t}${it.e.rel}${t} - ${it.note}`);
      if (auto.length > 60) extra.push(`...and ${fmtInt(auto.length - 60)} more (each is tagged in the map)`);
      if (counts.budget) extra.push(`${plural(counts.budget, 'file')} trimmed to fit the token budget (each is tagged in the map)`);
      if (counts.user) extra.push(`${plural(counts.user, 'file')} left out by user`);
      if (extra.length) idx = idx.concat(['', 'Listed in the map but NOT included:', ''], extra.map((x) => '- ' + x));
      L = L.concat(fmt.section('file_index', 'File index', idx));
      L = L.concat(fmt.heading('File contents'));
    }
    return L;
  };

  let steps = null, pos = 0, secs = [], total = 0, frontTok = 0, findings = [];
  for (let round = 0; round < 12; round++) {
    const live = treeOnly ? [] : items.filter((it) => it.mode !== 'off');
    secs = []; findings = [];
    live.forEach((it, i) => {
      const v = it.e.view(it.mode, redact, numbered);
      it.label = v.label;
      secs.push(makeSec(fmt, i + 1, live.length, it, v));
      for (const f of v.findings) findings.push([it.e.rel, f.line, f.kind]);
    });
    const counts = {};
    for (const it of items) if (it.mode === 'off') counts[it.code] = (counts[it.code] || 0) + 1;
    const langs = {};
    for (const it of live) { const k = langName(it.e.lang); langs[k] = (langs[k] || 0) + it.e.lines; }
    const lines = live.reduce((a, it) => a + it.e.lines, 0);
    Object.assign(state, {
      live, counts, lines, redacted: redact ? findings.length : 0,
      squeezed: items.filter((it) => it.auto && it.mode === 'condensed').length,
      trimmed: counts.budget || 0,
      languages: Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v * 100 / Math.max(1, lines)]),
      index: secs.map((s, i) => [s.i, s.rel, s.flags ? 'condensed' : langName(live[i].e.lang), live[i].e.lines, s.tokens]),
    });
    frontTok = TOKENS.count(front('', 1).join('\n')) + 25;
    total = frontTok + secs.reduce((a, s) => a + s.tokens, 0) + tailTok;
    if (!budget || opts.over !== 'trim' || total <= budget) break;
    if (!steps) steps = await trimSteps(scan, items, redact, numbered);
    if (pos >= steps.length) break;
    let excess = total - budget;
    while (excess > 0 && pos < steps.length) {
      const [it, to] = steps[pos++];
      if (it.mode === 'off' || (to === 'condensed' && it.mode !== 'full')) continue;
      const before = it.e.view(it.mode, redact, numbered).tokens + 30;
      let after = 0;
      if (to === 'condensed') { it.mode = 'condensed'; it.auto = 'budget'; after = it.e.view('condensed', redact, numbered).tokens + 30; }
      else { it.mode = 'off'; it.auto = 'budget'; it.code = 'budget'; it.note = 'trimmed to fit the token budget'; }
      excess -= before - after;
    }
  }

  let groups = [secs];
  if (budget && opts.over === 'split' && total > budget) {
    secs = chunkSections(fmt, secs, Math.max(500, budget - 200));
    groups = packParts(frontTok, secs, tailTok, budget);
  }
  const nParts = groups.length;
  const size = `~${fmtInt(total)} tokens` + (nParts > 1 ? ` across ${nParts} parts` : '');
  const what = treeOnly ? 'structure only' : plural(state.live.length, 'file');
  const footer = `END OF SNAPSHOT - ${scan.name} - ${what}${nParts > 1 ? `, ${nParts} parts` : ''}. Packed by ${APP_NAME} v${VERSION}.`;
  const parts = [], partTokens = [], anchors = {}, fileTokens = {};
  groups.forEach((group, gi) => {
    const k = gi + 1;
    let L, tok;
    if (k === 1) { L = front(size, nParts); tok = frontTok; }
    else {
      const note = group.length ? `Continuation of the snapshot of "${scan.name}" (files ${group[0].i}-${group[group.length - 1].i} of ${group[0].n}).` : `Final part of the snapshot of "${scan.name}".`;
      L = fmt.partHead(scan.name, k, nParts, note); tok = 60;
    }
    for (const s of group) {
      L = L.concat(s.head);
      if (s.body) L.push(s.body.endsWith('\n') ? s.body.slice(0, -1) : s.body);
      L = L.concat(s.foot);
      if (!(s.rel in anchors)) anchors[s.rel] = [gi, s.anchor];
      fileTokens[s.rel] = (fileTokens[s.rel] || 0) + s.tokens;
      tok += s.tokens;
    }
    if (k < nParts) { L = L.concat(fmt.partFoot(k, nParts)); tok += 40; }
    else { L = L.concat(fmt.end(footer), fmt.close(), tail); tok += tailTok; }
    parts.push(L.join('\n') + '\n');
    partTokens.push(tok);
  });
  const live = state.live;
  return {
    parts, partTokens, tokens: total, items,
    filesFull: live.filter((it) => it.mode === 'full').length,
    filesCondensed: live.filter((it) => it.mode === 'condensed').length,
    filesOff: items.filter((it) => it.mode === 'off').length,
    lines: state.lines, secrets: findings, redacted: state.redacted, anchors,
    omittedCounts: state.counts, fileTokens, budget,
    overBudget: !!(budget && opts.over === 'trim' && total > budget),
    trimmed: state.trimmed, squeezed: state.squeezed, counter: TOKENS.name,
    languages: state.languages,
    get text() { return this.parts.join('\n'); },
  };
}

module.exports = {
  VERSION, APP_NAME, APP_LONG, TAGLINE, TardisError, ScanCancelled,
  VCS_DIRS, JUNK_DIRS, REASON_LABELS, FORMAT_EXT, TEMPLATES, REPLY_FORMAT,
  SR_START, SR_MID, SR_END, BT, FENCE, OPTION_KEYS, DOC_LANGS,
  humanSize, fmtInt, plural, langName, detectLanguage, escapeHtml, contextNote,
  splitGlobs, parseTokens, formatTokens, decode, countLines, looksBinary,
  TOKENS, TokenCounter, globToRegex, parseIgnoreLines, rulesVerdict, GlobSet,
  findSecrets, redactText, restoreRedactions,
  outlinePython, outlineGeneric, outlineHeadings, condense, imageInfo,
  defaultOptions, mergeOptions, pickOptions, Entry,
  git, gitText, gitInfo, gitRefs, resolveRef, gitChanges, gitTree, readBlobs,
  isRemote, parseRemote, cloneRemote, ensureHistory,
  scanProject, listFiles, buildImportGraph, importClosure, focusSelection,
  priority, makePlan, buildDocument, renderTree,
};
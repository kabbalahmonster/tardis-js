#!/usr/bin/env node
'use strict';
/**
 * TARDIS 3 - Tree And Repo Dump In Single-file        "It's bigger on the inside."
 * =====================================================================================
 * Packs a whole project into ONE well-labelled document you can paste into a chat
 * window, and applies the AI's reply back to your files (diff preview, backup, undo).
 *
 *   node tardis.js                          open the GUI (local web app in your browser)
 *   node tardis.js my-project               write ./my-project.tardis.md
 *   node tardis.js . --copy --budget 100k   fit to 100k tokens, copy to the clipboard
 *   node tardis.js . --since main --copy    only what changed since main (+ diff)
 *   node tardis.js . --at v1.2 -o old.md    the project as it was at v1.2
 *   node tardis.js github.com/user/repo -c  pack a remote repository
 *   node tardis.js apply                    apply the AI reply that is on the clipboard
 *   node tardis.js undo                     revert the last apply
 *
 * ARCHITECTURE (one file, read top to bottom)
 *    1  Knowledge base      what to skip, file types, templates
 *    2  Helpers             formatting, decoding, token counting
 *    3  Ignore patterns     a .gitignore interpreter
 *    4  Secrets             find / redact / restore
 *    5  Condensed views     outlines, samples, sketches, image facts
 *    6  Data model          Options, Entry
 *    7  Git                 info, file lists, time travel, remote clones
 *    8  Scanning            turning a folder into a list of Entry objects
 *    9  Import graph        "follow the imports"
 *   10  Plan and budget     full / condensed / off per file; trimming
 *   11  Rendering           Markdown / XML / text, parts
 *   12  Return trip         parse a reply, diff, apply, undo
 *   13  Storage             sessions, profiles, templates
 *   14  System glue         clipboard, browser, right-click menu
 *   15  Server              the JSON API behind the GUI (ui.html)
 *   16  Command line
 *
 * Requirements: Node.js 18+. No npm packages. Optional: git; `gpt-tokenizer` (exact
 * token counts for OpenAI models) is used automatically when it happens to be installed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

const VERSION = '3.0.0';
const APP_NAME = 'TARDIS';
const APP_LONG = 'Tree And Repo Dump In Single-file';
const TAGLINE = "It's bigger on the inside.";

/** An error whose message is meant for the user (shown without a stack trace). */
class TardisError extends Error {}

// =====================================================================================
// 1. Knowledge base
// =====================================================================================

/** Folders that are never packed, whatever the settings. */
const VCS_DIRS = new Set(['.git', '.hg', '.svn', '.tardis']);

/** Folders that never contain hand-written source. Skipped while ignore rules are on. */
const JUNK_DIRS = new Set(['node_modules', 'bower_components', 'jspm_packages',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.venv',
  'venv', '.eggs', '.ipynb_checkpoints', '.idea', '.vs', '.gradle', '.terraform',
  '.serverless', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache',
  '.angular', '.dart_tool', '.bundle', 'Pods', 'DerivedData', '.sass-cache']);

/** Usually build output. Only skipped when git is NOT there to tell us better. */
const BUILD_DIRS = new Set(['build', 'dist', 'out', 'target', 'coverage', 'htmlcov',
  'obj', '_build', 'site-packages']);

/**
 * Turns simple file-name globs ("*.pyc", ".env.*") into one case-insensitive RegExp.
 * @param {string[]} globs
 * @returns {RegExp}
 */
function nameGlobs(globs) {
  const body = globs.map((g) => g.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*').replace(/\?/g, '.')).join('|');
  return new RegExp('^(?:' + body + ')$', 'i');
}

const JUNK_FILE_RE = nameGlobs(['.DS_Store', 'Thumbs.db', 'desktop.ini', '*.pyc', '*.pyo',
  '*.pyd', '*.class', '*.o', '*.obj', '*.swp', '*.swo', '*~', '*.orig', '*.rej',
  '.coverage', 'npm-debug.log*', 'yarn-error.log*', '.tardis.json']);
const GENERATED_RE = nameGlobs(['*.min.js', '*.min.css', '*.min.mjs', '*.map',
  '*.bundle.js', '*.chunk.js']);
const SECRET_NAME_RE = nameGlobs(['.env', '.env.*', '*.env', '*.pem', '*.key', '*.p12',
  '*.pfx', '*.jks', '*.keystore', '*.kdbx', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  '.npmrc', '.pypirc', '.netrc', '.htpasswd', 'credentials.json', 'credentials.yml',
  'credentials.yaml', 'secrets.json', 'secrets.yml', 'secrets.yaml', 'secrets.toml',
  '*.tfvars', '*.tfstate', '*.tfstate.backup', 'service-account*.json']);
const SECRET_SAFE_WORDS = ['example', 'sample', 'template', '.dist', 'defaults'];
/** Our own output files: never packed back into a snapshot. */
const SNAPSHOT_RE = /\.tardis(\.part\d+)?\.(md|xml|txt)$/i;

const LOCK_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'cargo.lock', 'poetry.lock', 'pipfile.lock',
  'pdm.lock', 'uv.lock', 'composer.lock', 'gemfile.lock', 'go.sum', 'flake.lock',
  'mix.lock', 'pubspec.lock', 'podfile.lock', 'packages.lock.json', 'deno.lock',
  'gradle.lockfile', 'conan.lock']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp']);
const BINARY_EXTS = new Set(('png jpg jpeg gif bmp ico icns webp tif tiff psd ai heic avif ' +
  'mp3 wav ogg flac m4a aac mp4 mov avi mkv webm wmv flv ' +
  'zip tar gz tgz bz2 xz 7z rar zst jar war ear whl egg deb rpm dmg iso apk ipa ' +
  'ttf otf woff woff2 eot pdf doc docx xls xlsx ppt pptx odt ods odp ' +
  'exe dll so dylib a lib o obj pyc pyo pyd class wasm bin dat ' +
  'db sqlite sqlite3 mdb pkl pickle npy npz parquet h5 hdf5 pt pth onnx safetensors ' +
  'ckpt lockb').split(' '));

const LANG_BY_NAME = { dockerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake', gemfile: 'ruby', rakefile: 'ruby', vagrantfile: 'ruby',
  brewfile: 'ruby', jenkinsfile: 'groovy', justfile: 'makefile', pipfile: 'toml',
  'go.mod': 'go', '.gitignore': 'gitignore', '.dockerignore': 'gitignore',
  '.npmignore': 'gitignore', '.gitattributes': 'gitattributes', '.editorconfig': 'ini',
  '.bashrc': 'bash', '.zshrc': 'bash', '.bash_profile': 'bash', '.profile': 'bash' };
const LANG_BY_EXT = { py: 'python', pyi: 'python', pyw: 'python', ipynb: 'json',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript',
  mts: 'typescript', cts: 'typescript', tsx: 'tsx', vue: 'vue', svelte: 'svelte',
  astro: 'astro', html: 'html', htm: 'html', xhtml: 'html', css: 'css', scss: 'scss',
  sass: 'sass', less: 'less', json: 'json', jsonc: 'jsonc', json5: 'json5', jsonl: 'json',
  ndjson: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', cfg: 'ini',
  conf: 'ini', properties: 'properties', env: 'dotenv', xml: 'xml', xsd: 'xml', xsl: 'xml',
  plist: 'xml', csproj: 'xml', svg: 'svg', md: 'markdown', markdown: 'markdown', mdx: 'mdx',
  rst: 'rst', txt: 'text', adoc: 'asciidoc', tex: 'latex', org: 'org', sh: 'bash',
  bash: 'bash', zsh: 'bash', fish: 'fish', ps1: 'powershell', psm1: 'powershell',
  bat: 'batch', cmd: 'batch', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  hh: 'cpp', hxx: 'cpp', ino: 'cpp', cs: 'csharp', fs: 'fsharp', vb: 'vbnet', java: 'java',
  kt: 'kotlin', kts: 'kotlin', scala: 'scala', groovy: 'groovy', gradle: 'groovy', go: 'go',
  rs: 'rust', swift: 'swift', m: 'objectivec', mm: 'objectivec', dart: 'dart', zig: 'zig',
  nim: 'nim', rb: 'ruby', erb: 'erb', php: 'php', pl: 'perl', pm: 'perl', lua: 'lua', r: 'r',
  jl: 'julia', ex: 'elixir', exs: 'elixir', erl: 'erlang', hs: 'haskell', ml: 'ocaml',
  clj: 'clojure', cljs: 'clojure', lisp: 'lisp', el: 'lisp', scm: 'scheme', sql: 'sql',
  graphql: 'graphql', gql: 'graphql', proto: 'protobuf', prisma: 'prisma', tf: 'hcl',
  hcl: 'hcl', tfvars: 'hcl', nix: 'nix', cmake: 'cmake', mk: 'makefile', csv: 'csv',
  tsv: 'csv', log: 'text', diff: 'diff', patch: 'diff', lock: 'text', gd: 'gdscript',
  sol: 'solidity', vim: 'vim', asm: 'asm', s: 'asm', glsl: 'glsl', wgsl: 'wgsl',
  j2: 'jinja', jinja: 'jinja', hbs: 'handlebars', ejs: 'ejs', pug: 'pug', twig: 'twig' };
const LANG_DISPLAY = { python: 'Python', javascript: 'JavaScript', typescript: 'TypeScript',
  jsx: 'JSX', tsx: 'TSX', html: 'HTML', css: 'CSS', scss: 'SCSS', json: 'JSON',
  jsonc: 'JSON', json5: 'JSON', yaml: 'YAML', toml: 'TOML', xml: 'XML', svg: 'SVG',
  sql: 'SQL', bash: 'Shell', cpp: 'C++', csharp: 'C#', fsharp: 'F#', vbnet: 'VB.NET',
  c: 'C', php: 'PHP', markdown: 'Markdown', mdx: 'MDX', text: 'Text',
  objectivec: 'Objective-C', graphql: 'GraphQL', hcl: 'Terraform/HCL', ini: 'INI',
  csv: 'CSV', powershell: 'PowerShell', latex: 'LaTeX', rst: 'reStructuredText',
  dotenv: 'dotenv', cmake: 'CMake' };
const DOC_LANGS = new Set(['markdown', 'mdx', 'rst', 'text', 'asciidoc', 'org', 'latex']);
const DATA_LANGS = new Set(['json', 'jsonc', 'json5', 'yaml', 'toml', 'ini', 'csv', 'xml',
  'svg', 'dotenv', 'properties', 'gitignore', 'gitattributes']);

/** Inputs to the priority score used when a token budget forces choices (section 10). */
const MANIFESTS = new Set(['package.json', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'requirements.txt', 'cargo.toml', 'go.mod', 'makefile', 'dockerfile',
  'docker-compose.yml', 'docker-compose.yaml', 'tsconfig.json', 'pom.xml', 'build.gradle',
  'build.gradle.kts', 'gemfile', 'composer.json', 'cmakelists.txt', 'pipfile',
  'deno.json', 'justfile']);
const LOW_DIRS = new Set(['fixtures', 'fixture', 'mocks', '__mocks__', 'vendor',
  'third_party', 'examples', 'example', 'samples', 'migrations', 'snapshots',
  '__snapshots__', 'testdata', 'assets', 'static', 'public', 'locale', 'locales', 'i18n',
  'data']);
const ENTRY_STEMS = new Set(['main', 'index', 'app', 'cli', 'server', '__main__', 'manage',
  'lib', 'mod', '__init__']);
const TEST_DIRS = new Set(['test', 'tests', 'spec', 'specs', '__tests__', 'e2e']);
const TEST_NAME_RE = /(^test_|_test\.|\.test\.|\.spec\.|^conftest\.)/;

const REASON_LABELS = { binary: 'binary', large: 'too large', lock: 'lock file',
  generated: 'generated/minified', secret: 'possible secrets', symlink: 'symlink',
  unreadable: 'unreadable', special: 'special', user: 'left out by user',
  budget: 'trimmed to fit the budget', unchanged: 'unchanged' };
const FORMAT_EXT = { markdown: '.md', xml: '.xml', text: '.txt' };

/** Built-in task templates (name -> instruction placed after the snapshot). */
const TEMPLATES = {
  'Explain the project': 'Explain this project: what it does, how it is structured, how ' +
    'the main pieces fit together, and where a newcomer should start reading.',
  'Code review': 'Review this code as a senior engineer would. List concrete problems ' +
    '(bugs, risky patterns, unclear code, missing error handling) ordered by severity, ' +
    'each with the file and a suggested fix.',
  'Find bugs': 'Look for bugs. For each one give the file, the faulty code, why it is ' +
    'wrong, and a corrected version.',
  'Security audit': 'Audit this project for security problems (injection, unsafe ' +
    'deserialization, leaked secrets, missing authorization, path traversal, insecure ' +
    'defaults). Rank findings by severity and propose fixes.',
  'Write tests': 'Write tests for the most important untested behaviour, using the test ' +
    'framework and conventions the project already uses.',
  'Refactor': 'Suggest and carry out refactorings that make the code simpler and easier ' +
    'to maintain without changing behaviour. Explain each change briefly.',
  'Improve docs': 'Improve the documentation: make the README accurately describe setup, ' +
    'usage and structure, and add docstrings or comments where they genuinely help.',
};

const SR_START = '<<<<<<< SEARCH';
const SR_MID = '=======';
const SR_END = '>>>>>>> REPLACE';
/** The instructions appended to every snapshot so replies can be applied automatically. */
const REPLY_FORMAT = [
  'If your answer changes, creates or deletes files, please use this format so the ' +
  'changes can be applied automatically (the rest of your answer can be normal prose):',
  '- Changed or new file: a line "### FILE: relative/path", then ONE fenced code block ' +
  'containing the COMPLETE new contents of the file. Never shorten it with "..." or ' +
  '"rest unchanged".',
  '- If the file itself contains code fences, use a longer outer fence (four or more ' +
  'backticks).',
  '- Small change to a big file: a line "### EDIT: relative/path", then a fenced code ' +
  'block holding one or more SEARCH/REPLACE pairs, with the SEARCH text copied exactly ' +
  'from the file:',
  '      ' + SR_START, '      lines exactly as they are now', '      ' + SR_MID,
  '      the lines that should replace them', '      ' + SR_END,
  '- Deleted file: the single line "### DELETE: relative/path".',
  '- Files shown here as "condensed" are incomplete: never send one back as a complete ' +
  'FILE. Use EDIT for the parts you can see, or ask for the full file first.',
  '- Keep any [REDACTED:...] placeholders exactly as they are.',
  '- Only include files that actually change.',
];

const BT = '`';
const FENCE = BT.repeat(3);
const CONDENSE_CAP = 8 * 1024 * 1024;   // largest file we will read just to condense it
const CHARS_PER_TOKEN = 3.6;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };

// =====================================================================================
// 2. Helpers and token counting
// =====================================================================================

/** 1234567 -> "1,234,567" */
const fmt = (n) => Number(n).toLocaleString('en-US');
/** plural(1,'file') -> "1 file"; plural(3,'file') -> "3 files" */
const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
/** Writes a line to stderr (stdout is reserved for piped snapshot output). */
const say = (msg = '') => { try { process.stderr.write(msg + '\n'); } catch { /* closed */ } };
/** Escapes a string for use inside a RegExp. */
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Like Python's str.strip(chars): trims any of `chars` from both ends. */
function stripChars(s, chars) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/** 1536 -> "1.5 KB" */
function humanSize(n) {
  if (n < 1024) return `${Math.trunc(n)} B`;
  for (const unit of ['KB', 'MB', 'GB']) {
    n /= 1024;
    if (n < 1024 || unit === 'GB') return `${n.toFixed(1)} ${unit}`;
  }
  return `${n.toFixed(1)} GB`;
}

/** 'python' -> 'Python' (display name of a fence language). */
const langName = (code) => LANG_DISPLAY[code] || code.charAt(0).toUpperCase() + code.slice(1);

/** File name -> code-fence language ('text' when unknown). */
function detectLanguage(name) {
  const low = name.toLowerCase();
  if (LANG_BY_NAME[low]) return LANG_BY_NAME[low];
  if (low.startsWith('dockerfile')) return 'dockerfile';
  if (low.startsWith('.env')) return 'dotenv';
  const dot = low.lastIndexOf('.');
  return dot >= 0 ? (LANG_BY_EXT[low.slice(dot + 1)] || 'text') : 'text';
}

/** Lower-case extension of a file name without the dot ('' when none). */
function extOf(name) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** "12% of a 200k context" - a feel for how big a snapshot is. */
function contextNote(tokens) {
  const pct = tokens * 100 / 200000;
  return pct < 1 ? 'under 1% of a 200k context' : `${pct.toFixed(0)}% of a 200k context`;
}

/** Splits ["a, b", "c"] into ["a","b","c"] (globs typed with commas or newlines). */
function splitGlobs(values) {
  const out = [];
  for (const v of values || []) {
    for (const p of String(v).split(/[,\n]/)) if (p.trim()) out.push(p.trim());
  }
  return out;
}

/** '100k' -> 100000, '1.5m' -> 1500000, 'No limit' -> 0. Throws TardisError if unreadable. */
function parseTokens(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[, _]/g, '');
  if (!s || ['0', 'none', 'nolimit', 'off'].includes(s)) return 0;
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(s);
  if (!m) throw new TardisError(`Cannot read "${value}" as a token count (try 100k, 1.5m or 64000).`);
  return Math.trunc(parseFloat(m[1]) * { '': 1, k: 1000, m: 1000000 }[m[2]]);
}

/** 64000 -> '64k', 0 -> 'No limit' */
function formatTokens(n) {
  if (!n) return 'No limit';
  if (n % 1000000 === 0) return `${n / 1000000}M`;
  if (n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

/**
 * Bytes -> text. Tries UTF-8 (and UTF-16 with a BOM), falls back to Windows-1252.
 * Line endings are normalised to "\n" and NUL characters removed.
 * @param {Buffer} buf
 * @returns {string}
 */
function decode(buf) {
  let text;
  try {
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      text = new TextDecoder('utf-16le').decode(buf);
    } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      text = new TextDecoder('utf-16be').decode(buf);
    } else {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    }
  } catch {
    try { text = new TextDecoder('windows-1252').decode(buf); }
    catch { text = buf.toString('latin1'); }
  }
  return text.replace(/\r\n?/g, '\n').replace(/\0/g, '');
}

/** Number of lines in a text (a final line without "\n" still counts). */
function countLines(text) {
  if (!text) return 0;
  let n = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
  return n + (text.endsWith('\n') ? 0 : 1);
}

/** Heuristic binary sniff on the first bytes of a file. */
function looksBinary(chunk) {
  if (!chunk || !chunk.length) return false;
  if ((chunk[0] === 0xff && chunk[1] === 0xfe) || (chunk[0] === 0xfe && chunk[1] === 0xff) ||
      (chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf)) return false;
  let odd = 0;
  for (const b of chunk) {
    if (b === 0) return true;
    if ((b < 32 && ![7, 8, 9, 10, 12, 13, 27].includes(b)) || b === 127) odd++;
  }
  return odd / chunk.length > 0.10;
}

/**
 * Token counter. Uses the optional `gpt-tokenizer` package when it is installed
 * (exact for OpenAI models), otherwise estimates characters / 3.6.
 */
const TOKENS = {
  mode: 'auto',
  name: `estimate: characters / ${CHARS_PER_TOKEN}`,
  _encode: null,
  _tried: false,
  /** @param {'auto'|'estimate'|'exact'} mode */
  configure(mode) {
    this.mode = mode; this._encode = null; this._tried = false;
    this.name = `estimate: characters / ${CHARS_PER_TOKEN}`;
  },
  ensure() {
    if (this._tried) return;
    this._tried = true;
    if (this.mode === 'estimate') return;
    try {
      const { encode } = require('gpt-tokenizer');
      encode('probe');
      this._encode = encode;
      this.name = 'exact for OpenAI models: gpt-tokenizer';
    } catch {
      if (this.mode === 'exact') say('gpt-tokenizer is not installed - using the estimate.');
    }
  },
  /** @param {string} text @returns {number} */
  count(text) {
    if (!text) return 0;
    if (!this._tried) this.ensure();
    if (this._encode) { try { return this._encode(text).length; } catch { /* fall through */ } }
    return Math.trunc(text.length / CHARS_PER_TOKEN) + 1;
  },
};

// =====================================================================================
// 3. .gitignore-style patterns
//    Used when git itself cannot help, and for --include / --exclude / --omit / --condense.
// =====================================================================================

/** Translates one gitignore glob body into regex source (no anchors). */
function globToRegex(pat) {
  const out = [];
  let i = 0;
  const n = pat.length;
  while (i < n) {
    const ch = pat[i];
    if (ch === '*') {
      let j = i;
      while (j < n && pat[j] === '*') j++;
      const segStart = i === 0 || pat[i - 1] === '/';
      if (j - i >= 2 && segStart && j < n && pat[j] === '/') { out.push('(?:.*/)?'); i = j + 1; }
      else if (j - i >= 2 && segStart && j === n) { out.push('.*'); i = j; }
      else { out.push('[^/]*'); i = j; }
    } else if (ch === '?') {
      out.push('[^/]'); i++;
    } else if (ch === '[') {
      let j = i + 1;
      if (j < n && '!^'.includes(pat[j])) j++;
      if (j < n && pat[j] === ']') j++;
      while (j < n && pat[j] !== ']') j++;
      if (j >= n) { out.push('\\['); i++; }
      else {
        let body = pat.slice(i + 1, j);
        const neg = body[0] === '!' || body[0] === '^';
        if (neg) body = body.slice(1);
        body = body.replace(/\\/g, '\\\\').replace(/\[/g, '\\[');
        out.push('[' + (neg ? '^' : '') + body + ']');
        i = j + 1;
      }
    } else if (ch === '\\' && i + 1 < n) {
      out.push(reEscape(pat[i + 1])); i += 2;
    } else {
      out.push(reEscape(ch)); i++;
    }
  }
  return out.join('');
}

/**
 * Parses .gitignore lines into rules.
 * @param {Iterable<string>} lines
 * @returns {{rx: RegExp, negated: boolean, dirOnly: boolean}[]}
 */
function parseIgnoreLines(lines) {
  const rules = [];
  for (const raw of lines) {
    let line = raw.replace(/[\r\n]+$/, '');
    if (!line.endsWith('\\ ')) line = line.trimEnd();
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
    try {
      rules.push({ rx: new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`), negated, dirOnly });
    } catch { /* an unparsable pattern is simply skipped */ }
  }
  return rules;
}

/** Last matching rule wins. @returns {boolean|null} true = ignored, false = re-included. */
function rulesVerdict(rules, rel, isDir) {
  let verdict = null;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.rx.test(rel)) verdict = !r.negated;
  }
  return verdict;
}

/** A list of gitignore-style patterns tested against a file's full relative path. */
class GlobSet {
  /** @param {string[]} patterns */
  constructor(patterns) { this.rules = parseIgnoreLines(patterns || []); }
  get empty() { return this.rules.length === 0; }
  /** True when the file, or any folder above it, matches. */
  matches(rel) {
    if (!this.rules.length) return false;
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const isDir = i < parts.length;
      const verdict = rulesVerdict(this.rules, parts.slice(0, i).join('/'), isDir);
      if (isDir && verdict) return true;
      if (!isDir) return Boolean(verdict);
    }
    return false;
  }
}

// =====================================================================================
// 4. Secrets: find, redact, restore
// =====================================================================================

/** [kind, regex (flags g+d so capture-group positions are available), group index] */
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
  ['assigned-secret', /(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?key|private[_-]?key|client[_-]?secret)[\w.-]*["']?\s*[:=]\s*["']([^"'\s]{8,})["']/gid, 1],
];
const KEYWORD_LINE_RE = /^[^\n]*(?:key|secret|token|passw|credential|auth)[^\n]*$/gim;
const HASHY_RE = /integrity|checksum|sha\d*[-:=]|\bhash|commit|digest/i;
const TOKENISH_RE = /[A-Za-z0-9+/=_-]{24,}/g;
const PLACEHOLDER_WORDS = ['example', 'changeme', 'change_me', 'placeholder', 'your', 'xxxx',
  'todo', 'dummy', 'sample', 'secret', 'password', 'redacted', '<', '>', '${', '{{', '%(', '****'];
const REDACTED_RE = /\[REDACTED:([a-z-]+)#(\d+)\]/g;

/** Shannon entropy in bits per character. */
function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const c of counts.values()) h -= (c / s.length) * Math.log2(c / s.length);
  return h;
}

/** True for values that are obviously documentation, not real secrets. */
function isPlaceholder(value, needDigit) {
  const low = value.toLowerCase();
  if (PLACEHOLDER_WORDS.some((w) => low.includes(w)) || new Set(value).size < 5) return true;
  return needDigit && !/\d/.test(value);
}

/**
 * Finds secret-looking values.
 * @param {string} text
 * @returns {Array<[number, number, string]>} non-overlapping [start, end, kind], sorted
 */
function findSecrets(text) {
  const spans = [];
  for (const [kind, rx, grp] of SECRET_PATTERNS) {
    rx.lastIndex = 0;
    for (const m of text.matchAll(rx)) {
      const value = m[grp];
      if (kind === 'assigned-secret' && isPlaceholder(value, true)) continue;
      if (kind === 'url-password' && isPlaceholder(value, false)) continue;
      spans.push([m.indices[grp][0], m.indices[grp][1], kind]);
    }
  }
  // High-entropy strings, but only on lines that talk about keys/tokens/passwords.
  for (const lm of text.matchAll(KEYWORD_LINE_RE)) {
    const line = lm[0];
    if (line.length > 2000 || HASHY_RE.test(line)) continue;
    for (const tm of line.matchAll(TOKENISH_RE)) {
      const tok = tm[0];
      const digits = (tok.match(/\d/g) || []).length;
      const isHex = tok.length >= 32 && /^[0-9a-fA-F]+$/.test(tok);
      const mixed = digits >= 3 && tok.toLowerCase() !== tok && tok.toUpperCase() !== tok &&
        entropy(tok) >= 4.1;
      if ((isHex && digits >= 3) || mixed) {
        spans.push([lm.index + tm.index, lm.index + tm.index + tok.length, 'high-entropy']);
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));
  const out = [];
  let lastEnd = -1;
  for (const s of spans) if (s[0] >= lastEnd) { out.push(s); lastEnd = s[1]; }
  return out;
}

/**
 * Reports secrets and (optionally) replaces them with numbered placeholders.
 * @param {string} text
 * @param {boolean} [apply=true] replace values with [REDACTED:kind#n]
 * @returns {{text: string, findings: Array<[number, string]>}} findings = [line, kind]
 */
function redactText(text, apply = true) {
  const spans = findSecrets(text);
  if (!spans.length) return { text, findings: [] };
  const findings = [];
  const out = [];
  let pos = 0, line = 1, scanned = 0;
  spans.forEach(([s, e, kind], i) => {
    for (let k = text.indexOf('\n', scanned); k >= 0 && k < s; k = text.indexOf('\n', k + 1)) line++;
    scanned = s;
    findings.push([line, kind]);
    out.push(text.slice(pos, s), `[REDACTED:${kind}#${i + 1}]`);
    pos = e;
  });
  out.push(text.slice(pos));
  return { text: apply ? out.join('') : text, findings };
}

/**
 * Puts the real values back where the AI kept our placeholders. Works because the
 * numbering is deterministic: secret #n is the n-th secret found in the current file.
 * @returns {{text: string, restored: number, lost: number}}
 */
function restoreRedactions(newText, original) {
  if (!newText.includes('[REDACTED:')) return { text: newText, restored: 0, lost: 0 };
  const spans = findSecrets(original);
  let restored = 0;
  const text = newText.replace(REDACTED_RE, (whole, kind, num) => {
    const span = spans[Number(num) - 1];
    if (span && span[2] === kind) { restored++; return original.slice(span[0], span[1]); }
    return whole;
  });
  return { text, restored, lost: text.split('[REDACTED:').length - 1 };
}

// =====================================================================================
// 5. Condensed views: a shorter stand-in for a file
// =====================================================================================

/**
 * Outline of a Python file: decorators, signatures and docstrings are kept, bodies are
 * collapsed to "...  # N more lines". Python's structure is its indentation, so this is
 * done line by line without a parser; triple-quoted strings are tracked so their
 * contents are never mistaken for code.
 * @param {string} text
 * @returns {string|null}
 */
function outlinePython(text) {
  const lines = text.split('\n');
  const n = lines.length;
  // Pass 1: inStr[i] is true when line i STARTS inside a triple-quoted string.
  const inStr = new Array(n).fill(false);
  let open = null;
  for (let i = 0; i < n; i++) {
    inStr[i] = open !== null;
    const ln = lines[i];
    let j = 0;
    while (j < ln.length) {
      if (open) {
        const k = ln.indexOf(open, j);
        if (k < 0) break;
        open = null; j = k + 3;
      } else {
        const c = ln[j];
        if (c === '#') break;
        if (c === '"' || c === "'") {
          if (ln.startsWith(c.repeat(3), j)) { open = c.repeat(3); j += 3; }
          else { j++; while (j < ln.length && ln[j] !== c) j += ln[j] === '\\' ? 2 : 1; j++; }
        } else j++;
      }
    }
  }
  const pad = (s) => /^[ \t]*/.exec(s)[0];
  const indentOf = (s) => pad(s).replace(/\t/g, '        ').length;
  const isCode = (i) => !inStr[i] && lines[i].trim() !== '' && !lines[i].trim().startsWith('#');
  const noStrings = (s) => s.replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*$/, '');
  const isDocStart = (s) => /^[rRuUbBfF]{0,2}("""|''')/.test(s.trim());
  const out = [];
  const emit = (a, b) => { for (let i = a; i < b; i++) out.push(lines[i]); };
  const more = (ind, k) => { if (k > 0) out.push(`${ind}...  # ${plural(k, 'more line')}`); };
  const doc = (a, b, ind) => {
    if (b - a <= 12) emit(a, b);
    else { emit(a, a + 8); out.push(`${ind}[...]`); emit(b - 1, b); }
  };
  /** End (exclusive) of the statement/block starting at `start` with indentation `ind`. */
  const blockEnd = (start, ind, limit) => {
    let end = start + 1;
    for (let i = start + 1; i < limit; i++) {
      if (inStr[i]) { end = i + 1; continue; }
      if (!isCode(i)) continue;
      if (indentOf(lines[i]) <= ind && !/^[)\]}]/.test(lines[i].trim())) break;
      end = i + 1;
    }
    return end;
  };
  const walk = (from, to, top) => {
    let i = from;
    while (i < to) {
      if (!isCode(i)) { i++; continue; }
      const ind = indentOf(lines[i]);
      let d = i;                                   // skip decorators (possibly multi-line)
      while (d < to && lines[d].trim().startsWith('@')) {
        let depth = 0;
        do {
          for (const c of noStrings(lines[d])) {
            if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
          }
          d++;
        } while (depth > 0 && d < to);
        while (d < to && !isCode(d)) d++;
      }
      const head = d < to ? lines[d].trim() : '';
      if (/^(?:async\s+def|def|class)\b/.test(head)) {
        const end = blockEnd(d, ind, to);
        if (top && out.length && out[out.length - 1].trim()) out.push('');
        if (end - i < 5) { emit(i, end); i = end; continue; }     // tiny: keep whole
        let h = d, depth = 0;                                     // last line of the signature
        for (let k = d; k < end; k++) {
          const code = noStrings(lines[k]);
          for (const c of code) {
            if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--;
          }
          if (depth <= 0 && /:\s*$/.test(code)) { h = k; break; }
        }
        emit(i, h + 1);
        if (head.startsWith('class')) { walk(h + 1, end, false); i = end; continue; }
        let b = h + 1;
        while (b < end && lines[b].trim() === '') b++;
        const bodyPad = b < end ? pad(lines[b]) : pad(lines[d]) + '    ';
        let after = h + 1;
        if (b < end && isDocStart(lines[b])) {
          let e = b;
          while (e + 1 < end && inStr[e + 1]) e++;
          doc(b, e + 1, bodyPad);
          after = e + 1;
        }
        more(bodyPad, end - after);
        i = end;
        continue;
      }
      if (d !== i) { emit(i, d); i = d; continue; }               // stray decorator
      const e = blockEnd(i, ind, to);
      const s = lines[i].trim();
      const len = e - i;
      if (isDocStart(s)) doc(i, e, pad(lines[i]));
      else if (/^(?:import|from)\b/.test(s) || len <= 3) emit(i, e);
      else if (/^[\w.[\]'", ]+(?::[^=]+)?[-+*/|&%]?=(?!=)/.test(s)) { emit(i, i + 2); more(pad(lines[i]) + '    ', len - 2); }
      else { emit(i, i + 1); more(pad(lines[i]) + '    ', len - 1); }
      i = e;
    }
  };
  walk(0, n, true);
  return out.length ? out.join('\n') + '\n' : null;
}

const SKEL_DECL = /^(?:(?:export|default|public|private|protected|internal|static|final|abstract|sealed|override|open|virtual|inline|async|suspend|unsafe|extern|declare|partial|data|pub(?:\([a-z:]+\))?)\s+)*(?<kw>import|from|package|using|use|require|include|module|namespace|mod|class|interface|struct|enum|trait|impl|protocol|extension|object|record|type|union|function\*?|func|fn|fun|def|sub|typedef|template|const|static|var|let|val|export|describe|it|test)\b/;
const SKEL_METHOD = /^(?!(?:if|for|while|switch|catch|return|else|do|try|with|new|throw|await|yield|case|foreach|elif|unless|until|when|match|lock|using|sizeof|typeof|delete|function)\b)(?:[\w$<>[\],?*&~]+\s+)*[\w$~:]+\s*\([^()]*\)\s*(?::\s*[\w<>[\],. |?]+)?\s*(?:const\s*)?\{\s*$/;
const SKEL_COMMENT = ['//', '/*', '*', '#', '--', '"""', "'''"];

/**
 * Regex skeleton for brace/keyword languages: keeps declaration lines (imports, classes,
 * functions, methods, exports) plus the comment lines directly above them. Heuristic:
 * it may keep a line too many or miss one, but it never fails.
 * @param {string} text
 * @returns {string|null}
 */
function outlineGeneric(text) {
  const lines = text.split('\n');
  const decl = lines.map((raw) => {
    const s = raw.trimStart();
    if (!s || raw.length > 400) return false;
    const lead = raw.slice(0, raw.length - s.length);
    const width = (lead.match(/\t/g) || []).length * 4 + (lead.match(/ /g) || []).length;
    if (width > 8) return false;                     // deep nesting = inside a body
    if (['@', '#[', '#include', '#define'].some((p) => s.startsWith(p))) return true;
    const m = SKEL_DECL.exec(s);
    if (m) {
      const kw = m.groups.kw;
      if (['const', 'static', 'var', 'let', 'val', 'use', 'type'].includes(kw) && width > 0 &&
          !s.includes('=>') && !s.includes('function')) return false;   // a local variable
      if (['it', 'test', 'describe', 'require', 'include'].includes(kw) && !s.includes('(')) return false;
      return true;
    }
    if (SKEL_METHOD.test(s)) return true;
    const t = s.trimEnd();
    return width === 0 && /^[A-Za-z]/.test(s) && s.includes('(') &&
      (t.endsWith('{') || t.endsWith(')')) && !s.split('(')[0].includes('=') &&
      !/^(?:if|for|while|switch|return|else)\b/.test(s);          // C-style definition
  });
  if (decl.filter(Boolean).length < 2) return null;
  const keep = decl.slice();
  decl.forEach((isDecl, i) => {
    if (!isDecl) return;
    for (let j = i - 1, k = 0; j >= 0 && k < 6 && !decl[j] &&
         SKEL_COMMENT.some((p) => lines[j].trimStart().startsWith(p)); j--, k++) keep[j] = true;
  });
  const out = [];
  let gap = 0;
  lines.forEach((raw, i) => {
    if (keep[i]) {
      if (gap) out.push(`    ... [${plural(gap, 'line')}]`);
      out.push(raw); gap = 0;
    } else if (raw.trim()) gap++;
  });
  if (gap) out.push(`    ... [${plural(gap, 'line')}]`);
  return out.join('\n') + '\n';
}

/** Markdown / reStructuredText: headings only, with the size of each section. */
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
    else if (next.length >= 3 && /^(=+|-+|~+|\^+)$/.test(next) && /^[A-Za-z0-9]/.test(s)) heads.push([i, ln.trimEnd()]);
  });
  if (heads.length < 3) return null;
  const out = heads.map(([i, ln], k) => {
    const end = k + 1 < heads.length ? heads[k + 1][0] : lines.length;
    return `${ln}   [${plural(end - i - 1, 'line')}]`;
  });
  return [out.join('\n') + '\n', 'headings only'];
}

/** CSV / JSONL: the first rows and a count. @returns {[string,string]|null} */
function condenseRows(lines, total, keep) {
  if (total <= keep + 16) return null;
  const shown = lines.slice(0, keep + 1).map((ln) => (ln.length <= 400 ? ln : ln.slice(0, 400) + ' ...'));
  return [shown.join('\n') + `\n... [${fmt(total - shown.length)} more lines]\n`,
    `first ${shown.length} of ${fmt(total)} lines`];
}

/** JSON: a sketch of the structure (keys, array sizes, one sample element). */
function condenseJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  const out = [];
  const short = (v) => { const s = JSON.stringify(v); return s.length <= 60 ? s : s.slice(0, 57) + '...'; };
  const walk = (v, ind, key, depth) => {
    if (out.length > 400) return;
    const pre = ' '.repeat(ind) + (key !== null ? JSON.stringify(key) + ': ' : '');
    if (Array.isArray(v) && v.length) {
      if (depth >= 6) { out.push(`${pre}[ ... ${plural(v.length, 'item')} ]`); return; }
      out.push(`${pre}[   <- ${plural(v.length, 'item')}${v.length > 1 ? ', only the first is shown' : ''}`);
      walk(v[0], ind + 2, null, depth + 1);
      out.push(' '.repeat(ind) + ']');
    } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
      const keys = Object.keys(v);
      if (depth >= 6) { out.push(`${pre}{ ... ${plural(keys.length, 'key')} }`); return; }
      out.push(pre + '{');
      keys.slice(0, 30).forEach((k) => walk(v[k], ind + 2, k, depth + 1));
      if (keys.length > 30) out.push(' '.repeat(ind + 2) + `... [${fmt(keys.length - 30)} more keys]`);
      out.push(' '.repeat(ind) + '}');
    } else out.push(pre + short(v));
  };
  walk(data, 0, null, 0);
  return [out.join('\n') + '\n', 'JSON structure sketch, not the real data'];
}

/** Jupyter notebook -> script form, outputs stripped. @returns {[string,string,string]|null} */
function condenseNotebook(text) {
  let nb;
  try { nb = JSON.parse(text); } catch { return null; }
  if (!nb || !Array.isArray(nb.cells)) return null;
  const out = [];
  nb.cells.forEach((cell, i) => {
    if (!cell || typeof cell !== 'object') return;
    const kind = cell.cell_type || 'code';
    const src = Array.isArray(cell.source) ? cell.source.join('') : String(cell.source || '');
    out.push(`# %% [${kind}] cell ${i + 1}`);
    if (kind === 'code') {
      out.push(src.replace(/\n+$/, ''));
      if (Array.isArray(cell.outputs) && cell.outputs.length) out.push('# (output stripped)');
    } else for (const ln of src.split('\n')) out.push(ln ? '# ' + ln : '#');
    out.push('');
  });
  const lang = (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.language) || 'python';
  return [out.join('\n') + '\n',
    `notebook as a script, ${plural(nb.cells.length, 'cell')}, outputs stripped`, String(lang)];
}

/** Anything else: the first lines and a count. */
function headSample(text, n = 40) {
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= n + 10) return null;
  return [lines.slice(0, n).join('\n') + `\n... [${fmt(lines.length - n)} more lines]\n`,
    `first ${n} of ${fmt(lines.length)} lines`];
}

/**
 * Picks the right condensed view for a file.
 * @returns {[string, string, string]|null} [text, label, fence language]; null when no
 *          view exists that is at least 20% shorter than the file itself.
 */
function condense(rel, lang, text) {
  const ext = extOf(rel);
  let out = null;
  if (ext === 'ipynb') {
    const nb = condenseNotebook(text);
    if (nb) return nb;
  } else if (['csv', 'tsv', 'jsonl', 'ndjson'].includes(ext)) {
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    out = condenseRows(lines, lines.length, ['csv', 'tsv'].includes(ext) ? 5 : 3);
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

/** 'PNG image, 1200x630' from the first bytes of an image file ('' when unknown). */
function imageInfo(head) {
  try {
    if (head.length >= 24 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return `PNG image, ${head.readUInt32BE(16)}x${head.readUInt32BE(20)}`;
    }
    const sig = head.subarray(0, 6).toString('latin1');
    if ((sig === 'GIF87a' || sig === 'GIF89a') && head.length >= 10) {
      return `GIF image, ${head.readUInt16LE(6)}x${head.readUInt16LE(8)}`;
    }
    if (sig.startsWith('BM') && head.length >= 26) {
      return `BMP image, ${head.readInt32LE(18)}x${Math.abs(head.readInt32LE(22))}`;
    }
    if (sig.startsWith('RIFF') && head.subarray(8, 12).toString('latin1') === 'WEBP' && head.length >= 30) {
      const kind = head.subarray(12, 16).toString('latin1');
      let w, h;
      if (kind === 'VP8X') { w = 1 + head.readUIntLE(24, 3); h = 1 + head.readUIntLE(27, 3); }
      else if (kind === 'VP8L') {
        const [b0, b1, b2, b3] = head.subarray(21, 25);
        w = 1 + (((b1 & 0x3f) << 8) | b0);
        h = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      } else if (kind === 'VP8 ') { w = head.readUInt16LE(26) & 0x3fff; h = head.readUInt16LE(28) & 0x3fff; }
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
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return `JPEG image, ${head.readUInt16BE(i + 7)}x${head.readUInt16BE(i + 5)}`;
        }
        i += 2 + head.readUInt16BE(i + 2);
      }
      return 'JPEG image';
    }
  } catch { /* truncated header */ }
  return '';
}

// =====================================================================================
// 6. Data model
// =====================================================================================

/**
 * Every setting, with its default. Keys are snake_case on purpose: they are the same
 * keys the Python edition stores in `.tardis.json`, so profiles stay interchangeable.
 * @param {string} [root='.']
 */
function defaultOptions(root = '.') {
  return {
    root,
    include_hidden: false,   // dotfiles and dot-folders
    use_ignore: true,        // .gitignore + built-in junk lists
    include_locks: false,    // lock files and minified/generated files
    include_secrets: false,  // .env, *.pem ... (whole files)
    redact: true,            // replace secret-looking VALUES in included text
    max_size_kb: 256,        // larger files are condensed or omitted
    include_globs: [], exclude_globs: [], omit_globs: [], condense_globs: [],
    fmt: 'markdown',         // 'markdown' | 'xml' | 'text'
    line_numbers: false,
    tree_only: false,        // structure map only
    budget: 0,               // token ceiling; 0 = none
    over: 'trim',            // 'trim' to fit, or 'split' into parts
    since: '',               // git ref: only what changed since
    at: '',                  // git ref: the project as it was at
    include_diff: true,
    task: '',                // instructions placed after the snapshot
    reply_format: true,      // append the "how to reply" instructions
    source: '',              // remote URL, for display only
  };
}
const OPTION_KEYS = Object.keys(defaultOptions()).filter((k) => k !== 'root' && k !== 'source');

/** Copies known, correctly-typed keys of `d` over `base`. Unknown keys are ignored. */
function mergeOptions(base, d) {
  const out = { ...base };
  for (const k of OPTION_KEYS) {
    if (d && d[k] !== undefined && typeof d[k] === typeof base[k] &&
        Array.isArray(d[k]) === Array.isArray(base[k])) out[k] = d[k];
  }
  return out;
}
/** Just the storable settings of an options object. */
const optionsToDict = (o) => Object.fromEntries(OPTION_KEYS.map((k) => [k, o[k]]));

/** "  12 | code" numbering for every line. */
function numberLines(text) {
  if (!text) return text;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const w = Math.max(2, String(lines.length).length);
  return lines.map((ln, i) => `${String(i + 1).padStart(w)} |${ln ? ' ' + ln : ''}`).join('\n') + '\n';
}

/** One file of the project, with lazily loaded text and cached views. */
class Entry {
  /**
   * @param {string} rel  path relative to the project root, '/' separated
   * @param {string} abs  absolute path on disk
   * @param {string} repo project root (needed to read blobs from git history)
   */
  constructor(rel, abs, repo) {
    this.rel = rel; this.abs = abs; this.repo = repo;
    this.size = 0;
    this.lang = 'text';
    this.skip = '';          // '' = included by default, otherwise a reason code
    this.note = '';          // human-readable reason
    this.forceable = false;  // text the user may still include
    this.def = 'full';       // default view: 'full' | 'condensed'
    this.link = '';          // symlink target
    this.blob = '';          // git object id when read from history (--at)
    this.change = '';        // 'modified' | 'added' | 'renamed from x' (--since)
    this.lines = 0;
    this.text = null;        // decoded contents once loaded
    this.cond = undefined;   // undefined = not tried; null = none; [text, label, lang]
    this.views = new Map();
  }
  get loaded() { return this.text !== null; }
  /** Can the user tick this file at all? (binaries and symlinks cannot be included) */
  get checkable() { return !this.skip || this.forceable; }

  /** Raw bytes from disk or from git history. @returns {Buffer|null} */
  readBytes(limit = 0) {
    try {
      if (this.blob) {
        const data = git(this.repo, ['cat-file', 'blob', this.blob], { timeout: 120000 });
        return data && limit ? data.subarray(0, limit) : data;
      }
      if (!limit) return fs.readFileSync(this.abs);
      const fd = fs.openSync(this.abs, 'r');
      try {
        const buf = Buffer.alloc(limit);
        return buf.subarray(0, fs.readSync(fd, buf, 0, limit, 0));
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  }

  /** Loads and decodes the text (once). @returns {boolean} success */
  load(data = null) {
    if (this.text !== null) return true;
    if (!data) data = this.readBytes();
    if (!data) return false;
    this.text = decode(data);
    this.lines = countLines(this.text);
    return true;
  }

  /** The condensed view, computed once. @returns {[string,string,string]|null} */
  condensed() {
    if (this.cond === undefined) {
      this.cond = null;
      if (this.load()) {
        try { this.cond = condense(this.rel, this.lang, this.text); } catch { this.cond = null; }
      }
    }
    return this.cond;
  }

  /**
   * What goes into the document for this file, cached per (mode, redact, numbered).
   * @returns {{body: string, label: string, lang: string, tokens: number,
   *            findings: Array<[number,string]>}}
   */
  view(mode, redact = false, numbered = false) {
    const key = `${mode}|${redact}|${numbered}`;
    let v = this.views.get(key);
    if (!v) {
      let text = this.text || '', label = '', lang = this.lang;
      if (mode === 'condensed' && this.condensed()) [text, label, lang] = this.cond;
      const red = redactText(text, redact);
      const body = numbered ? numberLines(red.text) : red.text;
      v = { body, label, lang, tokens: TOKENS.count(body), findings: red.findings };
      this.views.set(key, v);
    }
    return v;
  }
}

// =====================================================================================
// 7. Git: info, file lists, time travel, remote clones
//    All calls are synchronous. The GUI stays responsive anyway because it lives in
//    another process (your browser) and simply shows a spinner while it waits.
// =====================================================================================

/**
 * Runs git in `root`.
 * @param {string} root
 * @param {string[]} args
 * @param {{timeout?: number, input?: Buffer|string}} [o]
 * @returns {Buffer|null} stdout, or null when git is missing or failed
 */
function git(root, args, o = {}) {
  const r = spawnSync('git', ['-C', String(root), ...args], {
    env: GIT_ENV, input: o.input, timeout: o.timeout || 30000,
    maxBuffer: 1024 * 1024 * 1024, windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  return r.error || r.status !== 0 ? null : r.stdout;
}
/** Same, as trimmed text ('' on failure). */
const gitText = (root, args, o) => { const out = git(root, args, o); return out ? out.toString('utf8').trim() : ''; };
/** Is a `git` executable available at all? */
const hasGit = () => !spawnSync('git', ['--version'], { windowsHide: true }).error;

/** Branch, commit, remote (credentials stripped) and dirty flag; {} outside a repository. */
function gitInfo(root) {
  if (gitText(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return {};
  return {
    inside: 'yes',
    branch: gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    commit: gitText(root, ['rev-parse', '--short', 'HEAD']),
    last: gitText(root, ['log', '-1', '--format=%cd  %s', '--date=short']),
    remote: gitText(root, ['config', '--get', 'remote.origin.url']).replace(/(?<=:\/\/)[^/@]+@/, ''),
    dirty: gitText(root, ['status', '--porcelain', '--untracked-files=no']) ? 'yes' : '',
  };
}

/** Suggestions for the time-travel box, most useful first. */
function gitRefs(root) {
  const names = gitText(root, ['for-each-ref', '--sort=-committerdate', '--count=40',
    '--format=%(refname:short)', 'refs/heads', 'refs/remotes', 'refs/tags'])
    .split('\n').filter((n) => n && !n.endsWith('/HEAD'));
  const current = gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const out = ['main', 'master', 'origin/main', 'origin/master', 'develop']
    .filter((n) => names.includes(n) && n !== current);
  out.push('HEAD  (uncommitted changes only)', 'HEAD~1  (the previous commit)');
  for (const n of names) if (!out.includes(n) && n !== current) out.push(n);
  for (const ln of gitText(root, ['log', '-12', '--format=%h  %s']).split('\n')) if (ln) out.push(ln.slice(0, 70));
  return out;
}

/** Ref -> full commit id. Throws TardisError with a friendly message when unknown. */
function resolveRef(root, ref) {
  ref = String(ref).trim();
  if (!ref || ref.startsWith('-')) throw new TardisError(`"${ref}" is not a usable git reference.`);
  const sha = gitText(root, ['rev-parse', '--verify', '--quiet', ref + '^{commit}']);
  if (!sha) throw new TardisError(`Git does not know "${ref}". Use a branch, tag or commit that exists in this repository.`);
  return sha;
}

/** Tracked + untracked-but-not-ignored files, exactly as git sees them (null = no git). */
function gitList(root) {
  if (gitText(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const out = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { timeout: 180000 });
  return out ? out.toString('utf8').split('\0').filter(Boolean) : null;
}

/** Files as of a commit. @returns {{rel:string, sha:string, size:number, mode:string}[]} */
function gitTree(root, sha) {
  const out = git(root, ['ls-tree', '-r', '-l', '-z', sha], { timeout: 180000 });
  if (!out) throw new TardisError('Could not read that commit from git.');
  const files = [];
  for (const rec of out.toString('utf8').split('\0')) {
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const bits = rec.slice(0, tab).split(/\s+/);
    if (bits.length < 4 || bits[1] !== 'blob') continue;
    files.push({ rel: rec.slice(tab + 1), sha: bits[2], size: /^\d+$/.test(bits[3]) ? Number(bits[3]) : 0, mode: bits[0] });
  }
  return files;
}

/**
 * Reads many blobs through `git cat-file --batch` (one process per ~64 MB of content
 * instead of one per file - the difference between seconds and minutes on Windows).
 * @param {string} root
 * @param {{sha: string, size: number}[]} wanted
 * @returns {Map<string, Buffer>}
 */
function readBlobs(root, wanted) {
  const got = new Map();
  let batch = [], bytes = 0;
  const flush = () => {
    if (!batch.length) return;
    const out = git(root, ['cat-file', '--batch'], { input: batch.join('\n') + '\n', timeout: 300000 });
    batch = []; bytes = 0;
    if (!out) return;
    let pos = 0;
    while (pos < out.length) {
      const nl = out.indexOf(0x0a, pos);
      if (nl < 0) break;
      const head = out.subarray(pos, nl).toString('latin1').split(' ');
      if (head.length < 3) { pos = nl + 1; continue; }        // "<sha> missing"
      const size = Number(head[2]);
      got.set(head[0], out.subarray(nl + 1, nl + 1 + size));
      pos = nl + 1 + size + 1;
    }
  };
  for (const w of wanted) {
    batch.push(w.sha); bytes += w.size;
    if (bytes > 64 * 1024 * 1024) flush();
  }
  flush();
  return got;
}

/**
 * What changed between the merge base of `since` and now (or `atSha`).
 * The merge base makes "since main" mean "what my branch changed" - the pull-request view.
 * @returns {{changes: Object<string,string>, deleted: string[], diff: string,
 *            stat: string, base: string}}
 */
function gitChanges(root, since, atSha = '') {
  const sinceSha = resolveRef(root, since);
  const base = gitText(root, ['merge-base', sinceSha, atSha || 'HEAD']) || sinceSha;
  const rng = atSha ? [base, atSha] : [base];
  const raw = git(root, ['diff', '--name-status', '-z', '-M', '--relative', ...rng], { timeout: 120000 });
  const toks = raw ? raw.toString('utf8').split('\0') : [];
  const changes = {};
  const deleted = [];
  for (let i = 0; i < toks.length && toks[i];) {
    const code = toks[i][0];
    if ((code === 'R' || code === 'C') && i + 2 < toks.length) {
      changes[toks[i + 2]] = code === 'R' ? `renamed from ${toks[i + 1]}` : 'added';
      i += 3;
    } else if (i + 1 < toks.length) {
      if (code === 'D') deleted.push(toks[i + 1]);
      else changes[toks[i + 1]] = code === 'A' ? 'added' : 'modified';
      i += 2;
    } else break;
  }
  if (!atSha) {       // brand-new files git does not track yet also count as "added"
    const others = git(root, ['ls-files', '-z', '--others', '--exclude-standard']);
    for (const f of others ? others.toString('utf8').split('\0') : []) if (f && !changes[f]) changes[f] = 'added';
  }
  const text = (args) => { const o = git(root, args, { timeout: 120000 }); return o ? decode(o) : ''; };
  return {
    changes, deleted, base,
    diff: text(['diff', '--no-ext-diff', '--no-color', '-M', '--relative', ...rng]),
    stat: text(['diff', '--stat', '--relative', ...rng]),
  };
}

const REMOTE_RE = /^(?:https?:\/\/|git@|ssh:\/\/|git:\/\/|gh:)|^(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//;
/** Does this look like a repository address rather than a local folder? */
const isRemote = (spec) => REMOTE_RE.test(String(spec).trim());
const TEMP_DIRS = [];
process.on('exit', () => {
  for (const d of TEMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 2 }); } catch { /* best effort */ } }
});

/**
 * Understands pasted browser URLs, including ".../tree/<branch>/<sub/folder>".
 * @returns {{url: string, branch: string, sub: string, name: string}}
 */
function parseRemote(spec) {
  let s = String(spec).trim().split('#')[0].split('?')[0].replace(/\/+$/, '');
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

/**
 * Clones into a temp folder that is removed on exit.
 * @param {string} spec
 * @param {boolean} needHistory full clone (needed for time travel) instead of --depth 1
 * @returns {{root: string, url: string, name: string}}
 */
function cloneRemote(spec, needHistory = false) {
  if (!hasGit()) throw new TardisError('Git must be installed to fetch remote projects.');
  const { url, branch, sub, name } = parseRemote(spec);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tardis-'));
  TEMP_DIRS.push(tmp);
  const dest = path.join(tmp, name);
  const args = ['clone', '--quiet', ...(needHistory ? [] : ['--depth', '1']),
    ...(branch ? ['--branch', branch] : []), '--', url, dest];
  const r = spawnSync('git', args, { env: GIT_ENV, timeout: 900000, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error || r.status !== 0) {
    const err = r.stderr ? r.stderr.toString('utf8').trim().split('\n').pop() : '';
    throw new TardisError(`Could not fetch ${url} - ${err || 'git clone failed'}. Is the address right, and the repository public?`);
  }
  const root = sub ? path.join(dest, ...sub.split('/')) : dest;
  if (!fs.existsSync(root)) throw new TardisError(`"${sub}" was not found in that repository.`);
  return { root, url, name };
}

/** Time travel needs history; shallow clones fetch the rest on demand. */
function ensureHistory(root) {
  if (gitText(root, ['rev-parse', '--is-shallow-repository']) === 'true') {
    git(root, ['fetch', '--unshallow', '--tags', '--quiet'], { timeout: 900000 });
    git(root, ['fetch', '--quiet', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { timeout: 900000 });
  }
}

// =====================================================================================
// 8. Scanning
// =====================================================================================

const isJunkDir = (name) => JUNK_DIRS.has(name) || name.endsWith('.egg-info');
function isSecretName(name) {
  const low = name.toLowerCase();
  return !SECRET_SAFE_WORDS.some((w) => low.includes(w)) && SECRET_NAME_RE.test(low);
}

/** Filter for paths that came from git (already .gitignore-clean). */
function listedPathOk(rel, opts, counters) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  if (parts.some((p) => VCS_DIRS.has(p))) return false;
  if (!opts.include_hidden && parts.some((p) => p.startsWith('.'))) { counters.hidden++; return false; }
  if (parts.slice(0, -1).some(isJunkDir)) return false;
  return !(JUNK_FILE_RE.test(name) || SNAPSHOT_RE.test(name));
}

/** Manual directory walk with the built-in .gitignore interpreter. @returns {string[]} */
function walk(root, startRel, opts, counters) {
  const found = [];
  const recurse = (dirRel, stack) => {
    const absDir = dirRel ? path.join(root, ...dirRel.split('/')) : root;
    let items;
    try { items = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (opts.use_ignore) {
      try {
        const rules = parseIgnoreLines(fs.readFileSync(path.join(absDir, '.gitignore'), 'utf8').split('\n'));
        if (rules.length) stack = stack.concat([[dirRel, rules]]);
      } catch { /* no .gitignore here */ }
    }
    for (const d of items) {
      const name = d.name;
      if (VCS_DIRS.has(name) || SNAPSHOT_RE.test(name)) continue;
      if (name.startsWith('.') && !opts.include_hidden) { counters.hidden++; continue; }
      const isDir = d.isDirectory();                 // false for symlinks: never followed
      const rel = dirRel ? `${dirRel}/${name}` : name;
      if (opts.use_ignore) {
        if (isDir) {
          if (isJunkDir(name) || BUILD_DIRS.has(name)) continue;
          if (fs.existsSync(path.join(absDir, name, 'pyvenv.cfg'))) continue;   // a virtualenv
        } else if (JUNK_FILE_RE.test(name)) continue;
        let ignored = false;
        for (const [base, rules] of stack) {
          const verdict = rulesVerdict(rules, base ? rel.slice(base.length + 1) : rel, isDir);
          if (verdict !== null) ignored = verdict;
        }
        if (ignored) continue;
      }
      if (isDir) recurse(rel, stack); else found.push(rel);
    }
  };
  recurse(startRel, []);
  return found;
}

/** Finds the candidate files. @returns {{rels: string[], method: 'git'|'walk'}} */
function discoverFiles(root, opts, counters) {
  const listed = opts.use_ignore ? gitList(root) : null;
  if (!listed) return { rels: walk(root, '', opts, counters), method: 'walk' };
  const rels = [];
  const seen = new Set();
  for (const rel of listed) {
    if (seen.has(rel) || !listedPathOk(rel, opts, counters)) continue;
    seen.add(rel);
    let st;
    try { st = fs.lstatSync(path.join(root, rel)); } catch { continue; }   // deleted in the working tree
    if (st.isDirectory()) rels.push(...walk(root, rel, opts, counters));   // a submodule
    else rels.push(rel);
  }
  return { rels, method: 'git' };
}

/** Counts lines of a (possibly huge) file without loading it whole. */
function countFileLines(abs) {
  let n = 0;
  try {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(1 << 20);
    for (let got = fs.readSync(fd, buf, 0, buf.length, null); got > 0; got = fs.readSync(fd, buf, 0, buf.length, null)) {
      for (let i = 0; i < got; i++) if (buf[i] === 0x0a) n++;
    }
    fs.closeSync(fd);
  } catch { /* unreadable: 0 */ }
  return n;
}

/** Too big for full contents - can we still show a useful short view? */
function condenseLarge(e, ext, data) {
  if (['csv', 'tsv', 'jsonl', 'ndjson', 'log'].includes(ext)) {
    const head = data ? data.subarray(0, 262144) : e.readBytes(262144);
    if (!head || !head.length) return false;
    const lines = decode(head).split('\n').slice(0, -1);
    let total = data ? 0 : countFileLines(e.abs);
    if (data) for (const b of data) if (b === 0x0a) total++;
    const got = condenseRows(lines, Math.max(total, lines.length), ['csv', 'tsv'].includes(ext) ? 5 : 3);
    if (!got) return false;
    e.cond = [got[0], got[1], e.lang];
    e.lines = total;
  } else if (e.size <= CONDENSE_CAP) {
    const ok = e.load(data) && e.condensed();
    e.text = null;                       // keep memory small; reloads on demand
    if (!ok) return false;
  } else return false;
  e.def = 'condensed';
  e.note = `too large for full contents, ${humanSize(e.size)}`;
  return true;
}

/**
 * Classifies one file: included in full, condensed by default, or skipped with a reason.
 * @param {string} root
 * @param {string} rel
 * @param {object} opts
 * @param {{omit: GlobSet, condense: GlobSet}} rules
 * @param {{blob?: {sha:string,size:number,mode:string}, data?: Buffer|null,
 *          change?: string, unchanged?: boolean}} [x] extras for git time travel
 * @returns {Entry}
 */
function makeEntry(root, rel, opts, rules, x = {}) {
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const e = new Entry(rel, path.join(root, ...rel.split('/')), root);
  e.lang = detectLanguage(name);
  e.change = x.change || '';
  const ext = extOf(name);
  if (x.blob) {
    e.blob = x.blob.sha; e.size = x.blob.size;
    if (x.blob.mode === '120000') { e.skip = 'symlink'; e.note = 'symlink'; return e; }
  } else {
    let st;
    try { st = fs.lstatSync(e.abs); } catch { e.skip = 'unreadable'; e.note = 'unreadable'; return e; }
    if (st.isSymbolicLink()) {
      try { e.link = fs.readlinkSync(e.abs); } catch { e.link = '?'; }
      e.skip = 'symlink'; e.note = `symlink to ${e.link}`; return e;
    }
    if (!st.isFile()) { e.skip = 'special'; e.note = 'not a regular file'; return e; }
    e.size = st.size;
  }
  const size = humanSize(e.size);
  if (BINARY_EXTS.has(ext)) {
    const what = IMAGE_EXTS.has(ext) && !x.blob ? imageInfo(e.readBytes(262144) || Buffer.alloc(0)) : '';
    e.skip = 'binary'; e.note = `${what || 'binary'}, ${size}`; return e;
  }
  if (x.unchanged) { e.skip = 'unchanged'; e.note = 'unchanged'; e.forceable = true; return e; }
  const data = x.data || null;
  const head = x.blob ? (data || Buffer.alloc(0)).subarray(0, 8192) : (e.readBytes(8192) || Buffer.alloc(0));
  if (looksBinary(head)) { e.skip = 'binary'; e.note = `binary, ${size}`; return e; }
  const low = name.toLowerCase();
  e.forceable = true;
  if (rules.omit.matches(rel)) { e.skip = 'user'; e.note = 'left out by user'; }
  else if (!opts.include_secrets && isSecretName(low)) { e.skip = 'secret'; e.note = 'withheld, may contain secrets'; }
  else if (!opts.include_locks && LOCK_FILES.has(low)) { e.skip = 'lock'; e.note = `lock file, ${size}`; }
  else if (!opts.include_locks && GENERATED_RE.test(low)) { e.skip = 'generated'; e.note = `generated/minified, ${size}`; }
  else if (e.size > opts.max_size_kb * 1024) {
    if (!condenseLarge(e, ext, data)) { e.skip = 'large'; e.note = `too large, ${size}`; }
  } else if (!e.load(data)) { e.forceable = false; e.skip = 'unreadable'; e.note = 'unreadable'; }
  else if (['ipynb', 'csv', 'tsv', 'jsonl', 'ndjson'].includes(ext) || rules.condense.matches(rel)) {
    if (e.condensed()) e.def = 'condensed';
  }
  return e;
}

/** Sort key: files before folders at every level; the root README goes first. */
function sortKey(rel) {
  const parts = rel.split('/');
  const key = parts.slice(0, -1).map((p) => [1, p.toLowerCase(), p]);
  const name = parts[parts.length - 1];
  const first = parts.length === 1 && name.toLowerCase().startsWith('readme');
  key.push([0, first ? '' : name.toLowerCase(), name]);
  return key;
}
function cmpKeys(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    for (let j = 0; j < 3; j++) {
      if (a[i][j] < b[i][j]) return -1;
      if (a[i][j] > b[i][j]) return 1;
    }
  }
  return a.length - b.length;
}

/**
 * Scans a project folder.
 * @param {object} opts see defaultOptions()
 * @param {{skipRel?: string}} [x] skipRel: a relative path to leave out (our own output file)
 * @returns {object} the "scan": { root, name, entries, git, method, hiddenSkipped, opts,
 *          changes, deleted, diff, diffstat, base, atSha, refs, importGraph() }
 */
function scanProject(opts, x = {}) {
  let root = path.resolve(String(opts.root));
  try { root = fs.realpathSync(root); } catch { /* keep as typed */ }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new TardisError(`Not a folder: ${root}`);
  opts = { ...opts, root };
  const info = gitInfo(root);
  if ((opts.since || opts.at) && !info.inside) {
    throw new TardisError('Time travel needs a git repository, and this folder is not one.');
  }
  const counters = { hidden: 0 };
  const atSha = opts.at ? resolveRef(root, opts.at) : '';
  let ch = { changes: {}, deleted: [], diff: '', stat: '', base: '' };
  if (opts.since) ch = gitChanges(root, opts.since, atSha);
  const blobs = new Map();
  let rels, method;
  if (atSha) {
    method = 'git history';
    rels = [];
    for (const f of gitTree(root, atSha)) {
      if (listedPathOk(f.rel, opts, counters)) { rels.push(f.rel); blobs.set(f.rel, f); }
    }
  } else ({ rels, method } = discoverFiles(root, opts, counters));
  const exclude = new GlobSet(opts.exclude_globs), include = new GlobSet(opts.include_globs);
  if (!exclude.empty) rels = rels.filter((r) => !exclude.matches(r));
  if (!include.empty) rels = rels.filter((r) => include.matches(r));
  if (x.skipRel) rels = rels.filter((r) => r !== x.skipRel);
  const rules = { omit: new GlobSet(opts.omit_globs), condense: new GlobSet(opts.condense_globs) };
  // --at: fetch every needed blob in a few batched git calls before classifying.
  let blobData = new Map();
  if (atSha) {
    const cap = Math.max(opts.max_size_kb * 1024, CONDENSE_CAP);
    const wanted = rels.map((r) => blobs.get(r)).filter((b) => b.mode !== '120000' &&
      b.size <= cap && !BINARY_EXTS.has(extOf(b.rel)) && !(opts.since && !ch.changes[b.rel]));
    blobData = readBlobs(root, wanted);
  }
  const entries = rels.map((rel) => {
    const blob = blobs.get(rel);
    const change = ch.changes[rel] || '';
    return makeEntry(root, rel, opts, rules, { blob, data: blob ? blobData.get(blob.sha) : null,
      change, unchanged: Boolean(opts.since) && !change });
  });
  const keys = new Map(entries.map((e) => [e, sortKey(e.rel)]));
  entries.sort((a, b) => cmpKeys(keys.get(a), keys.get(b)));
  let graph = null;
  return {
    root, name: path.basename(root) || root, entries, git: info, method,
    hiddenSkipped: counters.hidden, opts, changes: ch.changes, deleted: ch.deleted,
    diff: ch.diff, diffstat: ch.stat, base: ch.base, atSha,
    refs: info.inside ? gitRefs(root) : [],
    /** Lazily built import graph (section 9). `fresh` forces a rebuild. */
    importGraph(fresh = false) { if (!graph || fresh) graph = buildImportGraph(entries); return graph; },
  };
}

/** Quick list of existing files (for matching file names mentioned in replies). */
function listFiles(root, cap = 20000) {
  const out = new Set();
  const recurse = (dir, rel) => {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of items) {
      if (out.size >= cap) return;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!VCS_DIRS.has(d.name) && !JUNK_DIRS.has(d.name)) recurse(path.join(dir, d.name), r); }
      else out.add(r);
    }
  };
  recurse(String(root), '');
  return out;
}

// =====================================================================================
// 9. Import graph ("follow the imports")
// =====================================================================================

const PY_FROM_RE = /^[ \t]*from[ \t]+(\.*)([\w.]*)[ \t]+import[ \t]+\(?([^\n#]*)/gm;
const PY_IMPORT_RE = /^[ \t]*import[ \t]+([^\n#]+)/gm;
const JS_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']/g;
const JS_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.json',
  '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];
const JS_LANGS = new Set(['javascript', 'typescript', 'jsx', 'tsx', 'vue', 'svelte', 'astro', 'mdx']);
const QUOTED_IMPORTS = {
  c: /#\s*include\s*"([^"]+)"/g, cpp: /#\s*include\s*"([^"]+)"/g,
  objectivec: /#\s*(?:include|import)\s*"([^"]+)"/g,
  css: /@import\s+(?:url\()?["']([^"']+)["']/g,
  scss: /@(?:import|use|forward)\s+["']([^"']+)["']/g,
  less: /@import\s+["']([^"']+)["']/g,
  ruby: /require_relative\s+["']([^"']+)["']/g,
  php: /(?:require|include)(?:_once)?[\s(]+(?:__DIR__\s*\.\s*)?["']\/?([^"']+)["']/g,
  html: /(?:src|href)\s*=\s*["']([^"'#?:]+)["']/g,
};
const QUOTED_SUFFIXES = ['', '.rb', '.css', '.scss', '.less', '.h', '.hpp', '.php'];

/**
 * Which project files does each file import? Best effort, by regular expressions,
 * resolved only to files that really exist in the project.
 * @param {Entry[]} entries
 * @returns {Map<string, Set<string>>} rel -> rels it imports
 */
function buildImportGraph(entries) {
  const paths = new Set(entries.map((e) => e.rel));
  const suffix = new Map();   // "a/b.py" -> every rel that ends with it
  const byDir = new Map();
  for (const rel of paths) {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(i).join('/');
      if (!suffix.has(key)) suffix.set(key, []);
      suffix.get(key).push(rel);
    }
    const dir = parts.slice(0, -1).join('/');
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(rel);
  }
  const commonLen = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  /** Best file ending with `sfx`: prefers the one closest to the importing file. */
  const near = (sfx, src) => {
    const cands = suffix.get(sfx.replace(/^\/+/, ''));
    if (!cands) return null;
    const here = src.includes('/') ? src.slice(0, src.lastIndexOf('/') + 1) : '';
    return cands.slice().sort((a, b) => commonLen(b, here) - commonLen(a, here) || a.length - b.length)[0];
  };
  const join = (src, spec) => {
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(src), spec));
    return p.startsWith('..') ? null : p;
  };
  const goMod = entries.find((e) => e.rel === 'go.mod' && e.loaded);
  const goModule = goMod ? ((/^module\s+(\S+)/m.exec(goMod.text) || [])[1] || '') : '';

  const graph = new Map();
  for (const e of entries) {
    if (!e.loaded) continue;
    const text = e.text, rel = e.rel, found = new Set();
    if (e.lang === 'python') {
      for (const m of text.matchAll(PY_FROM_RE)) {
        const dots = m[1], mod = m[2].replace(/\./g, '/');
        let stem = mod;
        if (dots) {
          let base = path.posix.dirname(rel);
          for (let k = 1; k < dots.length; k++) base = path.posix.dirname(base);
          if (base === '.') base = '';
          stem = mod ? path.posix.join(base, mod) : base;
        }
        const names = stripChars(m[3], '() \t').split(',').map((s) => s.trim()).filter((s) => s && s !== '*');
        for (const c of [stem, ...names.map((nm) => `${stem}/${nm.split(/\s+/)[0]}`)]) {
          for (const tail of ['.py', '/__init__.py']) {
            const p = c.replace(/^\/+|\/+$/g, '') + tail;
            const hit = dots ? (paths.has(p) ? p : null) : near(p, rel);
            if (hit) found.add(hit);
          }
        }
      }
      for (const m of text.matchAll(PY_IMPORT_RE)) {
        for (const part of m[1].split(',')) {
          const word = part.trim().split(/\s+/)[0];
          if (!word) continue;
          for (const tail of ['.py', '/__init__.py']) {
            const hit = near(word.replace(/\./g, '/') + tail, rel);
            if (hit) found.add(hit);
          }
        }
      }
    } else if (JS_LANGS.has(e.lang)) {
      for (const m of text.matchAll(JS_IMPORT_RE)) {
        const spec = m[1];
        let bases;
        if (spec.startsWith('.')) bases = [join(rel, spec)];
        else if (spec.startsWith('@/') || spec.startsWith('~/')) bases = ['src/' + spec.slice(2), spec.slice(2), 'app/' + spec.slice(2)];
        else continue;                                   // a package, not a project file
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
        tries.push(path.posix.join(path.posix.dirname(base), '_' + path.posix.basename(base) + '.scss'));
        const hit = tries.find((t) => paths.has(t)) || near(m[1], rel);
        if (hit) found.add(hit);
      }
    } else if (e.lang === 'go' && goModule) {
      for (const m of text.slice(0, 20000).matchAll(/"([^"\s]+)"/g)) {
        if (!m[1].startsWith(goModule + '/')) continue;
        for (const f of byDir.get(m[1].slice(goModule.length + 1)) || []) {
          if (f.endsWith('.go') && !f.endsWith('_test.go')) found.add(f);
        }
      }
    } else if (['java', 'kotlin', 'scala', 'groovy'].includes(e.lang)) {
      for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+)/gm)) {
        const p = m[1].replace(/\./g, '/');
        for (const cand of [p, p.slice(0, Math.max(0, p.lastIndexOf('/')))]) {
          const hit = ['.java', '.kt', '.scala', '.groovy'].map((x) => near(cand + x, rel)).find(Boolean);
          if (hit) { found.add(hit); break; }
        }
      }
    } else if (e.lang === 'rust') {
      const d = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
      const stem = path.posix.basename(rel).replace(/\.[^.]*$/, '');
      const home = ['main', 'lib', 'mod'].includes(stem) ? d : path.posix.join(d, stem);
      for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/gm)) {
        for (const p of [`${home}/${m[1]}.rs`, `${home}/${m[1]}/mod.rs`]) {
          const clean = p.replace(/^\/+/, '');
          if (paths.has(clean)) found.add(clean);
        }
      }
    }
    found.delete(rel);
    if (found.size) graph.set(rel, found);
  }
  return graph;
}

/** Everything reachable from `starts` by following imports (starts included). */
function importClosure(graph, starts) {
  const seen = new Set(starts);
  const todo = [...seen];
  while (todo.length) {
    for (const nxt of graph.get(todo.pop()) || []) {
      if (!seen.has(nxt)) { seen.add(nxt); todo.push(nxt); }
    }
  }
  return seen;
}

/**
 * A selection that keeps only `starts` plus everything they import.
 * @returns {{selection: Object<string,string>, keep: Set<string>}}
 */
function focusSelection(scan, starts, importers = false) {
  const startSet = new Set(starts);
  const graph = scan.importGraph();
  const keep = importClosure(graph, startSet);
  if (importers) {
    for (const [src, targets] of graph) if ([...targets].some((t) => startSet.has(t))) keep.add(src);
  }
  const selection = {};
  for (const e of scan.entries) {
    if (!e.checkable) continue;
    if (keep.has(e.rel)) { if (e.skip) selection[e.rel] = 'full'; }
    else selection[e.rel] = 'off';
  }
  return { selection, keep };
}

// =====================================================================================
// 10. Priorities, the plan, and the token budget
// =====================================================================================

/**
 * How much a file matters when the budget forces choices (higher = trimmed later).
 * Deliberately simple so the outcome can be explained: README 100, manifests 90,
 * entry points 80, source 60, docs/config ~40, tests 25, fixtures 15, licences 10.
 * @param {Entry} e
 * @param {number} [inDegree=0] how many project files import it
 */
function priority(e, inDegree = 0) {
  if (e.change) return 150;
  const parts = e.rel.toLowerCase().split('/');
  const name = parts[parts.length - 1], dirs = parts.slice(0, -1), depth = dirs.length;
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  if (depth === 0 && name.startsWith('readme')) return 100;
  if (MANIFESTS.has(name)) return 90 - 5 * depth;
  if (dirs.some((d) => LOW_DIRS.has(d))) return 15;
  if (dirs.some((d) => TEST_DIRS.has(d)) || TEST_NAME_RE.test(name)) return 25;
  if (['license', 'licence', 'changelog', 'history', 'authors', 'contributors',
    'code_of_conduct', 'notice', 'copying'].some((p) => name.startsWith(p))) return 10;
  if (DOC_LANGS.has(e.lang)) return depth === 0 ? 40 : 35;
  if (DATA_LANGS.has(e.lang)) return ['csv', 'svg'].includes(e.lang) ? 20 : 40;
  return (ENTRY_STEMS.has(stem) ? 80 : 60) - 2 * Math.min(depth, 5) + Math.min(15, 3 * inDegree);
}

/**
 * Decides, per file, 'full' / 'condensed' / 'off'.
 * @param {object} scan
 * @param {Object<string,string>} [selection] explicit user choices (these are "pinned":
 *        the budget never overrides them)
 * @returns {object[]} items: { e, mode, note, code, pinned, auto, label }
 */
function makePlan(scan, selection = {}) {
  return scan.entries.map((e) => {
    let want = selection[e.rel];
    const pinned = want !== undefined;
    if (want === undefined) want = e.skip ? 'off' : e.def;
    const item = { e, mode: want, note: '', code: '', pinned, auto: '', label: '' };
    if (want !== 'off') {
      let ok = !e.skip || (e.forceable && e.load());
      if (ok && want === 'condensed' && !e.condensed()) {
        item.mode = 'full'; item.note = 'no shorter view exists; shown in full';
      }
      if (ok && item.mode === 'full' && !e.load()) ok = false;
      if (ok) return item;
      item.mode = 'off';
      if (e.skip && !e.forceable) { item.note = e.note; item.code = e.skip; }
      else { item.note = 'unreadable'; item.code = 'unreadable'; }
    } else if (e.skip) { item.note = e.note; item.code = e.skip; }
    else { item.note = 'left out by user'; item.code = 'user'; }
    return item;
  });
}

/**
 * The ordered list of sacrifices when over budget. A file is condensed at its priority
 * and dropped at priority + 25, so a low-priority file disappears before an important
 * one is even condensed.
 * @returns {Array<[object, 'condensed'|'off']>}
 */
function trimSteps(scan, items, redact, numbered) {
  let graph;
  try { graph = scan.importGraph(); } catch { graph = new Map(); }
  const indeg = new Map();
  for (const targets of graph.values()) for (const t of targets) indeg.set(t, (indeg.get(t) || 0) + 1);
  const steps = [];
  for (const it of items) {
    if (it.pinned || it.mode === 'off') continue;
    const p = priority(it.e, indeg.get(it.e.rel) || 0);
    const tok = it.e.view(it.mode, redact, numbered).tokens;
    if (it.mode === 'full' && it.e.condensed() &&
        it.e.view('condensed', redact, numbered).tokens < tok * 0.7) steps.push([p, 0, -tok, it, 'condensed']);
    steps.push([p + 25, 1, -tok, it, 'off']);
  }
  steps.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return steps.map((s) => [s[3], s[4]]);
}

// =====================================================================================
// 11. Rendering
// =====================================================================================

/** A code fence longer than any run of backticks inside `text`. */
function fenceFor(text) {
  let longest = 0;
  for (const m of text.matchAll(new RegExp(BT + '{3,}', 'g'))) longest = Math.max(longest, m[0].length);
  return BT.repeat(Math.max(3, longest + 1));
}
const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const partEnd = (k, n) => `END OF PART ${k} OF ${n} - more parts follow. Do not answer yet: ` +
  `reply only "Received part ${k} of ${n}" and wait for the rest.`;
const headLine = () => `Packed by ${APP_NAME} v${VERSION} (${APP_LONG}) - "${TAGLINE}"`;

/**
 * The three output formats. Each is a set of small building blocks that buildDocument
 * assembles; XML and text override only what differs from Markdown.
 */
const MarkdownFmt = {
  marker: 'a heading of the form "### FILE n/N: `relative/path`" followed by a fenced ' +
    'code block holding the file contents',
  tick: BT,
  head: (name) => [`# Project snapshot: ${name}`, '', `> ${headLine()}`,
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
      ...rows.map(([i, rel, kind, lines, tok]) =>
        `| ${i} | \`${rel.replace(/\|/g, '\\|')}\` | ${kind} | ${fmt(lines)} | ${fmt(tok)} |`)];
  },
  /** @returns {[string[], string[], string]} head lines, foot lines, anchor (for "jump to file") */
  file(i, n, rel, flags, meta, lang, body) {
    const f = fenceFor(body);
    const anchor = `### FILE ${i}/${n}${flags ? ` (${flags})` : ''}: \`${rel}\``;
    return [['---', '', anchor, '', `*${meta}*`, '', f + lang], [f, ''], anchor];
  },
  partHead: (name, k, n, note) => [`# Project snapshot: ${name} - part ${k} of ${n}`, '', `> ${note}`, ''],
  partFoot: (k, n) => ['---', '', partEnd(k, n), ''],
  end: (footer) => ['---', '', footer, ''],
  close: () => [],
};
const XmlFmt = { ...MarkdownFmt,
  marker: 'a <file index="n" path="relative/path" ...> line and ends with a </file> line; ' +
    'the text in between is the exact, unescaped file contents',
  tick: '',
  head: (name) => [`<project_snapshot name="${xmlEsc(name)}" generator="${APP_NAME} ${VERSION}">`, ''],
  heading: () => [],
  section: (key, title, lines) => [`<${key}>`, ...lines, `</${key}>`, ''],
  kv: (rows) => rows.map(([k, v]) => `${k}: ${v}`),
  index: (rows) => (rows.length ? rows.map(([i, rel, kind, lines, tok]) =>
    `${i}. ${rel} (${kind}, ${plural(lines, 'line')}, ~${fmt(tok)} tokens)`) : ['(no file contents included)']),
  file(i, n, rel, flags, meta, lang) {
    const anchor = `<file index="${i}" path="${xmlEsc(rel)}"`;
    return [[`${anchor} of="${n}" language="${lang}"${flags ? ` view="${xmlEsc(flags)}"` : ''} note="${xmlEsc(meta)}">`],
      ['</file>', ''], anchor];
  },
  partHead: (name, k, n, note) => [`<project_snapshot name="${xmlEsc(name)}" part="${k}" of="${n}">`, note, ''],
  partFoot: (k, n) => [partEnd(k, n), '</project_snapshot>'],
  end: (footer) => [footer],
  close: () => ['</project_snapshot>', ''],
};
const BAR = '='.repeat(80), THIN = '-'.repeat(80);
const TextFmt = { ...MarkdownFmt,
  marker: 'a banner line "FILE n/N: relative/path" and ends with a line "END OF FILE: relative/path"',
  tick: '',
  head: (name) => [BAR, `PROJECT SNAPSHOT: ${name}`, headLine(), BAR, ''],
  heading: (title) => [title.toUpperCase(), THIN, ''],
  section: (key, title, lines) => [title.toUpperCase(), THIN, ...lines, ''],
  kv(rows) {
    const w = Math.max(...rows.map(([k]) => k.length)) + 1;
    return rows.map(([k, v]) => `${(k + ':').padEnd(w)} ${v}`);
  },
  index: (rows) => (rows.length ? rows.map(([i, rel, kind, lines, tok]) =>
    `${String(i).padStart(4)}. ${rel}  (${kind}, ${plural(lines, 'line')}, ~${fmt(tok)} tokens)`) : ['(no file contents included)']),
  file(i, n, rel, flags, meta) {
    const anchor = `FILE ${i}/${n}${flags ? ` (${flags})` : ''}: ${rel}`;
    return [[BAR, anchor, `(${meta})`, BAR], [`-------- END OF FILE: ${rel} --------`, ''], anchor];
  },
  partHead: (name, k, n, note) => [BAR, `PROJECT SNAPSHOT: ${name} - PART ${k} OF ${n}`, note, BAR, ''],
  partFoot: (k, n) => [BAR, partEnd(k, n), BAR, ''],
  end: (footer) => [BAR, footer, BAR, ''],
};
const FORMATS = { markdown: MarkdownFmt, xml: XmlFmt, text: TextFmt };

/**
 * Draws the directory map.
 * Folders whose files are all unchanged (--since) or all unticked collapse to one line.
 */
function renderTree(name, items, treeOnly) {
  const mk = () => ({ dirs: new Map(), files: [], total: 0, quiet: 0, same: 0 });
  const top = mk();
  for (const it of items) {
    const parts = it.e.rel.split('/');
    let node = top;
    for (const d of parts.slice(0, -1)) {
      if (!node.dirs.has(d)) node.dirs.set(d, mk());
      node = node.dirs.get(d);
    }
    node.files.push([parts[parts.length - 1], it]);
  }
  const tally = (node) => {
    node.total = node.files.length;
    for (const [, it] of node.files) {
      if (it.mode === 'off' && (it.code === 'user' || it.code === 'unchanged')) {
        node.quiet++;
        if (it.code === 'unchanged') node.same++;
      }
    }
    for (const sub of node.dirs.values()) { tally(sub); node.total += sub.total; node.quiet += sub.quiet; node.same += sub.same; }
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
  const draw = (node, prefix) => {
    const kids = [...node.files.map((f) => ['f', f]), ...[...node.dirs.entries()].map((d) => ['d', d])];
    kids.forEach(([kind, payload], idx) => {
      const last = idx === kids.length - 1;
      const branch = last ? '└── ' : '├── ';
      if (kind === 'f') { lines.push(prefix + branch + label(payload[0], payload[1])); return; }
      const [dname, sub] = payload;
      if (!treeOnly && sub.total && sub.total === sub.quiet) {
        const what = sub.same === sub.total ? `(${plural(sub.total, 'unchanged file')})`
          : `[omitted: ${plural(sub.total, 'file')} left out]`;
        lines.push(`${prefix}${branch}${dname}/  ${what}`);
      } else {
        lines.push(prefix + branch + dname + '/');
        draw(sub, prefix + (last ? '    ' : '│   '));
      }
    });
  };
  draw(top, '');
  return lines.join('\n');
}

/** One sentence describing which filters produced this snapshot. */
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

/** Wraps one file view into a section: { rel, i, n, flags, meta, lang, body, head, foot, anchor, tokens }. */
function makeSec(F, i, n, it, v) {
  const e = it.e;
  let flags = '', meta;
  if (it.mode === 'condensed') {
    flags = 'condensed';
    meta = `CONDENSED VIEW (${v.label}) - not the complete file` +
      (e.lines ? `; the full file has ${plural(e.lines, 'line')}` : '');
  } else {
    meta = `${langName(e.lang)} · ${plural(e.lines, 'line')} · ~${fmt(v.tokens)} tokens` + (v.body ? '' : ' · empty file');
    if (it.note) meta += ` · ${it.note}`;
  }
  if (e.change) meta += ` · ${e.change}`;
  const [head, foot, anchor] = F.file(i, n, e.rel, flags, meta, v.lang, v.body);
  return { rel: e.rel, i, n, flags, meta, lang: v.lang, body: v.body, head, foot, anchor,
    tokens: v.tokens + TOKENS.count([...head, ...foot].join('\n')) };
}

/** Splits any single file that is bigger than a whole part into line-range chunks. */
function chunkSections(F, secs, cap) {
  const out = [];
  for (const s of secs) {
    if (s.tokens <= cap) { out.push(s); continue; }
    const lines = s.body.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const total = lines.length;
    const per = Math.max(10, Math.trunc(total * Math.max(cap - 80, 100) / Math.max(1, s.tokens) * 0.9));
    for (let a = 0; a < total; a += per) {
      const b = Math.min(total, a + per);
      const flags = [s.flags, a ? 'continued' : '', `lines ${a + 1}-${b} of ${total}`].filter(Boolean).join(', ');
      const body = lines.slice(a, b).join('\n') + '\n';
      const [head, foot, anchor] = F.file(s.i, s.n, s.rel, flags, s.meta, s.lang, body);
      out.push({ ...s, flags, body, head, foot, anchor,
        tokens: TOKENS.count(body) + TOKENS.count([...head, ...foot].join('\n')) });
    }
  }
  return out;
}

/** Greedy packing of sections into parts no larger than the budget. */
function packParts(frontTok, secs, tailTok, budget, overhead = 120) {
  const groups = [[]];
  let used = frontTok + overhead;
  for (const s of secs) {
    if (used + s.tokens > budget && (groups[groups.length - 1].length || groups.length === 1)) {
      groups.push([]); used = overhead;
    }
    groups[groups.length - 1].push(s);
    used += s.tokens;
  }
  if (used + tailTok > budget && groups[groups.length - 1].length && tailTok > 0) groups.push([]);
  return groups;
}

/**
 * The heart of the outbound trip: plan -> (trim to budget) -> render -> (split).
 * @param {object} scan       result of scanProject
 * @param {object} opts       render options (fmt, budget, over, redact, task ...)
 * @param {Object<string,string>} [selection] explicit per-file choices
 * @returns {object} document: { parts, partTokens, tokens, items, filesFull,
 *          filesCondensed, filesOff, lines, secrets, redacted, anchors, omittedCounts,
 *          fileTokens, budget, overBudget, trimmed, squeezed, counter, text }
 */
function buildDocument(scan, opts, selection = {}) {
  const F = FORMATS[opts.fmt] || MarkdownFmt;
  const items = makePlan(scan, selection);
  const { redact, line_numbers: numbered, tree_only: treeOnly } = opts;
  const so = scan.opts;
  const budget = treeOnly ? 0 : opts.budget;
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const when = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

  // The diff (only with --since). Too big for the budget? Fall back to the --stat summary.
  let diffText = '', diffNote = '';
  if (so.since && opts.include_diff && scan.diff) {
    diffText = scan.diff.replace(/\n+$/, '');
    if (diffText.length > 400000 || (budget && TOKENS.count(diffText) > budget * 0.4)) {
      diffText = scan.diffstat.replace(/\n+$/, '');
      diffNote = 'The full diff was too large for this snapshot; this is the summary (git diff --stat).';
    }
  }
  // Whatever follows the END OF SNAPSHOT marker: the task and the reply instructions.
  const tail = [];
  if (opts.task.trim()) tail.push(...F.section('task', 'Your task', opts.task.trim().split('\n')));
  if (opts.reply_format && !treeOnly) tail.push(...F.section('reply_format', 'How to send back file changes', REPLY_FORMAT));
  const tailTok = TOKENS.count(tail.join('\n'));

  const st = {};        // numbers shared between the loop below and front()
  /** Everything before the first file: title, guide, overview, changes, map, index. */
  const front = (sizeText, nParts) => {
    const live = st.live;
    const nFull = live.filter((it) => it.mode === 'full').length, nCond = live.length - nFull;
    const off = items.filter((it) => it.mode === 'off');
    const g = [`This is a snapshot of the project folder "${scan.name}/", packed into one ` +
      'document so the whole project can be read or pasted in one go.'];
    if (nParts > 1) g.push(`Because of its size the snapshot is split into ${nParts} parts; this is part 1. ` +
      `Wait until you have all ${nParts} parts before answering - until then reply only "Received part k of ${nParts}".`);
    g.push('OVERVIEW: key facts and statistics about the project.');
    if (so.since) g.push('CHANGES: what changed since the chosen git reference' + (diffText ? ', followed by the diff' : '') +
      '. Only changed files have their contents included; in the map they are tagged [modified], [added] or ' +
      '[renamed ...]; everything else is unchanged.');
    if (treeOnly) g.push('DIRECTORY MAP: the complete folder tree with line counts. This is a structure-only ' +
      'snapshot: file contents were deliberately left out.');
    else {
      g.push('DIRECTORY MAP: the folder tree. Entries tagged [omitted: reason] exist in the project but their ' +
        'contents are not in this document.');
      if (nCond) g.push('Entries tagged [condensed: ...] are included as a shortened view (an outline with bodies ' +
        'collapsed, a sample of rows, a structure sketch). Their sections are marked CONDENSED VIEW; they are not the complete file.');
      g.push('FILE INDEX: numbered list of every included file.');
      g.push(`FILE CONTENTS: one section per file, in index order. Each section starts with ${F.marker}.`);
      g.push('Headings, separators and metadata lines between sections are labels, not file content.');
      if (numbered) g.push('Every content line is prefixed with its line number ("  12 | "); the prefix is not part of the file.');
      if (st.redacted) g.push('[REDACTED:...] placeholders stand for secret values removed before sharing. Treat them as opaque and keep them unchanged.');
    }
    g.push('All paths are relative to the project root and use forward slashes.');
    if (tail.length) g.push('After the snapshot ends you will find ' +
      (opts.task.trim() ? 'the task to carry out' : 'instructions for sending back file changes') + '.');
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
      rows.push(['Files included', `${fmt(nFull)} in full${nCond ? `, ${fmt(nCond)} condensed` : ''} (${plural(st.lines, 'line')})`]);
      const shown = Object.entries(st.counts).filter(([c]) => c !== 'unchanged').sort((a, b) => b[1] - a[1]);
      if (shown.length) rows.push(['Listed in map only', `${fmt(shown.reduce((s, x) => s + x[1], 0))} (` +
        shown.map(([c, k]) => `${fmt(k)} ${REASON_LABELS[c] || c}`).join(', ') + ')']);
    }
    if (budget) {
      if (opts.over === 'split') rows.push(['Token budget', `${fmt(budget)} per part - ` +
        (nParts > 1 ? `split into ${nParts} parts` : 'everything fits in one part')]);
      else rows.push(['Token budget', `${fmt(budget)} - ` + (st.squeezed || st.trimmed
        ? `to fit, ${plural(st.squeezed, 'file')} were condensed and ${fmt(st.trimmed)} left out, lowest priority first`
        : 'everything fits')]);
    }
    if (sizeText) rows.push(['Approx. size', `${sizeText} (${TOKENS.name})`]);
    if (st.lines) {
      const langs = new Map();
      for (const it of live) langs.set(langName(it.e.lang), (langs.get(langName(it.e.lang)) || 0) + it.e.lines);
      rows.push(['Languages', [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).filter((x) => x[1])
        .map(([k, v]) => `${k} ${(v * 100 / Math.max(1, st.lines)).toFixed(0)}%`).join(', ')]);
    }
    if (st.redacted) rows.push(['Redactions', `${plural(st.redacted, 'secret-looking value')} replaced by [REDACTED:...] placeholders`]);
    rows.push(['Filters', filtersText(scan)]);

    const L = [...F.head(scan.name)];
    L.push(...F.section('guide', 'How to read this document', g.map((x) => '- ' + x)));
    L.push(...F.section('overview', 'Overview', F.kv(rows)));
    if (so.since) {
      const ch = Object.keys(scan.changes).sort().map((rel) => `- ${scan.changes[rel]}: ${rel}`);
      ch.push(...scan.deleted.slice().sort().map((rel) => `- deleted: ${rel}`));
      L.push(...F.section('changes', `Changes since ${so.since}`, ch.length ? ch : ['(nothing changed)']));
      if (diffText) {
        if (diffNote && F.tick) L.push(`_${diffNote}_`, '');
        L.push(...F.section('diff', 'Diff', [...(diffNote && !F.tick ? [diffNote, ''] : []), ...diffText.split('\n')], true, 'diff'));
      }
    }
    L.push(...F.section('directory_map', 'Directory map', renderTree(scan.name, items, treeOnly).split('\n'), true));
    if (!treeOnly) {
      const idx = F.index(st.index);
      const t = F.tick;
      const auto = off.filter((it) => !['user', 'unchanged', 'budget'].includes(it.code));
      const extra = auto.slice(0, 60).map((it) => `${t}${it.e.rel}${t} - ${it.note}`);
      if (auto.length > 60) extra.push(`...and ${fmt(auto.length - 60)} more (each is tagged in the map)`);
      if (st.counts.budget) extra.push(`${plural(st.counts.budget, 'file')} trimmed to fit the token budget (each is tagged in the map)`);
      if (st.counts.user) extra.push(`${plural(st.counts.user, 'file')} left out by user`);
      if (extra.length) idx.push('', 'Listed in the map but NOT included:', '', ...extra.map((x) => '- ' + x));
      L.push(...F.section('file_index', 'File index', idx));
      L.push(...F.heading('File contents'));
    }
    return L;
  };

  // Render, measure, and - if over budget in "trim" mode - give up the least important
  // files step by step, then measure again. The result is verified, not estimated.
  let steps = null, pos = 0, secs = [], total = 0, frontTok = 0, findings = [];
  for (let round = 0; round < 12; round++) {
    const live = treeOnly ? [] : items.filter((it) => it.mode !== 'off');
    secs = []; findings = [];
    live.forEach((it, i) => {
      const v = it.e.view(it.mode, redact, numbered);
      it.label = v.label;
      secs.push(makeSec(F, i + 1, live.length, it, v));
      for (const [ln, kind] of v.findings) findings.push([it.e.rel, ln, kind]);
    });
    const counts = {};
    for (const it of items) if (it.mode === 'off') counts[it.code] = (counts[it.code] || 0) + 1;
    Object.assign(st, { live, counts, lines: live.reduce((s, it) => s + it.e.lines, 0),
      redacted: redact ? findings.length : 0,
      squeezed: items.filter((it) => it.auto && it.mode === 'condensed').length,
      trimmed: counts.budget || 0,
      index: secs.map((s, k) => [s.i, s.rel, s.flags ? 'condensed' : langName(live[k].e.lang), live[k].e.lines, s.tokens]) });
    frontTok = TOKENS.count(front('', 1).join('\n')) + 25;
    total = frontTok + secs.reduce((s, x) => s + x.tokens, 0) + tailTok;
    if (!budget || opts.over !== 'trim' || total <= budget) break;
    if (!steps) steps = trimSteps(scan, items, redact, numbered);
    if (pos >= steps.length) break;
    let excess = total - budget;
    while (excess > 0 && pos < steps.length) {
      const [it, to] = steps[pos++];
      if (it.mode === 'off' || (to === 'condensed' && it.mode !== 'full')) continue;
      const before = it.e.view(it.mode, redact, numbered).tokens + 30;
      let after = 0;
      if (to === 'condensed') {
        it.mode = 'condensed'; it.auto = 'budget';
        after = it.e.view('condensed', redact, numbered).tokens + 30;
      } else {
        it.mode = 'off'; it.auto = 'budget'; it.code = 'budget';
        it.note = 'trimmed to fit the token budget';
      }
      excess -= before - after;
    }
  }

  let groups = [secs];
  if (budget && opts.over === 'split' && total > budget) {
    secs = chunkSections(F, secs, Math.max(500, budget - 200));
    groups = packParts(frontTok, secs, tailTok, budget);
  }
  const nParts = groups.length;
  const size = `~${fmt(total)} tokens` + (nParts > 1 ? ` across ${nParts} parts` : '');
  const footer = `END OF SNAPSHOT - ${scan.name} - ` + (treeOnly ? 'structure only' : plural(st.live.length, 'file')) +
    (nParts > 1 ? `, ${nParts} parts` : '') + `. Packed by ${APP_NAME} v${VERSION}.`;
  const parts = [], partTokens = [], anchors = {}, fileTokens = {};
  groups.forEach((group, gi) => {
    const k = gi + 1;
    let L, tok;
    if (k === 1) { L = front(size, nParts); tok = frontTok; }
    else {
      const note = group.length
        ? `Continuation of the snapshot of "${scan.name}" (files ${group[0].i}-${group[group.length - 1].i} of ${group[0].n}).`
        : `Final part of the snapshot of "${scan.name}".`;
      L = F.partHead(scan.name, k, nParts, note); tok = 60;
    }
    for (const s of group) {
      L.push(...s.head);
      if (s.body) L.push(s.body.endsWith('\n') ? s.body.slice(0, -1) : s.body);
      L.push(...s.foot);
      if (!(s.rel in anchors)) anchors[s.rel] = [gi, s.anchor];
      fileTokens[s.rel] = (fileTokens[s.rel] || 0) + s.tokens;
      tok += s.tokens;
    }
    if (k < nParts) { L.push(...F.partFoot(k, nParts)); tok += 40; }
    else { L.push(...F.end(footer), ...F.close(), ...tail); tok += tailTok; }
    parts.push(L.join('\n') + '\n');
    partTokens.push(tok);
  });
  return {
    parts, partTokens, tokens: total, items,
    filesFull: st.live.filter((it) => it.mode === 'full').length,
    filesCondensed: st.live.filter((it) => it.mode === 'condensed').length,
    filesOff: items.filter((it) => it.mode === 'off').length,
    lines: st.lines, secrets: findings, redacted: st.redacted, anchors,
    omittedCounts: st.counts, fileTokens, budget,
    overBudget: Boolean(budget && opts.over === 'trim' && total > budget),
    trimmed: st.trimmed, squeezed: st.squeezed, counter: TOKENS.name,
    get text() { return this.parts.join('\n'); },
  };
}

// =====================================================================================
// 12. The return trip: parse an AI reply, preview, apply, undo
// =====================================================================================

const FENCE_LINE_RE = new RegExp('^\\s{0,3}(' + BT + '{3,}|~{3,})(.*)$');
const EXPLICIT_RE = /^\s{0,3}(?:#{1,6}\s*)?[*_]*\s*(FILE|EDIT)\b(?:\s+\d+\s*\/\s*\d+)?(?:\s*\(([^)]*)\))?\s*:[*_]*\s*(.+?)\s*$/i;
const DELETE_RE = /^\s{0,3}(?:#{1,6}\s*)?[*_]*\s*DELETE\s*:[*_]*\s*(.+?)\s*$/;
const NUM_RE = /^\s*(\d+) \|(?: (.*))?$/;
const BT_TOKEN_RE = new RegExp(BT + '([^' + BT + ']+)' + BT);
const INFER_RES = [
  /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/,                                         // ### src/app.py
  /^\s*(?:[-*]\s+|\d+[.)]\s+)?\*\*(.+?)\*\*:?\s*$/,                           // **src/app.py**
  new RegExp('^\\s*(?:[-*]\\s+|\\d+[.)]\\s+)?(' + BT + '[^' + BT + ']+' + BT + '):?\\s*$'),   // `src/app.py`
  /^\s*([\w@./\\-]+\.[A-Za-z][A-Za-z0-9]{0,9}):?\s*$/,                        // src/app.py:
];
const FIRST_LINE_RE = /^\s*(?:#|\/\/|\/\*|<!--|--|;)\s*(?:file(?:name)?\s*:\s*)?([\w@./\\()[\]-]+\.[A-Za-z][A-Za-z0-9]{0,9})\s*(?:\*\/|-->)?\s*$/i;
const SHELLISH = new Set(['bash', 'sh', 'shell', 'console', 'zsh', 'powershell', 'cmd', 'text', 'txt', 'output', 'plaintext', 'terminal']);
const BARE_NAMES = new Set(['Makefile', 'Dockerfile', 'Gemfile', 'Procfile', 'Rakefile', 'Jenkinsfile', 'LICENSE', 'README', 'Pipfile', 'Justfile']);
const COMMENT_RE = /^(?:#+|\/\/+|\/\*+|\*+|<!--|--|;+|%+|\{\/\*)\s*/;
const ELISION_WORDS = /\b(rest|remaining|existing|previous|unchanged|same|other|more|omitted|truncated|snip|code|implementation|keep|before|above|etc)\b/i;
const ELISION_PHRASE = /\b(rest of (the |this |your )?(file|code|class|function|method|implementation|content|logic)|existing (code|content|imports|functions|methods|logic)|(remains?|stays?) (the )?(same|unchanged)|same as (before|above|the original)|unchanged (code|from|below|above)|code (omitted|unchanged|remains)|(previous|other|remaining) (code|methods|functions|imports|content))\b/i;

/** Lines of a code block -> file text. Strips our own "  12 | " line numbers if present. */
function joinBody(body) {
  if (!body.length) return '';
  const nums = body.map((b) => NUM_RE.exec(b));
  if (nums.every(Boolean) && nums.every((m, i) => Number(m[1]) === i + 1)) body = nums.map((m) => m[2] || '');
  return body.join('\n') + '\n';
}

/**
 * Extracts a plausible relative path from a label ('' when it is not one).
 * @param {string} raw
 * @param {Set<string>} known   existing project files (always accepted)
 * @param {boolean} lenient     accept anything inside backticks (explicit FILE: labels)
 */
function cleanPath(raw, known, lenient = false) {
  let s = stripChars(raw.trim(), '*_').trim();
  const m = BT_TOKEN_RE.exec(s);
  if (m) s = m[1];
  s = stripChars(s.trim(), '"\'').replace(/:+$/, '').trim().replace(/\\/g, '/');
  if (!s || s.length > 260 || s.includes('\n')) return '';
  if (known.has(s)) return s;
  if (/[<>|*?"]/.test(s)) return '';
  if (lenient && m) return s;
  if (s.includes(' ') || /^https?:\/\//.test(s) || /[=;,{}]/.test(s)) return '';
  return s.includes('/') || /\.[A-Za-z][A-Za-z0-9_+-]{0,9}$/.test(s) || BARE_NAMES.has(s) ? s : '';
}

/** Guesses a file name from an informal label line ('' when the line is not a label). */
function inferLabel(line, known) {
  for (const rx of INFER_RES) {
    const m = rx.exec(line);
    if (m) {
      const inner = m[1].replace(/\s*\([^)]*\)\s*$/, '')
        .replace(/^(?:\d+[.)]\s*)?(?:updated|new|modified|create|file|filename|path)?\s*(?:file)?\s*:?\s*/i, '');
      return cleanPath(inner, known);
    }
  }
  const s = line.trim();
  if (s.endsWith(':')) {            // "Here's the updated `src/app.py`:"
    const hits = [...s.matchAll(new RegExp(BT_TOKEN_RE.source, 'g'))]
      .map((t) => cleanPath(BT + t[1] + BT, known)).filter(Boolean);
    if (hits.length === 1) return hits[0];
  }
  return '';
}

/**
 * Reads a fenced block. Tolerates the classic mistake of nesting 3-backtick blocks
 * inside a markdown file that is itself in a 3-backtick fence.
 * @returns {[string[], number]} body lines and the index of the closing line
 */
function readBlock(lines, start, fence, info) {
  const ch = fence[0], size = fence.length;
  const first = info.trim() ? info.trim().split(/\s+/)[0].split(':')[0].toLowerCase() : '';
  const md = size === 3 && ['markdown', 'md', 'mdx'].includes(first);
  let depth = 0;
  const body = [];
  for (let k = start; k < lines.length; k++) {
    const m = FENCE_LINE_RE.exec(lines[k]);
    if (m && m[1][0] === ch) {
      const rest = m[2].trim();
      if (!rest) {
        if (m[1].length >= size && depth === 0) return [body, k];
        if (depth > 0) depth--;
      } else if (md) depth++;
    }
    body.push(lines[k]);
  }
  return [body, lines.length - 1];
}

/** Parses SEARCH/REPLACE pairs. @returns {[Array<[string,string]>, string]} edits and an inline path */
function parseSR(body, known) {
  const edits = [];
  let pathInside = '', state = 0, search = [], repl = [];
  const text = (ls) => (ls.length ? ls.join('\n') + '\n' : '');
  for (const ln of body) {
    const s = ln.trim();
    if (state === 0) {
      if (s.startsWith(SR_START)) { state = 1; search = []; repl = []; }
      else if (s && !pathInside) pathInside = cleanPath(s, known);
    } else if (state === 1) {
      if (s === SR_MID) state = 2; else search.push(ln);
    } else if (s.startsWith(SR_END)) { edits.push([text(search), text(repl)]); state = 0; }
    else repl.push(ln);
  }
  return [edits, pathInside];
}

/**
 * Finds file changes in an AI reply (or in a TARDIS snapshot).
 * Understands "### FILE: path" + code block, "### EDIT: path" + SEARCH/REPLACE,
 * "### DELETE: path", and the informal styles AIs use anyway.
 * @param {string} text
 * @param {Iterable<string>} [knownPaths]
 * @returns {{changes: object[], info: {skipped: number, unsupported: string[], problems: string[]}}}
 *          change = { path, kind: 'write'|'edit'|'delete', content, edits, flags, explicit, labelLine }
 */
function parseReply(text, knownPaths = []) {
  const known = new Set(knownPaths);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const changes = [];
  const info = { skipped: 0, unsupported: [], problems: [] };
  let label = null, age = 0;

  const block = (fenceInfo, body) => {
    const words = fenceInfo.split(/\s+/).filter(Boolean);
    let lang = words.length ? words[0].toLowerCase() : '';
    let infoPath = '';
    const m = /(?:title|file|filename|path)\s*=\s*["']?([^"'\s]+)/.exec(fenceInfo);
    if (m) infoPath = cleanPath(m[1], known);
    else if (lang.includes(':')) { infoPath = cleanPath(words[0].slice(words[0].indexOf(':') + 1), known); lang = lang.split(':')[0]; }
    else if (words.length && (words[0].includes('/') || known.has(words[0]))) { infoPath = cleanPath(words[0], known); lang = ''; }
    const lab = label;
    label = null;
    if (body.some((ln) => ln.trim().startsWith(SR_START))) {
      const [edits, inner] = parseSR(body, known);
      const p = (lab && lab.path) || infoPath || inner;
      if (p && edits.length) changes.push({ path: p, kind: 'edit', content: '', edits, flags: '', explicit: true, labelLine: '' });
      else info.skipped++;
      return;
    }
    let p = lab ? lab.path : '';
    const kind = lab ? lab.kind : 'write', explicit = lab ? lab.explicit : false, flags = lab ? lab.flags : '';
    let labelLine = '';
    if (!p) p = infoPath;
    if (!p && body.length) {
      const fm = FIRST_LINE_RE.exec(body[0]);
      const guess = fm ? cleanPath(fm[1], known) : '';
      if (guess && (known.has(guess) || guess.includes('/'))) { p = guess; labelLine = body[0]; }
    }
    if (!p) info.skipped++;
    else if (kind === 'edit') info.problems.push(`${p}: EDIT block without SEARCH/REPLACE markers`);
    else if ((lang === 'diff' || lang === 'patch') && !/\.(diff|patch)$/.test(p)) info.unsupported.push(p);
    else if (!explicit && SHELLISH.has(lang) && !/\.(sh|bash|zsh|bat|ps1|txt|log)$/.test(p)) info.skipped++;
    else changes.push({ path: p, kind: 'write', content: joinBody(body), edits: [], flags, explicit, labelLine });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fm = FENCE_LINE_RE.exec(line);
    if (fm && !fm[2].includes(BT)) {
      const [body, end] = readBlock(lines, i + 1, fm[1], fm[2].trim());
      block(fm[2].trim(), body);
      i = end;
      continue;
    }
    if (line.trim().startsWith(SR_START)) {                    // an unfenced edit block
      let j = i;
      while (j < lines.length && !lines[j].trim().startsWith(SR_END)) j++;
      const [edits] = parseSR(lines.slice(i, j + 1), known);
      if (label && edits.length) changes.push({ path: label.path, kind: 'edit', content: '', edits, flags: '', explicit: true, labelLine: '' });
      label = null;
      i = j;
      continue;
    }
    const dm = DELETE_RE.exec(line);
    const delPath = dm ? cleanPath(dm[1], known, true) : '';
    if (delPath) {
      changes.push({ path: delPath, kind: 'delete', content: '', edits: [], flags: '', explicit: true, labelLine: '' });
      label = null;
      continue;
    }
    const em = EXPLICIT_RE.exec(line);
    const p = em ? cleanPath(em[3], known, true) : '';
    if (p) { label = { path: p, kind: em[1].toLowerCase() === 'edit' ? 'edit' : 'write', explicit: true, flags: (em[2] || '').toLowerCase() }; age = 0; }
    else {
      const guess = inferLabel(line, known);
      if (guess) { label = { path: guess, kind: 'write', explicit: false, flags: '' }; age = 0; }
      else if (line.trim()) {
        age++;                                                 // labels go stale after some prose
        if (label && age > (label.explicit ? 6 : 2)) label = null;
      }
    }
  }
  return { changes, info };
}

/** Line number of an "I skipped the rest" marker in proposed content, or 0. */
function findElision(content, lang) {
  if (DOC_LANGS.has(lang)) return 0;
  const lines = content.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const s = lines[n].trim();
    if (!s || s.length > 160) continue;
    const m = COMMENT_RE.exec(s);
    const inner = m ? s.slice(m[0].length).trim() : s;
    const tail = inner.replace(/[ */>-]+$/, '');
    const dots = inner.startsWith('...') || inner.startsWith('\u2026') || tail.endsWith('...') || tail.endsWith('\u2026');
    if (m && dots && (inner.length <= 5 || ELISION_WORDS.test(inner))) return n + 1;
    if (m && ELISION_PHRASE.test(inner)) return n + 1;
    if (!m && lang !== 'python' && ['...', '\u2026', '[...]', '(...)', '{...}'].includes(s)) return n + 1;
    if (!m && dots && ELISION_PHRASE.test(inner)) return n + 1;
  }
  return 0;
}

/**
 * One SEARCH/REPLACE. Exact first; then ignoring trailing whitespace; then ignoring
 * indentation (the replacement is re-indented to match the file).
 * @returns {[string, boolean]|null} [new text, wasFuzzy] or null when not found
 */
function applyEdit(text, search, repl) {
  if (!search.trim()) return [text + (!text || text.endsWith('\n') ? '' : '\n') + repl, false];
  const at = text.indexOf(search);
  if (at >= 0) return [text.slice(0, at) + repl + text.slice(at + search.length), false];
  const tl = text.split('\n');
  const sl = search.replace(/\n+$/, '').split('\n');
  const rl = repl.replace(/^\n+|\n+$/g, '') ? repl.replace(/\n+$/, '').split('\n') : [];
  for (const norm of [(x) => x.trimEnd(), (x) => x.trim()]) {
    const tn = tl.map(norm), key = sl.map(norm);
    for (let i = 0; i + key.length <= tl.length; i++) {
      if (tn[i] !== key[0] || !key.every((k, j) => tn[i + j] === k)) continue;
      let out = rl;
      if (norm('  x  ') === 'x') {                             // indentation-insensitive pass
        const j = Math.max(0, sl.findIndex((v) => v.trim()));
        const have = /^\s*/.exec(tl[i + j])[0], want = /^\s*/.exec(sl[j])[0];
        if (have.startsWith(want)) out = rl.map((x) => (x.trim() ? have.slice(want.length) + x : x));
        else if (want.startsWith(have)) {
          const cut = want.length - have.length;
          out = rl.map((x) => (x.slice(0, cut).trim() ? x : x.slice(cut)));
        }
      }
      return [[...tl.slice(0, i), ...out, ...tl.slice(i + key.length)].join('\n'), true];
    }
  }
  return null;
}

/** Normalises a path from a reply; null when it is unsafe (absolute, "..", into .git). */
function safeRel(p) {
  let norm = p.trim().replace(/\\/g, '/');
  while (norm.startsWith('./')) norm = norm.slice(2);
  const parts = norm.split('/').filter((x) => x && x !== '.');
  if (!parts.length || norm.startsWith('/') || parts.includes('..') || /^[A-Za-z]:/.test(norm) ||
      parts[0] === '.git' || parts[0] === '.tardis') return null;
  return parts.join('/');
}

/**
 * Line diff by longest common subsequence (after trimming the common head and tail).
 * Very large differing regions fall back to "replace the whole region" to bound memory.
 * @param {string[]} a old lines
 * @param {string[]} b new lines
 * @returns {{t: ' '|'-'|'+', s: string}[]}
 */
function lineDiff(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s), B = b.slice(p, b.length - s);
  const out = a.slice(0, p).map((x) => ({ t: ' ', s: x }));
  const n = A.length, m = B.length;
  if (n * m > 6000000 || !n || !m) {
    for (const x of A) out.push({ t: '-', s: x });
    for (const x of B) out.push({ t: '+', s: x });
  } else {
    const W = m + 1;
    const L = new Uint32Array((n + 1) * W);                    // L[i*W+j] = LCS(A[i:], B[j:])
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { out.push({ t: ' ', s: A[i] }); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) out.push({ t: '-', s: A[i++] });
      else out.push({ t: '+', s: B[j++] });
    }
    while (i < n) out.push({ t: '-', s: A[i++] });
    while (j < m) out.push({ t: '+', s: B[j++] });
  }
  for (const x of a.slice(a.length - s)) out.push({ t: ' ', s: x });
  return out;
}

/** Unified diff lines ("@@ -a,b +c,d @@", " ctx", "-old", "+new") with `ctx` context lines. */
function unifiedDiff(oldLines, newLines, ctx = 3) {
  const seq = lineDiff(oldLines, newLines);
  const changed = [];
  seq.forEach((e, i) => { if (e.t !== ' ') changed.push(i); });
  if (!changed.length) return [];
  const hunks = [];
  let hs = Math.max(0, changed[0] - ctx), he = Math.min(seq.length, changed[0] + ctx + 1);
  for (const c of changed.slice(1)) {
    if (c - ctx <= he) he = Math.min(seq.length, c + ctx + 1);
    else { hunks.push([hs, he]); hs = Math.max(0, c - ctx); he = Math.min(seq.length, c + ctx + 1); }
  }
  hunks.push([hs, he]);
  const out = [];
  let o = 1, nn = 1, idx = 0;
  for (const [s, e] of hunks) {
    for (; idx < s; idx++) { if (seq[idx].t !== '+') o++; if (seq[idx].t !== '-') nn++; }
    let oc = 0, nc = 0;
    for (let k = s; k < e; k++) { if (seq[k].t !== '+') oc++; if (seq[k].t !== '-') nc++; }
    out.push(`@@ -${o},${oc} +${nn},${nc} @@`);
    for (let k = s; k < e; k++) out.push(seq[k].t + seq[k].s);
  }
  return out;
}

/** Text -> lines without the empty element a trailing newline would produce. */
const bodyLines = (text) => { const ls = (text || '').split('\n'); if (ls.length && ls[ls.length - 1] === '') ls.pop(); return ls; };

/**
 * Compares proposed changes with the files on disk. Writes nothing.
 * Risky changes come back with ok=false and a note explaining why.
 * @param {object[]} changes from parseReply
 * @param {string} rootDir
 * @returns {object[]} planned: { path, status: 'new'|'modified'|'unchanged'|'delete'|'problem',
 *          old, new, notes, ok, added, removed }
 */
function evaluateChanges(changes, rootDir) {
  let root = path.resolve(String(rootDir));
  try { root = fs.realpathSync(root); } catch { /* may not exist yet (rematerializing) */ }
  const rootName = path.basename(root);
  const order = [], by = new Map(), chunked = new Set();
  const problem = (p, note) => order.push({ path: p, status: 'problem', old: null, new: null, notes: [note], ok: false, added: 0, removed: 0 });
  for (const ch of changes) {
    let rel = safeRel(ch.path);
    if (rel === null) { problem(ch.path, 'unsafe path'); continue; }
    const abs = (r) => path.join(root, ...r.split('/'));
    if (rootName && rel.startsWith(rootName + '/') && !fs.existsSync(abs(rel))) {
      const short = rel.slice(rootName.length + 1);            // the AI prefixed the project name
      if (fs.existsSync(abs(short)) || !fs.existsSync(abs(rootName))) rel = short;
    }
    const target = abs(rel);
    if (target !== root && !target.startsWith(root + path.sep)) { problem(ch.path, 'unsafe path'); continue; }
    let p = by.get(rel);
    if (!p) {
      let old = null;
      try { if (fs.statSync(target).isFile()) old = decode(fs.readFileSync(target)); } catch { /* new file */ }
      p = { path: rel, status: '', old, new: old, notes: [], ok: true, added: 0, removed: 0 };
      by.set(rel, p); order.push(p);
    }
    if (p.status === 'problem') continue;
    if (ch.kind === 'delete') p.new = null;
    else if (ch.kind === 'write') {
      let content = ch.content;
      if (ch.labelLine && content.startsWith(ch.labelLine + '\n') && !(p.old || '').startsWith(ch.labelLine + '\n')) {
        content = content.slice(ch.labelLine.length + 1);      // drop the AI's "# path" comment
      }
      if (ch.flags.includes('condensed')) { p.notes.push('this is a condensed view, not the real file'); p.ok = false; }
      if (ch.flags.includes('continued') && chunked.has(rel)) content = (p.new || '') + content;
      chunked.add(rel);
      if (!ch.explicit && p.old === null) { p.notes.push('file name was guessed from the text - tick to create it'); p.ok = false; }
      p.new = content;
    } else {
      let base = p.new;
      for (let k = 0; k < ch.edits.length; k++) {
        const [search, repl] = ch.edits[k];
        if (base === null) {
          if (search.trim()) { p.status = 'problem'; p.notes.push(`edit ${k + 1}: the file does not exist`); break; }
          base = repl; continue;
        }
        const res = applyEdit(base, search, repl);
        if (!res) { p.status = 'problem'; p.notes.push(`edit ${k + 1}: the SEARCH text was not found in the file`); break; }
        base = res[0];
        if (res[1]) p.notes.push(`edit ${k + 1}: matched ignoring whitespace differences`);
      }
      if (p.status !== 'problem') p.new = base;
    }
  }
  for (const p of order) {
    if (p.status === 'problem') { p.ok = false; continue; }
    if (p.new === null) {
      p.status = p.old !== null ? 'delete' : 'unchanged';
      p.removed = countLines(p.old || '');
    } else {
      if (p.new.includes('[REDACTED:')) {
        const r = restoreRedactions(p.new, p.old || '');
        p.new = r.text;
        if (r.restored) p.notes.push(`${plural(r.restored, 'redacted secret')} restored from your file`);
        if (r.lost) { p.notes.push('contains [REDACTED] placeholders that could not be matched to your real values'); p.ok = false; }
      }
      if (p.old === null) { p.status = 'new'; p.added = countLines(p.new); }
      else if (p.new === p.old) p.status = 'unchanged';
      else {
        p.status = 'modified';
        for (const e of lineDiff(bodyLines(p.old), bodyLines(p.new))) { if (e.t === '+') p.added++; else if (e.t === '-') p.removed++; }
        const oldN = countLines(p.old), newN = countLines(p.new);
        if (oldN > 40 && newN < oldN * 0.5) p.notes.push(`much shorter than your file (${oldN} -> ${newN} lines) - check nothing was dropped`);
      }
      if (p.status === 'new' || p.status === 'modified') {
        const line = findElision(p.new, detectLanguage(p.path.slice(p.path.lastIndexOf('/') + 1)));
        if (line) {
          p.notes.push(`looks abbreviated (line ${line}: "${p.new.split('\n')[line - 1].trim().slice(0, 50)}") - applying could delete real code`);
          p.ok = false;
        }
        if (p.path.endsWith('.ipynb') && !p.new.trimStart().startsWith('{')) { p.notes.push('not valid notebook JSON'); p.ok = false; }
      }
    }
    if (p.status === 'unchanged') p.ok = false;
  }
  return order;
}

/** Display diff for one planned change. */
function diffLines(p) {
  if (p.status === 'new') return [`+++ new file: ${p.path}`, ...bodyLines(p.new).map((x) => '+' + x)];
  if (p.status === 'delete') return [`--- delete: ${p.path}`, ...bodyLines(p.old).map((x) => '-' + x)];
  if (p.status === 'modified') return [`--- current/${p.path}`, `+++ proposed/${p.path}`, ...unifiedDiff(bodyLines(p.old), bodyLines(p.new))];
  return [];
}

/**
 * A ready-to-paste follow-up message asking the AI to fix what could not be applied
 * (abbreviated files, failed edits, condensed views sent back whole). '' when all is fine.
 */
function fixupRequest(planned, info) {
  const bad = planned.filter((p) => p.notes.length && (!p.ok || p.status === 'problem') && p.status !== 'unchanged');
  if (!bad.length && !info.unsupported.length) return '';
  const out = ['Some of the changes in your last reply could not be applied safely:', ''];
  for (const p of bad) out.push(`- ${p.path}: ${p.notes.join('; ')}`);
  for (const u of info.unsupported) out.push(`- ${u}: sent as a diff, which cannot be applied`);
  out.push('', 'Please resend ONLY these files. For each one write a line "### FILE: relative/path" followed by one ' +
    'fenced code block with the COMPLETE file (no "..." or "rest unchanged"), or use "### EDIT: relative/path" with ' +
    'SEARCH/REPLACE pairs whose SEARCH text is copied exactly from the current file.');
  return out.join('\n');
}

/**
 * Writes the changes. Originals are copied to .tardis/backups/<timestamp>/ first, with a
 * manifest that undoLast() uses. `.tardis/` contains its own .gitignore so git never sees it.
 * @returns {{done: number, backup: string}}
 */
function applyChanges(items, rootDir) {
  const root = path.resolve(String(rootDir));
  fs.mkdirSync(root, { recursive: true });
  const home = path.join(root, '.tardis');
  const d = new Date(), p2 = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  let backup = path.join(home, 'backups', stamp);
  for (let n = 1; fs.existsSync(backup); n++) backup = path.join(home, 'backups', `${stamp}_${n}`);
  fs.mkdirSync(backup, { recursive: true });
  if (!fs.existsSync(path.join(home, '.gitignore'))) fs.writeFileSync(path.join(home, '.gitignore'), '*\n');
  const manifest = { created: [], modified: [], deleted: [] };
  let done = 0;
  for (const p of items) {
    if (!['new', 'modified', 'delete'].includes(p.status)) continue;
    const target = path.join(root, ...p.path.split('/'));
    let crlf = false;
    if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      const keep = path.join(backup, ...p.path.split('/'));
      fs.mkdirSync(path.dirname(keep), { recursive: true });
      fs.copyFileSync(target, keep);
      crlf = fs.readFileSync(target).subarray(0, 65536).includes('\r\n');
    }
    if (p.status === 'delete') { fs.unlinkSync(target); manifest.deleted.push(p.path); }
    else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const text = p.new || '';
      fs.writeFileSync(target, crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8');   // keep CRLF files CRLF
      manifest[p.status === 'new' ? 'created' : 'modified'].push(p.path);
    }
    done++;
  }
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 1));
  return { done, backup };
}

/** Reverts the most recent apply that has not been undone yet. @returns {{n: number, name: string}} */
function undoLast(rootDir) {
  const root = path.resolve(String(rootDir));
  const base = path.join(root, '.tardis', 'backups');
  let names;
  try { names = fs.readdirSync(base).sort().reverse(); } catch { return { n: 0, name: '' }; }
  for (const name of names) {
    const mf = path.join(base, name, 'manifest.json');
    if (!fs.existsSync(mf)) continue;
    const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    let n = 0;
    for (const rel of manifest.created || []) {
      const target = path.join(root, ...rel.split('/'));
      if (fs.existsSync(target)) { fs.unlinkSync(target); n++; }
    }
    for (const rel of [...(manifest.modified || []), ...(manifest.deleted || [])]) {
      const keep = path.join(base, name, ...rel.split('/'));
      if (!fs.existsSync(keep)) continue;
      const target = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(keep, target);
      n++;
    }
    fs.renameSync(mf, path.join(base, name, 'manifest.undone.json'));
    return { n, name };
  }
  return { n: 0, name: '' };
}

// =====================================================================================
// 13. Storage: sessions, profiles, templates
// =====================================================================================

const STATE_FILE = path.join(os.homedir(), '.tardis', 'state.json');   // last sessions, recents, templates
const PROFILE_FILE = '.tardis.json';                                   // named profiles, inside the project

function readJson(file) {
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d === 'object' && !Array.isArray(d) ? d : {}; }
  catch { return {}; }
}
function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 1));
    fs.renameSync(file + '.tmp', file);                        // atomic replace
    return true;
  } catch { return false; }
}
const loadState = () => readJson(STATE_FILE);
const saveState = (s) => writeJson(STATE_FILE, s);
const loadProfiles = (root) => readJson(path.join(root, PROFILE_FILE)).profiles || {};
const saveProfiles = (root, profiles) => writeJson(path.join(root, PROFILE_FILE), { version: 1, profiles });

/**
 * Selection -> storable form. A fully unticked folder is stored as "folder/" so files
 * added to it later stay off.
 * @returns {{full: string[], condensed: string[], off: string[]}}
 */
function compressSelection(sel, entries) {
  const total = new Map(), off = new Map();
  for (const e of entries) {
    if (!e.checkable) continue;
    const parts = e.rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/') + '/';
      total.set(d, (total.get(d) || 0) + 1);
      if (sel[e.rel] === 'off') off.set(d, (off.get(d) || 0) + 1);
    }
  }
  const dead = new Set([...total.keys()].filter((d) => off.get(d) === total.get(d)));
  const out = { full: [], condensed: [], off: [] };
  for (const rel of Object.keys(sel).sort()) {
    const parts = rel.split('/');
    const covered = sel[rel] === 'off' && parts.slice(0, -1).some((_, i) => dead.has(parts.slice(0, i + 1).join('/') + '/'));
    if (!covered && out[sel[rel]]) out[sel[rel]].push(rel);
  }
  const parentOf = (d) => { const s = d.slice(0, -1); return s.includes('/') ? s.slice(0, s.lastIndexOf('/') + 1) : ''; };
  out.off = [...[...dead].filter((d) => !dead.has(parentOf(d))).sort(), ...out.off];
  return out;
}

/** Storable form -> selection for the files that exist right now. */
function expandSelection(data, entries) {
  const files = new Map();
  for (const mode of ['full', 'condensed', 'off']) for (const rel of (data && data[mode]) || []) if (!rel.endsWith('/')) files.set(rel, mode);
  const dirs = ((data && data.off) || []).filter((d) => d.endsWith('/'));
  const sel = {};
  for (const e of entries) {
    if (files.has(e.rel)) sel[e.rel] = files.get(e.rel);
    else if (e.checkable && dirs.some((d) => e.rel.startsWith(d))) sel[e.rel] = 'off';
  }
  return sel;
}

// =====================================================================================
// 14. System glue: clipboard (CLI), browser, right-click menu
// =====================================================================================

/** Runs a command feeding `input`; true on success. */
function pipe(cmd, args, input, env) {
  const r = spawnSync(cmd, args, { input, env, timeout: 20000, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  return !r.error && r.status === 0;
}
/** Copies text to the system clipboard (terminal mode; the GUI uses the browser's clipboard). */
function copyToClipboard(text) {
  if (process.platform === 'darwin') return pipe('pbcopy', [], text, { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' });
  if (process.platform === 'win32') return pipe('clip', [], Buffer.from(text, 'utf16le'));
  return (process.env.WAYLAND_DISPLAY && pipe('wl-copy', [], text)) ||
    pipe('xclip', ['-selection', 'clipboard'], text) || pipe('xsel', ['--clipboard', '--input'], text) ||
    (os.release().toLowerCase().includes('microsoft') && pipe('clip.exe', [], Buffer.from(text, 'utf16le')));
}
/** Reads text from the system clipboard ('' when unavailable). */
function readClipboard() {
  const run = (cmd, args) => {
    const r = spawnSync(cmd, args, { timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
    return r.error || r.status !== 0 ? null : r.stdout.toString('utf8');
  };
  if (process.platform === 'darwin') return run('pbpaste', []) || '';
  if (process.platform === 'win32') {
    return run('powershell', ['-NoProfile', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw']) || '';
  }
  return run('wl-paste', ['--no-newline']) ?? run('xclip', ['-selection', 'clipboard', '-o']) ?? run('xsel', ['--clipboard', '--output']) ?? '';
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}
/** out.md with 3 parts -> [out.part1.md, out.part2.md, out.part3.md] */
function partPaths(file, n) {
  if (n === 1) return [file];
  const ext = path.extname(file);
  return Array.from({ length: n }, (_, k) => `${file.slice(0, file.length - ext.length)}.part${k + 1}${ext}`);
}

/**
 * Opens a URL. With `app`, tries Chrome/Edge in chromeless "app" mode first, which
 * makes the GUI feel like a desktop application.
 */
function openBrowser(url, app = false) {
  const launch = (cmd, args) => new Promise((resolve) => {
    try {
      const c = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
      c.on('error', () => resolve(false));
      c.on('spawn', () => { c.unref(); resolve(true); });
    } catch { resolve(false); }
  });
  (async () => {
    if (app) {
      const pf = process.env['ProgramFiles'] || 'C:\\Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
      const cands = process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : process.platform === 'win32'
          ? [`${pf}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Google\\Chrome\\Application\\chrome.exe`, `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`]
          : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
      for (const c of cands) {
        if ((c.includes('/') || c.includes('\\')) && !fs.existsSync(c)) continue;
        if (await launch(c, [`--app=${url}`, '--window-size=1400,900'])) return;
      }
    }
    if (process.platform === 'darwin') await launch('open', [url]);
    else if (process.platform === 'win32') await launch('cmd', ['/c', 'start', '', url]);
    else await launch('xdg-open', [url]);
  })();
}

/** Adds/removes a right-click "Pack with TARDIS" entry for folders. @returns {string} message */
function installMenu(remove = false) {
  const script = path.resolve(__filename), node = process.execPath;
  if (process.platform === 'win32') {
    for (const [base, arg] of [['HKCU\\Software\\Classes\\Directory\\shell\\TARDIS', '%1'],
      ['HKCU\\Software\\Classes\\Directory\\Background\\shell\\TARDIS', '%V']]) {
      if (remove) spawnSync('reg', ['delete', base, '/f'], { windowsHide: true });
      else {
        spawnSync('reg', ['add', base, '/ve', '/d', 'Pack with TARDIS', '/f'], { windowsHide: true });
        spawnSync('reg', ['add', base + '\\command', '/ve', '/d', `"${node}" "${script}" --gui "${arg}"`, '/f'], { windowsHide: true });
      }
    }
    return remove ? 'Removed the Explorer right-click entry.' : 'Done. Right-click any folder in Explorer -> "Pack with TARDIS".';
  }
  if (process.platform === 'darwin') {
    return 'macOS needs one manual step: open Automator -> new "Quick Action" -> "Workflow receives: folders in Finder" -> ' +
      `add "Run Shell Script" (pass input: as arguments) with this line:\n\n    "${node}" "${script}" --gui "$1"\n\n` +
      'Save it as "Pack with TARDIS". It then appears under right-click -> Quick Actions.';
  }
  const nautilus = path.join(os.homedir(), '.local/share/nautilus/scripts/Pack with TARDIS');
  const dolphin = path.join(os.homedir(), '.local/share/kio/servicemenus/tardis.desktop');
  if (remove) { for (const f of [nautilus, dolphin]) { try { fs.unlinkSync(f); } catch { /* not there */ } } return 'Removed the file-manager entries.'; }
  writeText(nautilus, `#!/bin/sh\nexec "${node}" "${script}" --gui "\${1:-$PWD}"\n`);
  writeText(dolphin, '[Desktop Entry]\nType=Service\nMimeType=inode/directory;\nActions=tardis\n\n[Desktop Action tardis]\n' +
    `Name=Pack with TARDIS\nExec="${node}" "${script}" --gui %f\n`);
  for (const f of [nautilus, dolphin]) fs.chmodSync(f, 0o755);
  return 'Done. GNOME Files: right-click a folder -> Scripts -> "Pack with TARDIS". KDE Dolphin: right-click -> "Pack with TARDIS".';
}

// =====================================================================================
// 15. Server: the JSON API behind the GUI
//
//   GET  /            -> ui.html with a boot object injected (token, defaults, templates)
//   POST /api/<name>  -> JSON in, JSON out: { ok: true, ... } or { ok: false, error }
//
// Security model (it can write files, so it matters):
//   * listens on 127.0.0.1 only;
//   * every API call must carry the random per-run token the page was given
//     (other web sites cannot read it: no CORS headers are ever sent);
//   * the Host header must be 127.0.0.1/localhost, which defeats DNS rebinding.
// =====================================================================================

/**
 * Starts the GUI server.
 * @param {{port?: number, open?: boolean, app?: boolean, stay?: boolean,
 *          initial?: string, defaults?: object}} o
 * @returns {http.Server}
 */
function startServer(o = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const state = loadState();
  /** Server-side session: the current scan lives here between API calls. */
  const S = { scan: null, key: '', remotes: new Map(), watcher: null, dirty: false, bye: null };

  /** (Re)starts watching the project folder so "Live" mode can tell when files change. */
  const watch = (root) => {
    if (S.watcher) { try { S.watcher.close(); } catch { /* already closed */ } S.watcher = null; }
    S.dirty = false;
    try {
      S.watcher = fs.watch(root, { recursive: true }, (_ev, file) => {
        if (file && !/^(\.git|\.tardis)([\\/]|$)/.test(file) && !SNAPSHOT_RE.test(file)) S.dirty = true;
      });
      S.watcher.on('error', () => {});
    } catch { /* recursive watching unsupported here (Linux + Node < 20): Live mode is inert */ }
  };
  const needScan = () => { if (!S.scan) throw new TardisError('Open a project first.'); return S.scan; };
  const optionsFrom = (d) => mergeOptions(defaultOptions(), d || {});

  const api = {
    /** Lists sub-folders for the folder picker. */
    browse({ path: p }) {
      const dir = path.resolve(p || os.homedir());
      let items;
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { throw new TardisError(`Cannot open ${dir}: ${e.code || e.message}`); }
      const dirs = items.filter((d) => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$'))
        .map((d) => ({ name: d.name, repo: fs.existsSync(path.join(dir, d.name, '.git')) }))
        .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      const roots = process.platform === 'win32'
        ? 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('').map((l) => l + ':\\').filter((r) => fs.existsSync(r)) : ['/'];
      return { path: dir, parent: path.dirname(dir) !== dir ? path.dirname(dir) : '', dirs, roots, home: os.homedir(), sep: path.sep,
        isRepo: fs.existsSync(path.join(dir, '.git')) };
    },

    /**
     * Scans a project. `options: null` means "I just opened this project": the server
     * then restores the saved session for it and returns the options and ticks to use.
     */
    scan({ source, options }) {
      source = String(source || '').trim().replace(/^"|"$/g, '');
      if (!source) throw new TardisError('Choose a project folder first.');
      const remote = isRemote(source);
      const key = remote ? source : path.resolve(source);
      let selection = null, restored = null;
      if (options === null || options === undefined) {
        const saved = !remote && state.sessions && state.sessions[key];
        options = saved ? saved.options : (o.defaults || {});
        restored = saved ? saved.selection : null;
      }
      let opts = optionsFrom(options);
      if (remote) {
        let got = S.remotes.get(source);
        if (!got) { got = cloneRemote(source, Boolean(opts.since || opts.at)); S.remotes.set(source, got); }
        else if (opts.since || opts.at) ensureHistory(got.root);
        opts = { ...opts, root: got.root, source: got.url };
      } else opts.root = key;
      TOKENS.ensure();
      const scan = scanProject(opts);
      S.scan = scan; S.key = key;
      if (restored) selection = expandSelection(restored, scan.entries);
      watch(scan.root);
      state.recent = [source, ...(state.recent || []).filter((r) => r !== source)].slice(0, 12);
      saveState(state);
      return {
        name: scan.name, root: scan.root, remote, git: scan.git, refs: scan.refs, method: scan.method,
        hiddenSkipped: scan.hiddenSkipped, changed: Object.keys(scan.changes).length, deleted: scan.deleted.length,
        options: optionsToDict(opts), selection, recent: state.recent, profiles: Object.keys(loadProfiles(scan.root)).sort(),
        entries: scan.entries.map((e) => ({ rel: e.rel, size: e.size, lang: e.lang, skip: e.skip, note: e.note,
          forceable: e.forceable, def: e.def, change: e.change, lines: e.lines })),
      };
    },

    /** Builds the document for the current scan with the given render options and ticks. */
    build({ options, selection }) {
      const scan = needScan();
      const opts = optionsFrom(options);
      const doc = buildDocument(scan, opts, selection || {});
      const rows = {};
      for (const it of doc.items) {
        const e = it.e;
        rows[e.rel] = { mode: it.mode, note: it.note, code: it.code, auto: it.auto, label: it.label, tok: doc.fileTokens[e.rel] || 0,
          // "pot" = what this unticked file WOULD cost, shown in brackets in the tree
          pot: it.mode === 'off' && e.checkable && e.loaded && !opts.tree_only ? e.view('full', opts.redact, opts.line_numbers).tokens : 0 };
      }
      return { parts: doc.parts, partTokens: doc.partTokens, tokens: doc.tokens, budget: doc.budget, overBudget: doc.overBudget,
        trimmed: doc.trimmed, squeezed: doc.squeezed, counter: doc.counter, filesFull: doc.filesFull,
        filesCondensed: doc.filesCondensed, lines: doc.lines, redacted: doc.redacted, secrets: doc.secrets.slice(0, 20),
        anchors: doc.anchors, rows, ext: FORMAT_EXT[opts.fmt] || '.md' };
    },

    /** Import-graph actions from the right-click menu: focus / add imports / add importers. */
    imports({ action, rels, selection }) {
      const scan = needScan();
      const by = new Map(scan.entries.map((e) => [e.rel, e]));
      const starts = rels.filter((r) => by.has(r));
      let reload = false;
      for (const r of starts) { const e = by.get(r); if (!e.loaded && e.checkable && e.load()) reload = true; }
      const graph = scan.importGraph(reload);
      if (action === 'focus') {
        const f = focusSelection(scan, starts);
        return { selection: f.selection, message: `Focus: ${starts.length} selected + ${f.keep.size - starts.length} imported file(s); everything else is unticked.` };
      }
      const startSet = new Set(starts);
      const extra = action === 'add'
        ? [...importClosure(graph, startSet)].filter((r) => !startSet.has(r))
        : [...graph.entries()].filter(([, t]) => [...t].some((x) => startSet.has(x))).map(([src]) => src);
      const sel = { ...(selection || {}) };
      for (const r of [...extra, ...starts]) {
        const e = by.get(r);
        if (!e || !e.checkable) continue;
        if (e.skip) sel[r] = 'full'; else delete sel[r];
      }
      return { selection: sel, message: extra.length ? `${extra.length} related file(s) ticked.` : 'No local imports found for that selection.' };
    },

    /** Named profiles in <project>/.tardis.json: save / load / delete. */
    profile({ action, name, options, selection }) {
      const scan = needScan();
      const profiles = loadProfiles(scan.root);
      let out = {};
      if (action === 'save') {
        profiles[name] = { options: optionsToDict(optionsFrom(options)), selection: compressSelection(selection || {}, scan.entries) };
        if (!saveProfiles(scan.root, profiles)) throw new TardisError('Could not write the profile file.');
      } else if (action === 'delete') { delete profiles[name]; saveProfiles(scan.root, profiles); }
      else if (action === 'load') {
        const p = profiles[name];
        if (!p) throw new TardisError(`No profile named "${name}".`);
        out = { options: optionsToDict(optionsFrom(p.options)), selection: expandSelection(p.selection, scan.entries) };
      }
      return { ...out, profiles: Object.keys(profiles).sort() };
    },

    /** Remembers the settings and ticks of the current project (restored next time it is opened). */
    session({ options, selection }) {
      if (S.scan && S.key && !isRemote(S.key)) {
        state.sessions = state.sessions || {};
        state.sessions[S.key] = { options: optionsToDict(optionsFrom(options)), selection: compressSelection(selection || {}, S.scan.entries) };
        saveState(state);
      }
      return {};
    },

    /** Saves (or, with empty text, deletes) a personal task template. */
    template({ name, text }) {
      state.templates = state.templates || {};
      if (text) state.templates[name] = text; else delete state.templates[name];
      saveState(state);
      return { templates: { ...TEMPLATES, ...state.templates } };
    },

    /** Return trip, step 1: what would this reply change? Writes nothing. */
    analyze({ text, to }) {
      const root = path.resolve(String(to || '.'));
      const known = S.scan && S.scan.root === root ? S.scan.entries.map((e) => e.rel) : listFiles(root);
      const { changes, info } = parseReply(String(text || ''), known);
      const planned = evaluateChanges(changes, root);
      return { info, fixup: fixupRequest(planned, info),
        planned: planned.map((p) => ({ path: p.path, status: p.status, notes: p.notes, ok: p.ok, added: p.added, removed: p.removed,
          diff: diffLines(p).slice(0, 4000), clipped: Math.max(0, diffLines(p).length - 4000) })) };
    },

    /** Return trip, step 2: apply the ticked paths (re-evaluated from the same text). */
    apply({ text, to, paths }) {
      const root = path.resolve(String(to || '.'));
      const known = S.scan && S.scan.root === root ? S.scan.entries.map((e) => e.rel) : listFiles(root);
      const wanted = new Set(paths || []);
      const planned = evaluateChanges(parseReply(String(text || ''), known).changes, root)
        .filter((p) => wanted.has(p.path) && ['new', 'modified', 'delete'].includes(p.status));
      if (!planned.length) throw new TardisError('Nothing is ticked to apply.');
      const r = applyChanges(planned, root);
      return { done: r.done, backup: path.basename(r.backup) };
    },

    undo({ to }) { return undoLast(path.resolve(String(to || '.'))); },

    /** Live mode: has anything in the project changed since the last scan? */
    poll() { const dirty = S.dirty; S.dirty = false; return { dirty }; },

    /** The page is closing: exit shortly unless another request (a reload) arrives. */
    bye() { if (!o.stay) S.bye = setTimeout(() => process.exit(0), 2500); return {}; },
  };

  const server = http.createServer((req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(body); };
    const port = server.address().port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(403, 'text/plain', 'Forbidden');
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      let html;
      try { html = fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8'); }
      catch { return send(500, 'text/plain', 'ui.html is missing - it must sit next to tardis.js'); }
      const boot = { token, version: VERSION, initial: o.initial || '', defaults: optionsToDict(optionsFrom(o.defaults)),
        recent: state.recent || [], templates: { ...TEMPLATES, ...(state.templates || {}) }, builtin: Object.keys(TEMPLATES),
        home: os.homedir(), counter: TOKENS.name };
      return send(200, 'text/html; charset=utf-8', html.replace('__TARDIS_BOOT__', () => JSON.stringify(boot).replace(/</g, '\\u003c')));
    }
    const name = url.pathname.startsWith('/api/') ? url.pathname.slice(5) : '';
    if (req.method !== 'POST' || !Object.prototype.hasOwnProperty.call(api, name)) return send(404, 'text/plain', 'Not found');
    if ((req.headers['x-tardis-token'] || url.searchParams.get('t')) !== token) return send(403, 'text/plain', 'Forbidden');
    if (name !== 'bye' && S.bye) { clearTimeout(S.bye); S.bye = null; }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 256 * 1024 * 1024) req.destroy(); else chunks.push(c); });
    req.on('end', () => {
      let out;
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') : {};
        out = { ok: true, ...api[name](body) };
      } catch (e) {
        if (!(e instanceof TardisError)) say(e && e.stack ? e.stack : String(e));
        out = { ok: false, error: e instanceof TardisError ? e.message : `${e.name || 'Error'}: ${e.message}` };
      }
      send(200, 'application/json; charset=utf-8', JSON.stringify(out));
    });
  });
  server.listen(o.port || 0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    say(`\n  ${APP_NAME} v${VERSION} is materialising at ${url}`);
    say(o.stay ? '  Press Ctrl+C to stop.\n' : '  Close the browser tab (or press Ctrl+C) to stop.\n');
    if (o.open !== false) openBrowser(url, o.app);
  });
  return server;
}

// =====================================================================================
// 16. Command line
// =====================================================================================

const HELP = `${APP_NAME} ${VERSION} - ${APP_LONG}. "${TAGLINE}"

usage: tardis [PATH|URL] [options]      pack a project (no PATH: open the GUI)
       tardis apply [FILE|-] [--to DIR] [-y] [--dry-run] [--all]
       tardis undo [DIR]
       tardis menu install|remove
       tardis templates

pack options:
  -o, --output FILE      output file; '-' = stdout (default: <project>.tardis.md here)
  -c, --copy             copy to the clipboard (no file unless -o is given)
  -f, --format FMT       markdown (default) | xml | text
  -a, --hidden           include hidden files (dotfiles)
  -i, --include GLOB     only these paths (repeatable)
  -x, --exclude GLOB     drop these paths (repeatable)
      --omit GLOB        keep in the map, no contents (repeatable)
      --condense GLOB    include only a condensed view of these (repeatable)
  -n, --line-numbers     prefix content lines with their number
      --max-size KB      larger files are condensed or omitted (default 256)
      --include-locks    include lock and minified files
      --include-secrets  include .env, *.pem ... files
      --no-ignore        ignore .gitignore and the junk-folder list
      --no-redact        keep secret-looking values as they are
      --tree-only        structure map only
      --budget TOKENS    token ceiling, e.g. 100k or 1.5m
      --split            over budget? split into parts instead of trimming
      --since REF        only what changed since this branch/tag/commit
      --at REF           the project as it was at this branch/tag/commit
      --no-diff          with --since: leave the diff out
      --focus FILE       only this file/glob plus everything it imports (repeatable)
      --with-importers   with --focus: also the files that import it
      --task TEXT        instructions for the AI, placed after the snapshot
      --template NAME    a named task (see "tardis templates")
      --no-reply-format  leave out the how-to-reply instructions
      --profile NAME     load settings saved in ${PROFILE_FILE}
      --save-profile N   save these settings as a profile
      --tokenizer MODE   auto (default) | estimate | exact
  -q, --quiet            no summary

gui options:
      --gui              open the GUI even when a PATH is given
      --app              open in a chromeless Chrome/Edge window when available
      --port N           fixed port (default: a free one)
      --no-open          do not open a browser; just print the address
      --stay             keep running after the browser tab is closed
`;

const CLI_OPTIONS = {
  output: { type: 'string', short: 'o' }, copy: { type: 'boolean', short: 'c' }, format: { type: 'string', short: 'f' },
  hidden: { type: 'boolean', short: 'a' }, include: { type: 'string', short: 'i', multiple: true },
  exclude: { type: 'string', short: 'x', multiple: true }, omit: { type: 'string', multiple: true },
  condense: { type: 'string', multiple: true }, 'line-numbers': { type: 'boolean', short: 'n' },
  'max-size': { type: 'string' }, 'include-locks': { type: 'boolean' }, 'include-secrets': { type: 'boolean' },
  'no-ignore': { type: 'boolean' }, 'no-redact': { type: 'boolean' }, 'tree-only': { type: 'boolean' },
  budget: { type: 'string' }, split: { type: 'boolean' }, since: { type: 'string' }, at: { type: 'string' },
  'no-diff': { type: 'boolean' }, focus: { type: 'string', multiple: true }, 'with-importers': { type: 'boolean' },
  task: { type: 'string' }, template: { type: 'string' }, 'no-reply-format': { type: 'boolean' },
  profile: { type: 'string' }, 'save-profile': { type: 'string' }, tokenizer: { type: 'string' },
  gui: { type: 'boolean' }, app: { type: 'boolean' }, port: { type: 'string' }, 'no-open': { type: 'boolean' },
  stay: { type: 'boolean' }, quiet: { type: 'boolean', short: 'q' }, version: { type: 'boolean', short: 'V' },
  help: { type: 'boolean', short: 'h' }, to: { type: 'string' }, yes: { type: 'boolean', short: 'y' },
  'dry-run': { type: 'boolean' }, all: { type: 'boolean' },
};

/** Looks a task template up by name (case-insensitive; unique prefixes work too). */
function findTemplate(name) {
  const pool = { ...TEMPLATES, ...(loadState().templates || {}) };
  const low = name.toLowerCase();
  const exact = Object.keys(pool).find((k) => k.toLowerCase() === low);
  if (exact) return pool[exact];
  const hits = Object.keys(pool).filter((k) => k.toLowerCase().startsWith(low));
  if (hits.length === 1) return pool[hits[0]];
  throw new TardisError(`No task template called "${name}". Try: ${Object.keys(pool).join(', ')}`);
}

/** CLI flags (+ optional profile) -> options. @returns {{opts: object, selData: object|null}} */
function optionsFromArgs(v, root) {
  let opts = defaultOptions(root), selData = null;
  if (v.profile) {
    const prof = loadProfiles(root)[v.profile];
    if (!prof) throw new TardisError(`No profile named "${v.profile}" in ${path.join(root, PROFILE_FILE)}.`);
    opts = { ...mergeOptions(opts, prof.options || {}), root };
    selData = prof.selection || null;
  }
  if (v.format) {
    if (!FORMATS[v.format]) throw new TardisError(`Unknown format "${v.format}" (markdown, xml or text).`);
    opts.fmt = v.format;
  }
  if (v.hidden) opts.include_hidden = true;
  if (v['line-numbers']) opts.line_numbers = true;
  if (v['include-locks']) opts.include_locks = true;
  if (v['include-secrets']) opts.include_secrets = true;
  if (v['tree-only']) opts.tree_only = true;
  if (v['no-ignore']) opts.use_ignore = false;
  if (v['no-redact']) opts.redact = false;
  if (v['no-diff']) opts.include_diff = false;
  if (v['no-reply-format']) opts.reply_format = false;
  if (v.since) opts.since = v.since;
  if (v.at) opts.at = v.at;
  if (v.include) opts.include_globs = splitGlobs(v.include);
  if (v.exclude) opts.exclude_globs = splitGlobs(v.exclude);
  if (v.omit) opts.omit_globs = splitGlobs(v.omit);
  if (v.condense) opts.condense_globs = splitGlobs(v.condense);
  if (v['max-size']) opts.max_size_kb = Math.max(1, parseInt(v['max-size'], 10) || 256);
  if (v.budget !== undefined) opts.budget = parseTokens(v.budget);
  if (v.split) opts.over = 'split';
  if (v.task) opts.task = v.task;
  if (v.template) opts.task = findTemplate(v.template) + (v.task ? '\n\n' + v.task : '');
  return { opts, selData };
}

/** The friendly summary printed after packing from the terminal. */
function printSummary(scan, doc, dests) {
  const art = ['    _|_    ', '  _|___|_  ', ' | [] [] | ', ' | [] [] | ', ' | [] []o| ', ' |_______| '];
  const side = ['', `${APP_NAME} v${VERSION}`, APP_LONG, `"${TAGLINE}"`, '', ''];
  say();
  art.forEach((a, i) => say(`  ${a}  ${side[i]}`.trimEnd()));
  say();
  const g = scan.git;
  say(`  Project  : ${scan.name}` + (g.inside ? ` (git: ${g.branch || '?'} @ ${g.commit || 'no commits'})` : ''));
  if (scan.opts.at) say(`  Time     : as it was at ${scan.opts.at} (${scan.atSha.slice(0, 10)})`);
  if (scan.opts.since) say(`  Scope    : ${plural(Object.keys(scan.changes).length, 'file')} changed since ${scan.opts.since}, ${scan.deleted.length} deleted`);
  say(`  Included : ${plural(doc.filesFull, 'file')} in full` + (doc.filesCondensed ? `, ${fmt(doc.filesCondensed)} condensed` : '') + `, ${plural(doc.lines, 'line')}`);
  const shown = Object.entries(doc.omittedCounts).filter(([c]) => c !== 'unchanged').sort((a, b) => b[1] - a[1]);
  if (shown.length) say('  Map only : ' + shown.map(([c, n]) => `${fmt(n)} ${REASON_LABELS[c] || c}`).join(', '));
  if (scan.hiddenSkipped) say(`  Hidden   : ${plural(scan.hiddenSkipped, 'hidden item')} stayed behind the perception filter (use --hidden)`);
  let size = `~${fmt(doc.tokens)} tokens`;
  if (doc.budget) size += ` of a ${fmt(doc.budget)} budget` + (doc.parts.length > 1 ? ` per part -> ${doc.parts.length} parts` : '');
  else size += ` (${contextNote(doc.tokens)})`;
  say(`  Size     : ${size}   [${doc.counter}]`);
  if (doc.trimmed || doc.squeezed) {
    say(`  Budget   : ${fmt(doc.squeezed)} condensed and ${fmt(doc.trimmed)} left out to fit, lowest priority first:`);
    const cut = doc.items.filter((it) => it.auto);
    for (const it of cut.slice(0, 8)) say(`               ${it.mode !== 'off' ? 'condensed' : 'left out '}  ${it.e.rel}`);
    if (cut.length > 8) say(`               ...and ${cut.length - 8} more (tagged in the map)`);
  }
  if (doc.overBudget) say('  WARNING  : still over budget - raise it, exclude more, or use --split');
  if (doc.redacted) say(`  Redacted : ${plural(doc.redacted, 'secret-looking value')} (--no-redact to keep them)`);
  for (const dst of dests) say(`  Output   : ${dst}`);
  if (doc.secrets.length && !doc.redacted) {
    say(); say('  Spoilers! Possible secrets in the packed text:');
    for (const [rel, line, kind] of doc.secrets.slice(0, 10)) say(`    - ${rel}:${line}  (${kind})`);
  }
  say();
  say(doc.filesFull || doc.filesCondensed || scan.opts.tree_only ? '  Fantastic! Allons-y.' : '  Hmm. Nothing to pack - check the folder and the filters.');
  say();
}

/** Waits for Enter on stdin (used between parts when copying a split snapshot). */
function waitForEnter() {
  try { const buf = Buffer.alloc(256); fs.readSync(0, buf, 0, 256, null); return true; } catch { return false; }
}

/** `tardis PATH [options]` */
function cliPack(v, target) {
  let root, source = '';
  if (isRemote(target)) {
    say('  Vworp... fetching the repository.');
    const got = cloneRemote(target, Boolean(v.since || v.at));
    root = got.root; source = got.url;
  } else {
    root = path.resolve(target);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new TardisError(`Not a folder: ${root}`);
  }
  const { opts, selData } = optionsFromArgs(v, root);
  opts.source = source;
  if (v['save-profile']) {
    const profiles = loadProfiles(root);
    profiles[v['save-profile']] = { options: optionsToDict(opts), selection: {} };
    saveProfiles(root, profiles);
  }
  const ext = FORMAT_EXT[opts.fmt];
  const safe = path.basename(root).replace(/[^\w.-]+/g, '_').replace(/^[._]+|[._]+$/g, '') || 'project';
  const defaultOut = path.join(process.cwd(), `${safe}.tardis${ext}`);
  const toStdout = v.output === '-';
  let outPath = null;
  if (v.output && !toStdout) {
    outPath = path.resolve(v.output);
    if (fs.existsSync(outPath) && fs.statSync(outPath).isDirectory()) outPath = path.join(outPath, path.basename(defaultOut));
  } else if (!v.output && !v.copy) outPath = defaultOut;
  let skipRel = '';
  if (outPath) { const r = path.relative(fs.realpathSync(root), outPath); if (r && !r.startsWith('..')) skipRel = r.split(path.sep).join('/'); }
  const scan = scanProject(opts, { skipRel });
  let selection = selData ? expandSelection(selData, scan.entries) : {};
  if (v.focus) {
    const wanted = new GlobSet(v.focus);
    const starts = scan.entries.filter((e) => v.focus.includes(e.rel) || wanted.matches(e.rel)).map((e) => e.rel);
    if (!starts.length) throw new TardisError('--focus matched no files: ' + v.focus.join(', '));
    selection = focusSelection(scan, starts, Boolean(v['with-importers'])).selection;
  }
  const doc = buildDocument(scan, opts, selection);
  const dests = [];
  if (v.copy) {
    const n = doc.parts.length;
    let ok = true;
    for (let k = 0; k < n && ok; k++) {
      ok = copyToClipboard(doc.parts[k]);
      if (!ok || n === 1) break;
      if (k === n - 1) say(`  Part ${n} of ${n} is on the clipboard - that is the last one.`);
      else if (!process.stdin.isTTY) { say(`  Part 1 of ${n} is on the clipboard; use -o to get every part as a file.`); break; }
      else { say(`  Part ${k + 1} of ${n} is on the clipboard. Paste it, then press Enter for part ${k + 2}...`); if (!waitForEnter()) break; }
    }
    if (ok) dests.push('clipboard');
    else {
      say('Could not reach the clipboard (on Linux install xclip or wl-clipboard). Writing a file instead.');
      if (!outPath && !toStdout) outPath = defaultOut;
    }
  }
  if (outPath) partPaths(outPath, doc.parts.length).forEach((p, i) => { writeText(p, doc.parts[i]); dests.push(p); });
  if (toStdout) { process.stdout.write(doc.text); dests.push('stdout'); }
  if (!v.quiet) printSummary(scan, doc, dests);
  return 0;
}

const STATUS_LABELS = { new: 'New file', modified: 'Modified', delete: 'Delete', unchanged: 'No change', problem: "Can't apply" };

/** `tardis apply [FILE|-] [--to DIR] [-y] [--dry-run] [--all]` */
function cliApply(v, positionals) {
  const src = positionals[0];
  let text;
  if (src === '-') text = fs.readFileSync(0, 'utf8');
  else if (src) {
    if (!fs.existsSync(src)) throw new TardisError(`File not found: ${src}`);
    text = decode(fs.readFileSync(src));
  } else {
    text = readClipboard();
    if (!text.trim()) throw new TardisError('The clipboard is empty. Copy the AI reply first, or pass a file.');
  }
  const root = path.resolve(v.to || '.');
  const { changes, info } = parseReply(text, listFiles(root));
  const planned = evaluateChanges(changes, root);
  if (!planned.length) throw new TardisError('No file changes found in that text. TARDIS looks for "### FILE: path" followed by a code block.');
  say(); say(`  Changes found for ${root}:`); say();
  for (const p of planned) {
    say(`   ${p.ok ? ' ' : '!'} ${(STATUS_LABELS[p.status] || p.status).padEnd(11)} ${p.path}  ${p.added || p.removed ? `+${p.added} -${p.removed}` : ''}`);
    for (const note of p.notes) say(`       note: ${note}`);
  }
  if (info.skipped) say(`  (${info.skipped} code block(s) without a file name were ignored)`);
  if (info.unsupported.length) say('  (diff-style blocks are not supported - ask for complete files or EDIT blocks: ' + info.unsupported.slice(0, 5).join(', ') + ')');
  for (const prob of info.problems) say(`  problem: ${prob}`);
  say();
  const todo = planned.filter((p) => ['new', 'modified', 'delete'].includes(p.status) && (p.ok || v.all));
  if (v['dry-run'] || !todo.length) { say(todo.length ? '  Dry run - nothing written.' : '  Nothing to apply.'); return 0; }
  if (!v.yes) {
    if (src === '-' || !process.stdin.isTTY) throw new TardisError('Cannot ask for confirmation here - add --yes.');
    for (;;) {
      process.stderr.write(`  Apply ${plural(todo.length, 'change')}? [y]es / [n]o / [d]iff: `);
      const buf = Buffer.alloc(64);
      let ans = 'n';
      try { ans = buf.subarray(0, fs.readSync(0, buf, 0, 64, null)).toString('utf8').trim().toLowerCase(); } catch { /* EOF */ }
      if (ans.startsWith('d')) { for (const p of todo) process.stdout.write(diffLines(p).join('\n') + '\n'); continue; }
      if (!ans.startsWith('y')) { say('  Nothing written.'); return 1; }
      break;
    }
  }
  const r = applyChanges(todo, root);
  say(`  Fantastic! ${plural(r.done, 'change')} applied. Originals are in ${r.backup}  ("tardis undo" reverts).`);
  return 0;
}

/** Entry point. @returns {number|null} exit code, or null when the GUI server keeps running */
function main(argv = process.argv.slice(2)) {
  try {
    let parsed;
    try { parsed = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: true, strict: true }); }
    catch (e) { throw new TardisError(`${e.message}\nTry "tardis --help".`); }
    const v = parsed.values;
    const pos = parsed.positionals.slice();
    if (v.help) { process.stdout.write(HELP); return 0; }
    if (v.version) { process.stdout.write(`${APP_NAME} ${VERSION}\n`); return 0; }
    TOKENS.configure(v.tokenizer || 'auto');
    const cmd = pos[0];
    if (cmd === 'apply') return cliApply(v, pos.slice(1));
    if (cmd === 'undo') {
      const r = undoLast(pos[1] || '.');
      say(r.name ? `  Timey-wimey! Apply ${r.name} undone (${plural(r.n, 'file')} restored).` : '  Nothing to undo here.');
      return r.name ? 0 : 1;
    }
    if (cmd === 'menu') { say(installMenu(['remove', 'uninstall'].includes(pos[1]))); return 0; }
    if (cmd === 'templates') {
      for (const [name, text] of Object.entries({ ...TEMPLATES, ...(loadState().templates || {}) })) process.stdout.write(`${name}\n    ${text}\n\n`);
      return 0;
    }
    if (cmd === 'pack') pos.shift();
    const target = pos[0];
    if (v.gui || !target) {
      let defaults = {};
      try { defaults = optionsToDict(optionsFromArgs(v, target && !isRemote(target) ? path.resolve(target) : '.').opts); } catch { /* GUI starts with plain defaults */ }
      startServer({ port: v.port ? Number(v.port) : 0, open: !v['no-open'], app: v.app, stay: v.stay,
        initial: target ? (isRemote(target) ? target : path.resolve(target)) : '', defaults });
      return null;
    }
    return cliPack(v, target);
  } catch (e) {
    if (e instanceof TardisError) { say(`Error: ${e.message}`); return 2; }
    throw e;
  }
}

if (require.main === module) {
  const code = main();
  if (code !== null) process.exitCode = code;
}

/** Library surface (used by the tests, and available to your own scripts). */
module.exports = {
  VERSION, TardisError, TOKENS, TEMPLATES, SR_START, SR_MID, SR_END,
  parseTokens, formatTokens, humanSize, decode, countLines,
  parseIgnoreLines, rulesVerdict, GlobSet,
  findSecrets, redactText, restoreRedactions,
  outlinePython, outlineGeneric, condense, imageInfo,
  defaultOptions, mergeOptions, optionsToDict, Entry,
  isRemote, parseRemote, scanProject, listFiles,
  buildImportGraph, importClosure, focusSelection, priority,
  makePlan, buildDocument,
  parseReply, evaluateChanges, applyChanges, undoLast, lineDiff, unifiedDiff, diffLines,
  findElision, applyEdit, fixupRequest,
  compressSelection, expandSelection, loadProfiles, saveProfiles,
  startServer, main,
};
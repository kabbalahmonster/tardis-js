'use strict';
/**
 * Tests for TARDIS 3.   Run:  node --test
 * Uses only Node's built-in test runner. Git-dependent tests are skipped without git.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const T = require('./tardis.js');

T.TOKENS.configure('estimate');
const BT3 = '`'.repeat(3);
const KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';           // shaped like an AWS key id; not a real one
const made = [];
process.on('exit', () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** Creates a temp project from { 'relative/path': 'content' | Buffer }. */
function project(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tardis-test-')));
  made.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}
/** scan + build with ignore rules off by default (temp folders are not git repos). */
function pack(root, selection = {}, over = {}) {
  const opts = { ...T.defaultOptions(root), use_ignore: false, ...over };
  const scan = T.scanProject(opts);
  return { scan, doc: T.buildDocument(scan, opts, selection) };
}
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');

const FILES = {
  'README.md': '# Demo\n\nHello.\n',
  'src/app.py': 'from src import util\n\nprint(util.add(1, 2))\n',
  'src/util.py': 'def add(a, b):\n    return a + b\n',
  'tests/test_util.py': 'def test_add():\n' + '    assert True\n'.repeat(80),
  'logo.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]),
  '.env': 'SECRET=1\n',
  'package-lock.json': '{}\n',
};

test('gitignore rules', () => {
  const rules = T.parseIgnoreLines(['*.log', '!keep.log', '/dist', 'tmp/', 'a/**/z.txt']);
  const v = (rel, d = false) => T.rulesVerdict(rules, rel, d);
  assert.equal(v('x.log'), true);
  assert.equal(v('deep/er/x.log'), true);
  assert.equal(v('keep.log'), false);
  assert.equal(v('dist', true), true);
  assert.equal(v('src/dist', true), null);
  assert.equal(v('any/tmp', true), true);
  assert.equal(v('tmp', false), null);
  assert.equal(v('a/z.txt'), true);
  assert.equal(v('a/b/c/z.txt'), true);
  const g = new T.GlobSet(['tests/', '*.md']);
  assert.ok(g.matches('tests/a.py') && g.matches('docs/x.md') && !g.matches('src/tests.py'));
});

test('token amounts', () => {
  assert.equal(T.parseTokens('100k'), 100000);
  assert.equal(T.parseTokens('1.5m'), 1500000);
  assert.equal(T.parseTokens('No limit'), 0);
  assert.equal(T.formatTokens(64000), '64k');
  assert.throws(() => T.parseTokens('lots'), T.TardisError);
});

test('secrets: redact, restore, placeholders', () => {
  const original = `region = "eu"\naws_id = "${KEY}"\n`;
  const red = T.redactText(original);
  assert.ok(!red.text.includes(KEY));
  assert.ok(red.text.includes('[REDACTED:aws-key#1]'));
  assert.equal(red.findings[0][0], 2);
  const back = T.restoreRedactions(red.text.replace('"eu"', '"us"'), original);
  assert.deepEqual([back.restored, back.lost], [1, 0]);
  assert.ok(back.text.includes(KEY) && back.text.includes('"us"'));
  assert.deepEqual(T.findSecrets('password = "changeme123"\napi_key = "your-key-here-1"\n'), []);
  assert.deepEqual(T.findSecrets('db_password = "hunter2hunter2"\n').map((s) => s[2]), ['assigned-secret']);
});

test('python outline', () => {
  const src = 'import os\n\n\nclass Greeter:\n    """Says hello."""\n\n    def greet(self, name):\n        """Greets."""\n' +
    Array.from({ length: 30 }, (_, i) => `        x${i} = ${i}\n`).join('') + '        return name\n';
  const out = T.outlinePython(src);
  assert.ok(out.includes('import os'));
  assert.ok(out.includes('class Greeter:'));
  assert.ok(out.includes('def greet(self, name):'));
  assert.ok(out.includes('"""Greets."""'));
  assert.ok(!out.includes('x17 = 17'));
  assert.ok(out.includes('more line'));
});

test('generic outline', () => {
  const src = 'import fs from "fs";\n\nexport function load(path) {\n' + '  const a = 1;\n'.repeat(20) + '  return a;\n}\n\n' +
    'class Store {\n  save(item) {\n' + '    item.x = 1;\n'.repeat(20) + '  }\n}\n';
  const out = T.outlineGeneric(src);
  assert.ok(out.includes('export function load(path) {'));
  assert.ok(out.includes('class Store {'));
  assert.ok(out.includes('save(item) {'));
  assert.ok(!out.includes('item.x = 1;'));
});

test('rows, json sketch, notebook, image facts', () => {
  const csv = 'id,name\n' + Array.from({ length: 100 }, (_, i) => `${i},n${i}\n`).join('');
  let [body] = T.condense('data/x.csv', 'csv', csv);
  assert.ok(body.includes('id,name') && !body.includes('50,n50') && body.includes('more lines'));
  const json = JSON.stringify({ users: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'n'.repeat(30) })) });
  [body] = T.condense('x.json', 'json', json);
  assert.ok(body.includes('"users"') && body.includes('200 items'));
  const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Title'] },
    { cell_type: 'code', source: ['print(1)'], outputs: [{ data: 'x'.repeat(5000) }] }], metadata: {} });
  [body] = T.condense('n.ipynb', 'json', nb);
  assert.ok(body.includes('print(1)') && body.includes('# # Title') && !body.includes('xxxx'));
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  assert.equal(T.imageInfo(png), 'PNG image, 640x480');
});

test('scan defaults and document structure', () => {
  const { scan, doc } = pack(project(FILES));
  const by = Object.fromEntries(scan.entries.map((e) => [e.rel, e]));
  assert.ok(!('.env' in by));                                   // hidden by default
  assert.equal(by['logo.png'].skip, 'binary');
  assert.equal(by['package-lock.json'].skip, 'lock');
  assert.equal(scan.entries[0].rel, 'README.md');
  const text = doc.parts[0];
  assert.ok(text.includes('### FILE 1/4: `README.md`'));
  assert.ok(text.includes('logo.png  [omitted:'));
  assert.ok(text.includes('END OF SNAPSHOT'));
  assert.equal(doc.parts.length, 1);
});

test('round trip: snapshot -> empty folder', () => {
  const files = { ...FILES, 'docs/guide.md': `# Guide\n\n${BT3}python\nprint(1)\n${BT3}\n` };
  const { doc } = pack(project(files), {}, { line_numbers: true });
  const dest = project({});
  const { changes } = T.parseReply(doc.text);
  T.applyChanges(T.evaluateChanges(changes, dest), dest);
  for (const rel of ['README.md', 'src/app.py', 'src/util.py', 'docs/guide.md', 'tests/test_util.py']) {
    assert.equal(read(dest, rel), files[rel], rel);
  }
});

test('budget trims low-priority files first; pinned files survive', () => {
  const root = project(FILES);
  const full = pack(root, {}, { reply_format: false }).doc;
  const budget = full.tokens - 150;
  let doc = pack(root, {}, { reply_format: false, budget }).doc;
  assert.ok(doc.tokens <= budget);
  let modes = Object.fromEntries(doc.items.map((it) => [it.e.rel, it.mode]));
  assert.notEqual(modes['tests/test_util.py'], 'full');
  assert.equal(modes['README.md'], 'full');
  assert.equal(modes['src/app.py'], 'full');
  doc = pack(root, { 'tests/test_util.py': 'full' }, { reply_format: false, budget }).doc;
  modes = Object.fromEntries(doc.items.map((it) => [it.e.rel, it.mode]));
  assert.equal(modes['tests/test_util.py'], 'full');
});

test('split into parts and back', () => {
  const files = {};
  for (let i = 0; i < 8; i++) files[`src/m${i}.py`] = `# module ${i}\n` + `value = ${i}\n`.repeat(60);
  files['big.py'] = Array.from({ length: 900 }, (_, i) => `line_${i} = ${i}\n`).join('');
  const { doc } = pack(project(files), {}, { budget: 1500, over: 'split', reply_format: false });
  assert.ok(doc.parts.length > 2);
  assert.ok(doc.parts[1].includes('part 2 of'));
  assert.ok(doc.parts[0].includes('END OF PART 1 OF'));
  assert.ok(doc.parts[doc.parts.length - 1].includes('END OF SNAPSHOT'));
  const dest = project({});
  T.applyChanges(T.evaluateChanges(T.parseReply(doc.parts.join('\n')).changes, dest), dest);
  for (const [rel, content] of Object.entries(files)) assert.equal(read(dest, rel), content, rel);
});

test('formats, task placement, selection, condensed, redaction', () => {
  const root = project({ ...FILES, 'conf.py': `AWS = "${KEY}"\n` });
  let doc = pack(root, {}, { fmt: 'xml', task: 'Find the bug.' }).doc;
  assert.ok(doc.text.includes('<file index="1" path="README.md"'));
  assert.ok(doc.text.indexOf('END OF SNAPSHOT') < doc.text.indexOf('Find the bug.'));
  doc = pack(root, {}, { fmt: 'text', tree_only: true }).doc;
  assert.ok(doc.text.includes('DIRECTORY MAP') && !doc.text.includes('FILE 1/'));
  doc = pack(root, { 'src/util.py': 'off', 'tests/test_util.py': 'condensed' }).doc;
  assert.ok(doc.text.includes('util.py  [omitted: left out by user]'));
  assert.ok(doc.text.includes('(condensed): `tests/test_util.py`'));
  assert.ok(!doc.text.includes(KEY));
  assert.equal(doc.redacted, 1);
  doc = pack(root, {}, { redact: false }).doc;
  assert.ok(doc.text.includes(KEY));
  assert.equal(doc.secrets.length, 1);
});

const replyProject = () => project({ 'src/app.py': 'import os\n\n\ndef main():\n    print("hi")\n', 'old.txt': 'bye\n' });

test('reply: explicit blocks, apply and undo', () => {
  const root = replyProject();
  const reply = `Sure!\n\n### FILE: src/app.py\n${BT3}python\nimport os\n\n\ndef main():\n    print("hello")\n${BT3}\n\n` +
    `### FILE: src/new.py\n${BT3}python\nX = 1\n${BT3}\n\n### DELETE: old.txt\n\nRun it with:\n${BT3}bash\npython x\n${BT3}\n`;
  const { changes, info } = T.parseReply(reply, T.listFiles(root));
  assert.deepEqual(changes.map((c) => [c.path, c.kind]), [['src/app.py', 'write'], ['src/new.py', 'write'], ['old.txt', 'delete']]);
  assert.equal(info.skipped, 1);
  const planned = T.evaluateChanges(changes, root);
  assert.deepEqual(planned.map((p) => p.status), ['modified', 'new', 'delete']);
  assert.ok(planned.every((p) => p.ok));
  assert.deepEqual([planned[0].added, planned[0].removed], [1, 1]);
  assert.equal(T.applyChanges(planned, root).done, 3);
  assert.ok(read(root, 'src/app.py').includes('hello'));
  assert.ok(!fs.existsSync(path.join(root, 'old.txt')));
  assert.ok(fs.existsSync(path.join(root, '.tardis', '.gitignore')));
  T.undoLast(root);
  assert.ok(read(root, 'src/app.py').includes('"hi"'));
  assert.ok(fs.existsSync(path.join(root, 'old.txt')));
  assert.ok(!fs.existsSync(path.join(root, 'src', 'new.py')));
});

test('reply: informal styles', () => {
  const root = replyProject();
  const known = T.listFiles(root);
  for (const label of ['**src/app.py**', '#### `src/app.py`', "Here's the updated `src/app.py`:", 'src/app.py:']) {
    const { changes } = T.parseReply(`${label}\n\n${BT3}python\nA = 1\n${BT3}\n`, known);
    assert.deepEqual(changes.map((c) => c.path), ['src/app.py'], label);
  }
  assert.equal(T.parseReply(`${BT3}python:src/app.py\nA = 1\n${BT3}\n`, known).changes[0].path, 'src/app.py');
  const { changes } = T.parseReply(`${BT3}python\n# src/app.py\nA = 1\n${BT3}\n`, known);
  assert.equal(changes[0].path, 'src/app.py');
  assert.equal(T.evaluateChanges(changes, root)[0].new, 'A = 1\n');       // label comment removed
  const guessed = T.evaluateChanges(T.parseReply(`**lib/extra.py**\n${BT3}python\nA = 1\n${BT3}\n`).changes, root);
  assert.equal(guessed[0].status, 'new');
  assert.equal(guessed[0].ok, false);                                      // guessed name: unticked
});

test('reply: edit blocks, elision, unsafe paths, project-name prefix, fix-up', () => {
  const root = replyProject();
  const edit = `### EDIT: src/app.py\n${BT3}\n${T.SR_START}\n    print("hi")\n${T.SR_MID}\n    print("yo")\n${T.SR_END}\n${BT3}\n`;
  let planned = T.evaluateChanges(T.parseReply(edit).changes, root);
  assert.equal(planned[0].status, 'modified');
  assert.ok(planned[0].new.includes('print("yo")') && planned[0].new.includes('import os'));
  const bad = T.parseReply(edit.replace('print("hi")', 'print("nope")'));
  planned = T.evaluateChanges(bad.changes, root);
  assert.equal(planned[0].status, 'problem');
  assert.ok(T.fixupRequest(planned, bad.info).includes('src/app.py'));
  const short = `### FILE: src/app.py\n${BT3}python\nimport os\n\n# ... rest of the file unchanged ...\n${BT3}\n`;
  planned = T.evaluateChanges(T.parseReply(short).changes, root);
  assert.equal(planned[0].ok, false);
  assert.ok(planned[0].notes.some((n) => n.includes('abbreviated')));
  planned = T.evaluateChanges(T.parseReply(`### FILE: ../evil.py\n${BT3}\nx\n${BT3}\n`).changes, root);
  assert.equal(planned[0].status, 'problem');
  planned = T.evaluateChanges(T.parseReply(`### FILE: ${path.basename(root)}/src/app.py\n${BT3}\nA = 1\n${BT3}\n`).changes, root);
  assert.equal(planned[0].path, 'src/app.py');
});

test('diff', () => {
  const a = ['one', 'two', 'three', 'four'], b = ['one', '2', 'three', 'four', 'five'];
  const seq = T.lineDiff(a, b).map((e) => e.t + e.s);
  assert.deepEqual(seq, [' one', '-two', '+2', ' three', ' four', '+five']);
  const u = T.unifiedDiff(a, b);
  assert.equal(u[0], '@@ -1,4 +1,5 @@');
  assert.deepEqual(T.unifiedDiff(a, a), []);
});

test('import graph, focus, priority', () => {
  const root = project({
    'pkg/__init__.py': '', 'pkg/main.py': 'from pkg import helpers\nfrom .models import User\n',
    'pkg/helpers.py': 'import pkg.models\n', 'pkg/models.py': 'class User: pass\n', 'pkg/unused.py': 'x = 1\n',
    'web/app.js': "import { a } from './lib/a';\nconst b = require('./b.js');\n",
    'web/lib/a.ts': 'export const a = 1;\n', 'web/b.js': 'module.exports = 2;\n',
  });
  const { scan } = pack(root);
  const graph = scan.importGraph();
  assert.ok(graph.get('pkg/main.py').has('pkg/helpers.py'));
  assert.ok(graph.get('pkg/main.py').has('pkg/models.py'));
  assert.deepEqual([...graph.get('web/app.js')].sort(), ['web/b.js', 'web/lib/a.ts']);
  const f = T.focusSelection(scan, ['pkg/main.py']);
  assert.ok(f.keep.has('pkg/models.py'));
  assert.equal(f.selection['pkg/unused.py'], 'off');
  assert.ok(!('pkg/helpers.py' in f.selection));
  const mk = (rel, lang) => Object.assign(new T.Entry(rel, rel, '.'), { lang });
  const p = [['README.md', 'markdown'], ['src/main.py', 'python'], ['src/deep/er/thing.py', 'python'],
    ['tests/test_x.py', 'python'], ['tests/fixtures/data.json', 'json']].map(([r, l]) => T.priority(mk(r, l)));
  assert.ok(p[0] > p[1] && p[1] > p[2] && p[2] > p[3] && p[3] > p[4]);
});

test('profiles and selection compression', () => {
  const root = project({ 'a/x.py': '1\n', 'a/y.py': '2\n', 'b/z.py': '3\n' });
  const { scan } = pack(root);
  const sel = { 'a/x.py': 'off', 'a/y.py': 'off', 'b/z.py': 'condensed' };
  const data = T.compressSelection(sel, scan.entries);
  assert.deepEqual(data.off, ['a/']);
  assert.deepEqual(T.expandSelection(data, scan.entries), sel);
  const opts = { ...T.defaultOptions(root), budget: 5000, exclude_globs: ['x/'] };
  T.saveProfiles(root, { lean: { options: T.optionsToDict(opts) } });
  const back = T.mergeOptions(T.defaultOptions(root), T.loadProfiles(root).lean.options);
  assert.deepEqual([back.budget, back.exclude_globs], [5000, ['x/']]);
});

test('remote addresses', () => {
  assert.ok(T.isRemote('github.com/user/repo'));
  assert.ok(!T.isRemote('my/local/folder'));
  assert.deepEqual(T.parseRemote('https://github.com/user/repo/tree/dev/src/lib'),
    { url: 'https://github.com/user/repo', branch: 'dev', sub: 'src/lib', name: 'repo' });
  assert.equal(T.parseRemote('gh:user/repo.git').name, 'repo');
});

const HAS_GIT = !spawnSync('git', ['--version']).error;
function repo() {
  const root = project({ 'a.py': 'A = 1\n', 'b.py': 'B = 1\n', 'sub/c.py': 'C = 1\n', '.gitignore': 'ignored.txt\n', 'ignored.txt': 'x\n' });
  const git = (...args) => {
    const r = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args]);
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'first'); git('tag', 'v1');
  fs.writeFileSync(path.join(root, 'a.py'), 'A = 2\n');
  fs.writeFileSync(path.join(root, 'new.py'), 'N = 1\n');
  git('rm', '-q', 'b.py');
  return root;
}

test('git: .gitignore via git, --since, --at, bad ref', { skip: !HAS_GIT }, () => {
  const root = repo();
  let { scan, doc } = pack(root, {}, { use_ignore: true });
  assert.equal(scan.method, 'git');
  assert.ok(!scan.entries.some((e) => e.rel === 'ignored.txt'));

  ({ scan, doc } = pack(root, {}, { use_ignore: true, since: 'v1' }));
  assert.equal(scan.changes['a.py'], 'modified');
  assert.equal(scan.changes['new.py'], 'added');
  assert.ok(scan.deleted.includes('b.py'));
  const modes = Object.fromEntries(doc.items.map((it) => [it.e.rel, it.mode]));
  assert.equal(modes['a.py'], 'full');
  assert.equal(modes['sub/c.py'], 'off');
  assert.ok(doc.text.includes('- deleted: b.py'));
  assert.ok(doc.text.includes('+A = 2'));
  assert.ok(doc.text.includes('sub/  (1 unchanged file)'));

  ({ scan, doc } = pack(root, {}, { use_ignore: true, at: 'v1' }));
  const rels = scan.entries.map((e) => e.rel);
  assert.ok(rels.includes('b.py') && !rels.includes('new.py'));   // as it was back then
  assert.ok(doc.text.includes('A = 1') && !doc.text.includes('A = 2'));

  assert.throws(() => pack(root, {}, { use_ignore: true, since: 'no-such-branch' }), T.TardisError);
});
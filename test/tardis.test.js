'use strict';
/** Run: npm test   (node --test test/) */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../lib/core');
const A = require('../lib/apply');
const St = require('../lib/state');

const BT3 = '`'.repeat(3);
T.TOKENS.configure('estimate');
const tmpDirs = [];
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tardis-test-'));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return root;
}
process.on('exit', () => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
async function pack(root, selection = {}, extra = {}) {
  const opts = { ...T.defaultOptions(root), use_ignore: false, ...extra };
  const scan = await T.scanProject(opts);
  return { scan, doc: await T.buildDocument(scan, opts, selection) };
}
const FILES = {
  'README.md': '# Demo\n\nHello.\n',
  'src/app.py': 'from src import util\n\nprint(util.add(1, 2))\n',
  'src/util.py': 'def add(a, b):\n    return a + b\n',
  'tests/test_util.py': 'def test_add():\n' + '    assert True\n'.repeat(80),
  'logo.png': Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]),
  '.env': 'SECRET=1\n',
  'package-lock.json': '{}\n',
};
const KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';

test('gitignore rules', () => {
  const rules = T.parseIgnoreLines(['*.log', '!keep.log', '/dist', 'tmp/', 'a/**/z.txt']);
  const v = (rel, d = false) => T.rulesVerdict(rules, rel, d);
  assert.equal(v('x.log'), true); assert.equal(v('deep/er/x.log'), true); assert.equal(v('keep.log'), false);
  assert.equal(v('dist', true), true); assert.equal(v('src/dist', true), null);
  assert.equal(v('any/tmp', true), true); assert.equal(v('tmp', false), null);
  assert.equal(v('a/z.txt'), true); assert.equal(v('a/b/c/z.txt'), true);
  const g = new T.GlobSet(['tests/', '*.md']);
  assert.ok(g.matches('tests/a.py') && g.matches('docs/x.md') && !g.matches('src/tests.py'));
});
test('token parsing', () => {
  assert.equal(T.parseTokens('100k'), 100000); assert.equal(T.parseTokens('1.5m'), 1500000);
  assert.equal(T.parseTokens('No limit'), 0); assert.equal(T.formatTokens(64000), '64k');
  assert.throws(() => T.parseTokens('lots'), T.TardisError);
});
test('redact and restore', () => {
  const original = `region = "eu"\naws_id = "${KEY}"\n`;
  const { text, findings } = T.redactText(original);
  assert.ok(!text.includes(KEY) && text.includes('[REDACTED:aws-key#1]'));
  assert.equal(findings[0].line, 2);
  const back = T.restoreRedactions(text.replace('"eu"', '"us"'), original);
  assert.equal(back.restored, 1); assert.equal(back.unresolved, 0);
  assert.ok(back.text.includes(KEY) && back.text.includes('"us"'));
  assert.deepEqual(T.findSecrets('password = "changeme123"\napi_key = "your-key-here-1"\n'), []);
  assert.deepEqual(T.findSecrets('db_password = "hunter2hunter2"\n').map((s) => s.kind), ['assigned-secret']);
});
test('python outline', () => {
  const src = 'import os\n\n\nclass Greeter:\n    """Says hello."""\n\n    def greet(self, name):\n        """Greets."""\n'
    + Array.from({ length: 30 }, (_, i) => `        x${i} = ${i}\n`).join('') + '        return name\n';
  const out = T.outlinePython(src);
  assert.ok(out.includes('class Greeter:') && out.includes('def greet(self, name):') && out.includes('"""Greets."""'));
  assert.ok(!out.includes('x17 = 17') && out.includes('more line'));
});
test('generic outline', () => {
  const src = 'import fs from "fs";\n\nexport function load(path) {\n' + '  const a = 1;\n'.repeat(20) + '  return a;\n}\n\nclass Store {\n  save(item) {\n' + '    item.x = 1;\n'.repeat(20) + '  }\n}\n';
  const out = T.outlineGeneric(src);
  assert.ok(out.includes('export function load(path) {') && out.includes('class Store {') && out.includes('save(item) {') && !out.includes('item.x = 1;'));
});
test('rows, json, notebook, image', () => {
  const csv = 'id,name\n' + Array.from({ length: 100 }, (_, i) => `${i},n${i}\n`).join('');
  let [body] = T.condense('data/x.csv', 'csv', csv);
  assert.ok(body.includes('id,name') && !body.includes('50,n50') && body.includes('more lines'));
  [body] = T.condense('x.json', 'json', JSON.stringify({ users: Array.from({ length: 200 }, (_, i) => ({ id: i, name: 'n'.repeat(30) })) }));
  assert.ok(body.includes('"users"') && body.includes('200 items'));
  const nb = JSON.stringify({ cells: [{ cell_type: 'markdown', source: ['# Title'] }, { cell_type: 'code', source: ['print(1)'], outputs: [{ data: 'x'.repeat(5000) }] }], metadata: {} });
  [body] = T.condense('n.ipynb', 'json', nb);
  assert.ok(body.includes('print(1)') && body.includes('# # Title') && !body.includes('xxxx'));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.from([0, 0, 2, 0x80, 0, 0, 1, 0xe0])]);
  assert.equal(T.imageInfo(png), 'PNG image, 640x480');
});
test('scan defaults and document', async () => {
  const root = project(FILES);
  const { scan, doc } = await pack(root);
  const by = Object.fromEntries(scan.entries.map((e) => [e.rel, e]));
  assert.ok(!('.env' in by)); assert.equal(by['logo.png'].skip, 'binary'); assert.equal(by['package-lock.json'].skip, 'lock');
  assert.equal(scan.entries[0].rel, 'README.md');
  const text = doc.parts[0];
  assert.ok(text.includes('### FILE 1/4: `README.md`') && text.includes('logo.png  [omitted:') && text.includes('END OF SNAPSHOT'));
  assert.equal(doc.parts.length, 1);
});
test('round trip through parse + apply', async () => {
  const files = { ...FILES, 'docs/guide.md': `# Guide\n\n${BT3}python\nprint(1)\n${BT3}\n` };
  const root = project(files);
  const { doc } = await pack(root, {}, { line_numbers: true });
  const dest = project({});
  const { changes } = A.parseReply(doc.text);
  await A.applyChanges(await A.evaluateChanges(changes, dest), dest);
  for (const rel of ['README.md', 'src/app.py', 'src/util.py', 'docs/guide.md']) assert.equal(fs.readFileSync(path.join(dest, rel), 'utf8'), files[rel], rel);
});
test('budget trims low priority first; pinned survive', async () => {
  const root = project(FILES);
  const { doc: full } = await pack(root, {}, { reply_format: false });
  const budget = full.tokens - 150;
  const { doc } = await pack(root, {}, { reply_format: false, budget });
  assert.ok(doc.tokens <= budget);
  const modes = Object.fromEntries(doc.items.map((it) => [it.e.rel, it.mode]));
  assert.notEqual(modes['tests/test_util.py'], 'full'); assert.equal(modes['README.md'], 'full'); assert.equal(modes['src/app.py'], 'full');
  const { doc: pinned } = await pack(root, { 'tests/test_util.py': 'full' }, { reply_format: false, budget });
  assert.equal(Object.fromEntries(pinned.items.map((it) => [it.e.rel, it.mode]))['tests/test_util.py'], 'full');
});
test('split into parts and back', async () => {
  const files = {};
  for (let i = 0; i < 8; i++) files[`src/m${i}.py`] = `# module ${i}\n` + `value = ${i}\n`.repeat(60);
  files['big.py'] = Array.from({ length: 900 }, (_, i) => `line_${i} = ${i}\n`).join('');
  const root = project(files);
  const { doc } = await pack(root, {}, { budget: 1500, over: 'split', reply_format: false });
  assert.ok(doc.parts.length > 2 && doc.parts[1].includes('part 2 of') && doc.parts[0].includes('END OF PART 1 OF') && doc.parts[doc.parts.length - 1].includes('END OF SNAPSHOT'));
  const dest = project({});
  const { changes } = A.parseReply(doc.parts.join('\n'));
  await A.applyChanges(await A.evaluateChanges(changes, dest), dest);
  for (const [rel, content] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(dest, rel), 'utf8'), content, rel);
});
test('formats, task, selection, redaction in document', async () => {
  const root = project({ ...FILES, 'conf.py': `AWS = "${KEY}"\n` });
  let { doc } = await pack(root, {}, { fmt: 'xml', task: 'Find the bug.' });
  assert.ok(doc.text.includes('<file index="1" path="README.md"') && doc.text.indexOf('END OF SNAPSHOT') < doc.text.indexOf('Find the bug.'));
  ({ doc } = await pack(root, {}, { fmt: 'text', tree_only: true }));
  assert.ok(doc.text.includes('DIRECTORY MAP') && !doc.text.includes('FILE 1/'));
  ({ doc } = await pack(root, { 'src/util.py': 'off', 'tests/test_util.py': 'condensed' }));
  assert.ok(doc.text.includes('util.py  [omitted: left out by user]') && doc.text.includes('(condensed): `tests/test_util.py`'));
  assert.ok(!doc.text.includes(KEY) && doc.redacted === 1);
  ({ doc } = await pack(root, {}, { redact: false }));
  assert.ok(doc.text.includes(KEY) && doc.secrets.length === 1);
});
test('explicit FILE / DELETE blocks, apply and undo', async () => {
  const root = project({ 'src/app.py': 'import os\n\n\ndef main():\n    print("hi")\n', 'old.txt': 'bye\n' });
  const reply = `Sure!\n\n### FILE: src/app.py\n${BT3}python\nimport os\n\n\ndef main():\n    print("hello")\n${BT3}\n\n### FILE: src/new.py\n${BT3}python\nX = 1\n${BT3}\n\n### DELETE: old.txt\n\nRun it with:\n${BT3}bash\npython x\n${BT3}\n`;
  const { changes, info } = A.parseReply(reply, await T.listFiles(root));
  assert.deepEqual(changes.map((c) => [c.path, c.kind]), [['src/app.py', 'write'], ['src/new.py', 'write'], ['old.txt', 'delete']]);
  assert.equal(info.skipped, 1);
  const planned = await A.evaluateChanges(changes, root);
  assert.deepEqual(planned.map((p) => p.status), ['modified', 'new', 'delete']);
  assert.ok(planned.every((p) => p.ok));
  const { done } = await A.applyChanges(planned, root);
  assert.equal(done, 3);
  assert.ok(fs.readFileSync(path.join(root, 'src/app.py'), 'utf8').includes('hello') && !fs.existsSync(path.join(root, 'old.txt')));
  assert.ok(fs.existsSync(path.join(root, '.tardis/.gitignore')));
  await A.undoLast(root);
  assert.ok(fs.readFileSync(path.join(root, 'src/app.py'), 'utf8').includes('"hi"') && fs.existsSync(path.join(root, 'old.txt')) && !fs.existsSync(path.join(root, 'src/new.py')));
});
test('informal labels, guessed files, EDIT, elision, unsafe paths', async () => {
  const root = project({ 'src/app.py': 'import os\n\n\ndef main():\n    print("hi")\n' });
  const known = await T.listFiles(root);
  for (const label of ['**src/app.py**', '#### `src/app.py`', "Here's the updated `src/app.py`:", 'src/app.py:']) {
    const { changes } = A.parseReply(`${label}\n\n${BT3}python\nA = 1\n${BT3}\n`, known);
    assert.deepEqual(changes.map((c) => c.path), ['src/app.py'], label);
  }
  assert.equal(A.parseReply(`${BT3}python:src/app.py\nA = 1\n${BT3}\n`, known).changes[0].path, 'src/app.py');
  const first = A.parseReply(`${BT3}python\n# src/app.py\nA = 1\n${BT3}\n`, known).changes;
  assert.equal((await A.evaluateChanges(first, root))[0].new, 'A = 1\n');
  const guessed = await A.evaluateChanges(A.parseReply(`**lib/extra.py**\n${BT3}python\nA = 1\n${BT3}\n`).changes, root);
  assert.equal(guessed[0].status, 'new'); assert.equal(guessed[0].ok, false);
  const edit = `### EDIT: src/app.py\n${BT3}\n${T.SR_START}\n    print("hi")\n${T.SR_MID}\n    print("yo")\n${T.SR_END}\n${BT3}\n`;
  let planned = await A.evaluateChanges(A.parseReply(edit).changes, root);
  assert.equal(planned[0].status, 'modified'); assert.ok(planned[0].new.includes('print("yo")') && planned[0].new.includes('import os'));
  planned = await A.evaluateChanges(A.parseReply(edit.replace('print("hi")', 'print("nope")')).changes, root);
  assert.equal(planned[0].status, 'problem');
  planned = await A.evaluateChanges(A.parseReply(`### FILE: src/app.py\n${BT3}python\nimport os\n\n# ... rest of the file unchanged ...\n${BT3}\n`).changes, root);
  assert.equal(planned[0].ok, false); assert.ok(planned[0].notes.some((n) => n.includes('abbreviated')));
  planned = await A.evaluateChanges(A.parseReply(`### FILE: ../evil.py\n${BT3}\nx\n${BT3}\n`).changes, root);
  assert.equal(planned[0].status, 'problem');
  planned = await A.evaluateChanges(A.parseReply(`### FILE: ${path.basename(root)}/src/app.py\n${BT3}\nA = 1\n${BT3}\n`).changes, root);
  assert.equal(planned[0].path, 'src/app.py');
});
test('diff', () => {
  const ops = A.diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
  assert.deepEqual(ops.map((o) => o.t + o.s), ['=a', '-b', '+x', '=c', '=d', '+e']);
  const u = A.unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.txt');
  assert.ok(u.includes('-b') && u.includes('+B'));
});
test('import graph, focus, priority, selection compression, remote parsing', async () => {
  const root = project({
    'pkg/__init__.py': '', 'pkg/main.py': 'from pkg import helpers\nfrom .models import User\n', 'pkg/helpers.py': 'import pkg.models\n',
    'pkg/models.py': 'class User: pass\n', 'pkg/unused.py': 'x = 1\n',
    'web/app.js': "import { a } from './lib/a';\nconst b = require('./b.js');\n", 'web/lib/a.ts': 'export const a = 1;\n', 'web/b.js': 'module.exports = 2;\n',
  });
  const { scan } = await pack(root);
  const graph = scan.importGraph();
  assert.ok(graph['pkg/main.py'].has('pkg/helpers.py') && graph['pkg/main.py'].has('pkg/models.py'));
  assert.deepEqual([...graph['web/app.js']].sort(), ['web/b.js', 'web/lib/a.ts']);
  const { sel, keep } = T.focusSelection(scan, ['pkg/main.py']);
  assert.ok(keep.has('pkg/models.py') && sel['pkg/unused.py'] === 'off' && !('pkg/helpers.py' in sel));
  const mk = (rel, lang) => { const e = new T.Entry(rel, rel); e.lang = lang; return e; };
  const [r, m, o, t, f] = [T.priority(mk('README.md', 'markdown')), T.priority(mk('src/main.py', 'python')), T.priority(mk('src/deep/er/thing.py', 'python')), T.priority(mk('tests/test_x.py', 'python')), T.priority(mk('tests/fixtures/data.json', 'json'))];
  assert.ok(r > m && m > o && o > t && t > f);
  const root2 = project({ 'a/x.py': '1\n', 'a/y.py': '2\n', 'b/z.py': '3\n' });
  const { scan: s2 } = await pack(root2);
  const selection = { 'a/x.py': 'off', 'a/y.py': 'off', 'b/z.py': 'condensed' };
  const data = St.compressSelection(selection, s2.entries);
  assert.deepEqual(data.off, ['a/']); assert.deepEqual(St.expandSelection(data, s2.entries), selection);
  assert.ok(T.isRemote('github.com/user/repo') && !T.isRemote('my/local/folder'));
  assert.deepEqual(T.parseRemote('https://github.com/user/repo/tree/dev/src/lib'), { url: 'https://github.com/user/repo', branch: 'dev', sub: 'src/lib', name: 'repo' });
});

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('git time travel', { skip: !hasGit }, async () => {
  const root = project({ 'a.py': 'A = 1\n', 'b.py': 'B = 1\n', 'sub/c.py': 'C = 1\n', '.gitignore': 'ignored.txt\n', 'ignored.txt': 'x\n' });
  const g = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  g('init', '-q'); g('add', '-A'); g('commit', '-q', '-m', 'first'); g('tag', 'v1');
  fs.writeFileSync(path.join(root, 'a.py'), 'A = 2\n'); fs.writeFileSync(path.join(root, 'new.py'), 'N = 1\n'); g('rm', '-q', 'b.py');
  let { scan, doc } = await pack(root, {}, { use_ignore: true });
  assert.ok(!scan.entries.some((e) => e.rel === 'ignored.txt') && scan.method === 'git');
  ({ scan, doc } = await pack(root, {}, { use_ignore: true, since: 'v1' }));
  assert.equal(scan.changes['a.py'], 'modified'); assert.equal(scan.changes['new.py'], 'added'); assert.ok(scan.deleted.includes('b.py'));
  const modes = Object.fromEntries(doc.items.map((it) => [it.e.rel, it.mode]));
  assert.equal(modes['a.py'], 'full'); assert.equal(modes['sub/c.py'], 'off');
  assert.ok(doc.text.includes('- deleted: b.py') && doc.text.includes('+A = 2') && doc.text.includes('sub/  (1 unchanged file)'));
  ({ scan, doc } = await pack(root, {}, { use_ignore: true, at: 'v1' }));
  const rels = new Set(scan.entries.map((e) => e.rel));
  assert.ok(rels.has('b.py') && !rels.has('new.py') && doc.text.includes('A = 1') && !doc.text.includes('A = 2'));
  await assert.rejects(() => pack(root, {}, { use_ignore: true, since: 'no-such-branch' }), T.TardisError);
});
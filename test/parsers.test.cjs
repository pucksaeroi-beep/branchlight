const test = require('node:test');
const assert = require('node:assert');
const G = require('../electron/git.cjs');

test('parseStatus reads branch, staged, unstaged, renames, conflicts, untracked', () => {
  const out = [
    '# branch.oid 1234567890123456789012345678901234567890', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb README.md',
    '1 .M N... 100644 100644 100644 aaa bbb src/a b.js',
    '2 R. N... 100644 100644 100644 aaa bbb R100 new.js', 'old.js',
    'u UU N... 100644 100644 100644 100644 a b c conflict.txt',
    '? notes.txt', ''].join('\0');
  const st = G.parseStatus(out);
  assert.equal(st.branch, 'main');
  assert.equal(st.upstream, 'origin/main');
  assert.deepEqual([st.ahead, st.behind], [2, 1]);
  assert.deepEqual(st.staged.map((f) => [f.path, f.status, f.from]), [['README.md', 'modified', undefined], ['new.js', 'renamed', 'old.js']]);
  assert.deepEqual(st.unstaged.map((f) => [f.path, f.status]), [['src/a b.js', 'modified'], ['notes.txt', 'untracked']]);
  assert.equal(st.conflicts[0].path, 'conflict.txt');
});

test('parseDecorations', () => {
  assert.deepEqual(G.parseDecorations('HEAD -> main, origin/main, origin/HEAD, tag: v1.0'),
    [{ type: 'head' }, { type: 'branch', name: 'main' }, { type: 'branch', name: 'origin/main' }, { type: 'tag', name: 'v1.0' }]);
});

test('parseRefs splits local / remote / tags with tracking info', () => {
  const US = '\x1f';
  const out = [
    ['refs/heads/main', 'a1', 'origin/main', 'ahead 3, behind 2', '*', '', '1700000000', 'msg'].join(US),
    ['refs/heads/old', 'a2', 'origin/old', 'gone', ' ', '', '1700000000', 'x'].join(US),
    ['refs/remotes/origin/HEAD', 'a1', '', '', ' ', '', '1', ''].join(US),
    ['refs/remotes/origin/main', 'a3', '', '', ' ', '', '1', ''].join(US),
    ['refs/tags/v1', 't1', '', '', ' ', 'c1', '1', ''].join(US)].join('\n');
  const r = G.parseRefs(out);
  assert.deepEqual(r.local.map((b) => [b.name, b.ahead, b.behind, b.current, b.gone]), [['main', 3, 2, true, false], ['old', 0, 0, false, true]]);
  assert.deepEqual(r.remote.map((b) => [b.remote, b.branch]), [['origin', 'main']]);
  assert.equal(r.tags[0].sha, 'c1', 'annotated tags point at the peeled commit');
});

test('parseDiff tracks line numbers and no-newline markers', () => {
  const d = G.parseDiff([
    'diff --git a/x.txt b/x.txt', 'index 1..2 100644', '--- a/x.txt', '+++ b/x.txt',
    '@@ -1,3 +1,3 @@ fn()', ' a', '-b', '+B', ' c', '@@ -10 +10,2 @@', '-z', '\\ No newline at end of file', '+z', '+y', ''].join('\n'))[0];
  assert.equal(d.newPath, 'x.txt');
  assert.equal(d.hunks.length, 2);
  assert.equal(d.hunks[0].context, 'fn()');
  assert.deepEqual(d.hunks[0].lines.map((l) => [l.t, l.o, l.n]), [[' ', 1, 1], ['-', 2, undefined], ['+', undefined, 2], [' ', 3, 3]]);
  assert.equal(d.hunks[1].oldLines, 1);
  assert.equal(d.hunks[1].lines[1].t, '\\');
});

test('parseNameStatus + parseNumstat handle renames', () => {
  const ns = G.parseNameStatus(['M', 'a.js', 'R095', 'old.js', 'new.js', 'A', 'b.js', ''].join('\0'));
  assert.deepEqual(ns.map((f) => [f.status, f.path, f.from]), [['modified', 'a.js', undefined], ['renamed', 'new.js', 'old.js'], ['added', 'b.js', undefined]]);
  const num = G.parseNumstat(['3\t1\ta.js', '1\t1\t', 'old.js', 'new.js', '-\t-\timg.png', ''].join('\0'));
  assert.deepEqual(num.get('a.js'), { add: 3, del: 1, binary: false });
  assert.deepEqual(num.get('new.js'), { add: 1, del: 1, binary: false });
  assert.equal(num.get('img.png').binary, true);
});

test('parseLog', () => {
  const US = '\x1f', RS = '\x1e';
  const sha = 'a'.repeat(40), p = 'b'.repeat(40);
  const c = G.parseLog([sha, p, 'Mia', 'MIA@X', '1700000000', 'Mia', '1700000000', 'Hello', 'HEAD -> main'].join(US) + RS + '\n');
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].parents, [p]);
  assert.equal(c[0].email, 'mia@x');
  assert.equal(c[0].date, 1700000000000);
});

test('safeRef refuses option-like input', () => {
  assert.throws(() => G.safeRef('--upload-pack=evil'));
  assert.throws(() => G.safeRef(''));
  assert.equal(G.safeRef('feature/x'), 'feature/x');
});

// Applies generated patches with real git to make sure partial staging is accepted.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { buildPatch, inlineDiff } from '../src/lib/patch.js';

const { parseDiff } = createRequire(import.meta.url)('../electron/git.cjs');
const git = (cwd, args, input) => execFileSync('git', args, { cwd, input, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString();

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'bl-patch-'));
  git(d, ['init', '-q']);
  writeFileSync(join(d, 'f.txt'), 'one\ntwo\nthree\nfour\nfive\n');
  git(d, ['add', '.']); git(d, ['commit', '-qm', 'init']);
  writeFileSync(join(d, 'f.txt'), 'one\nTWO\nthree\nfour\nFIVE\nsix\n');
  return d;
}

test('stage selected lines only', () => {
  const d = repo();
  try {
    const file = parseDiff(git(d, ['diff', '-U3']))[0];
    const hk = file.hunks[0];
    const pick = new Set(hk.lines.map((l, i) => [l, i]).filter(([l]) => /TWO|two/.test(l.text) && l.t !== ' ').map(([, i]) => i));
    git(d, ['apply', '--cached', '-'], buildPatch(file, hk, pick, false));
    assert.equal(git(d, ['show', ':f.txt']), 'one\nTWO\nthree\nfour\nfive\n');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('unstage selected lines from the index', () => {
  const d = repo();
  try {
    git(d, ['add', 'f.txt']);
    const file = parseDiff(git(d, ['diff', '--cached', '-U3']))[0];
    const hk = file.hunks[0];
    const pick = new Set(hk.lines.map((l, i) => [l, i]).filter(([l]) => l.text === 'six').map(([, i]) => i));
    git(d, ['apply', '--cached', '-R', '-'], buildPatch(file, hk, pick, true));
    assert.equal(git(d, ['show', ':f.txt']), 'one\nTWO\nthree\nfour\nFIVE\n');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('discard a whole hunk from the working tree', () => {
  const d = repo();
  try {
    const file = parseDiff(git(d, ['diff', '-U0']))[0];
    git(d, ['apply', '--unidiff-zero', '-R', '-'], buildPatch(file, file.hunks[0], null, true));
    assert.match(git(d, ['diff', '-U0']), /FIVE/);
    assert.doesNotMatch(git(d, ['diff', '-U0']), /TWO/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('inlineDiff isolates the changed part', () => {
  const r = inlineDiff('const port = 3000;', 'const port = 8080;');
  assert.deepEqual(r.a, ['const port = ', '3000', ';']);
  assert.deepEqual(r.b, ['const port = ', '8080', ';']);
});

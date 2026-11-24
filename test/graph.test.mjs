import test from 'node:test';
import assert from 'node:assert';
import { layout } from '../src/lib/graph.js';

const C = (sha, ...parents) => ({ sha, parents });

test('linear history stays in lane 0', () => {
  const { rows, width } = layout([C('c', 'b'), C('b', 'a'), C('a')]);
  assert.equal(width, 1);
  assert.deepEqual(rows.map((r) => r.col), [0, 0, 0]);
});

test('a merge opens a second lane that closes at the fork point', () => {
  // M merges F into main; F and B both come from A
  const { rows, width } = layout([C('M', 'B', 'F'), C('F', 'A'), C('B', 'A'), C('A')]);
  assert.equal(width, 2);
  assert.equal(rows[0].bottom.length, 2, 'merge has two outgoing edges');
  assert.equal(rows[1].col, 1, 'feature commit sits in lane 1');
  assert.equal(rows[2].col, 0);
  assert.equal(rows[3].col, 0);
  assert.ok(rows[3].top.some((s) => s.from === 1 && s.to === 0), 'lane 1 converges into A');
});

test('pass-through lanes continue when a merge reuses an existing lane', () => {
  // two tips X, Y; M merges Y's parent P which is already awaited in lane 1
  const { rows } = layout([C('X', 'M'), C('Y', 'P'), C('M', 'A', 'P'), C('P', 'A'), C('A')]);
  const m = rows[2];
  assert.ok(m.bottom.some((s) => s.from === 1 && s.to === 1), 'lane 1 keeps going below the merge');
  assert.ok(m.bottom.some((s) => s.from === 0 && s.to === 1), 'merge edge joins lane 1');
});

test('freed lanes are reused, keeping the graph narrow', () => {
  const list = [C('t1', 'a'), C('t2', 'a'), C('a', 'b'), C('t3', 'b'), C('b')];
  const { width } = layout(list);
  assert.equal(width, 2);
});

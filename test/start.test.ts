import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planStart } from '../src/state/start.js';
import { numberingDump } from '../src/state/numbering.js';
import type { FinishedGame } from '../src/results/registry.js';
import { logger } from '../src/util/logger.js';

function warnings() {
  const orig = logger.warn;
  const msgs: string[] = [];
  logger.warn = (m: string) => void msgs.push(m);
  return { msgs, done: () => void (logger.warn = orig) };
}

const starts = [0, 100, 200, 300, 400]; // K = 5
const base = { starts, end: 500, fromEnd: false, size: 520 };

test('planStart table: the catch-up always starts at the game in progress', () => {
  // game K in progress (N = K-1)
  assert.deepEqual(planStart({ ...base, finished: 4 }), { offset: 400, firstGame: 5 });
  // between games (N = K): nothing to catch up, next game is K+1
  assert.deepEqual(planStart({ ...base, finished: 5 }), { offset: 500, firstGame: 6 });
  // games ended while the server was down are not caught up (only the current one)
  assert.deepEqual(planStart({ ...base, finished: 2 }), { offset: 400, firstGame: 5 });
  // no PGN: last started game is current
  assert.deepEqual(planStart({ ...base }), { offset: 400, firstGame: 5 });
  // game 1 starts at offset 0 (preamble)
  assert.deepEqual(planStart({ ...base, starts: [50], end: 300, finished: 0 }), { offset: 0, firstGame: 1 });
  // no detected starts (raw log): legacy full read
  assert.deepEqual(planStart({ ...base, starts: [], end: 80, finished: 0 }), { offset: 0, firstGame: 1 });
  // fromEnd
  assert.deepEqual(planStart({ ...base, fromEnd: true, finished: 4 }), { offset: 520 });
});

test('planStart: finished > K warns and the next game is K+1', () => {
  const w = warnings();
  const p = planStart({ ...base, finished: 9 });
  w.done();
  assert.equal(p.firstGame, 6);
  assert.match(w.msgs[0], /misaligned PGN/);
});

const g = (n: number, w = 'A', b = 'B', result = '1-0'): FinishedGame => ({ number: n, white: w, black: b, result, headers: {} }) as FinishedGame;

test('numberingDump: CTRESET then a single Game No. row for g-1; null without prior games', () => {
  assert.equal(numberingDump([g(1), g(2)], 1), null);
  const d = numberingDump([g(1), g(2), g(3)], 3)!;
  assert.equal(d[0], 'CTRESET');
  assert.ok(d.slice(1).every((l) => l.startsWith('CT:')));
  const rows = d.filter((l) => /^CT:\d+\s+\S/.test(l) && !/^CT:\d+\./.test(l));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^CT:2\s/);
});

test('numberingDump warns when the newest finished game is not g-1', () => {
  const w = warnings();
  numberingDump([g(1)], 3);
  w.done();
  assert.match(w.msgs[0], /newest finished is 1/);
});

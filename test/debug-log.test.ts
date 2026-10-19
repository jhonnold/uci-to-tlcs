import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DebugLogSaver } from '../src/state/debug-log.js';
import { scanGameStarts } from '../src/results/log-scan.js';

const LOG = new URL('../fixtures/fastchess-adjudicated.log', import.meta.url).pathname;
const fixLog = readFileSync(LOG);
const seedScan = scanGameStarts(LOG, 'fastchess');
const reg = (n: number) => ({
  finishedCount: () => n,
  lookup: (i: number) => (i === 1 ? { white: 'BerserkA', black: 'Berserk B' } : i === 2 ? { white: 'Berserk B', black: 'BerserkA' } : undefined),
});
const files = (d: string) => readdirSync(d).filter((f) => f.startsWith('Debug-')).sort();

test('writes one file per finished game with byte-exact segments', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'dbg-'));
  const s = new DebugLogSaver(LOG, 'fastchess', d, reg(2));
  s.poll();
  assert.deepEqual(files(d), ['Debug-BerserkA_vs_Berserk_B-1.log', 'Debug-Berserk_B_vs_BerserkA-2.log']);
  const [a, b] = [readFileSync(path.join(d, files(d)[0])), readFileSync(path.join(d, files(d)[1]))];
  assert.ok(a.equals(fixLog.subarray(0, seedScan.starts[1])));
  assert.ok(b.equals(fixLog.subarray(seedScan.starts[1], seedScan.end)));
  // a second saver over the same dir writes nothing new
  const mtimes = files(d).map((f) => readFileSync(path.join(d, f)).length);
  new DebugLogSaver(LOG, 'fastchess', d, reg(2)).poll();
  assert.equal(files(d).length, 2);
  assert.deepEqual(files(d).map((f) => readFileSync(path.join(d, f)).length), mtimes);
  assert.ok(!readdirSync(d).some((f) => f.endsWith('.tmp')));
});

test('without a PGN only the finished-by-next-start game is written; names come from the log', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'dbg-'));
  new DebugLogSaver(LOG, 'fastchess', d).poll();
  assert.equal(files(d).length, 1);
  assert.match(files(d)[0], /^Debug-.+_vs_.+-1\.log$/);
  assert.ok(!files(d)[0].includes('unknown'), files(d)[0]);
});

test('seeded: byte-identical files and the reader starts at the current game', () => {
  const d1 = mkdtempSync(path.join(tmpdir(), 'dbg-'));
  const d2 = mkdtempSync(path.join(tmpdir(), 'dbg-'));
  new DebugLogSaver(LOG, 'fastchess', d1, reg(2)).poll();
  const seeded = new DebugLogSaver(LOG, 'fastchess', d2, reg(2), seedScan);
  seeded.poll();
  assert.deepEqual(files(d1), files(d2));
  for (const f of files(d1)) assert.ok(readFileSync(path.join(d1, f)).equals(readFileSync(path.join(d2, f))), f);
  // its own reader began at the start of game K
  const r = (seeded as unknown as { reader: { offset: number } }).reader;
  assert.equal(r.offset, seedScan.end);
});

test('a pre-existing Debug-*-<n>.log with another name suppresses the numbered file', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'dbg-'));
  writeFileSync(path.join(d, 'Debug-unknown_vs_unknown-1.log'), 'x');
  new DebugLogSaver(LOG, 'fastchess', d, reg(2)).poll();
  assert.equal(files(d).filter((f) => f.endsWith('-1.log')).length, 1);
  assert.equal(files(d).length, 2);
});

test('names are sanitized', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'dbg-'));
  const r = { finishedCount: () => 1, lookup: (n: number) => (n === 1 ? { white: 'a b/c', black: 'x:y' } : undefined) };
  new DebugLogSaver(LOG, 'fastchess', d, r).poll();
  assert.ok(files(d).includes('Debug-a_b_c_vs_x_y-1.log'), files(d).join());
});

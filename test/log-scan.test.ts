import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanGameStarts } from '../src/results/log-scan.js';
import { Pipeline, type BroadcastSink } from '../src/pipeline.js';
import { makeSource } from '../src/source/index.js';

const fixturePath = fileURLToPath(new URL('../fixtures/fastchess-adjudicated.log', import.meta.url));
const fixture = readFileSync(fixturePath, 'utf8');

function countGames(text: string, format: 'fastchess'): number {
  let games = 0;
  const sink = { setSite() {}, setPlayers() { games++; }, emitInitialPosition() {}, emitMove() {}, emitClocks() {}, emitPv() {}, emitResult() {} } as BroadcastSink;
  const p = new Pipeline(sink, { white: 'White', black: 'Black', site: 's' });
  const src = makeSource(format);
  for (const l of text.split('\n')) {
    const n = src.normalize(l);
    if (n) p.handleLine(n);
  }
  return games;
}

function tmpFile(content: string | Buffer): string {
  const f = join(mkdtempSync(join(tmpdir(), 'scan-')), 'fc.log');
  writeFileSync(f, content);
  return f;
}

test('fixture: 2 starts, each at a ucinewgame line, second after game 1 ended', () => {
  const { starts, end } = scanGameStarts(fixturePath, 'fastchess');
  assert.equal(starts.length, 2);
  const buf = readFileSync(fixturePath);
  for (const s of starts) {
    const line = buf.subarray(s, buf.indexOf(0x0a, s)).toString();
    assert.match(line, /<--- ucinewgame/);
  }
  const lastBest = buf.lastIndexOf('---> bestmove', starts[1]);
  assert.ok(starts[1] > lastBest && lastBest > starts[0]);
  assert.equal(end, buf.length);
});

test('multi-byte names + CRLF: identical, exact byte offsets for chunk sizes 1, 7, 64K', () => {
  const text = fixture.replace(/BerserkA/g, 'Bérsérk✓A').replace(/\n/g, '\r\n');
  const f = tmpFile(text);
  const buf = readFileSync(f);
  const ref = scanGameStarts(f, 'fastchess', 64 * 1024);
  assert.equal(ref.starts.length, 2);
  for (const cs of [1, 7, 64 * 1024]) {
    const r = scanGameStarts(f, 'fastchess', cs);
    assert.deepEqual(r, ref, `chunk ${cs}`);
  }
  for (const s of ref.starts) {
    assert.ok(s === 0 || buf[s - 1] === 0x0a);
    const line = buf.subarray(s, buf.indexOf(0x0d, s)).toString();
    assert.match(line, /<--- ucinewgame/);
  }
});

test('partial last line is not processed; half-written ucinewgame is not counted', () => {
  let idx = -1;
  for (let i = 0; i < 3; i++) idx = fixture.indexOf('<--- ucinewgame', idx + 1); // game 2's first
  const cut = idx + 5; // mid-line
  const f = tmpFile(fixture.slice(0, cut));
  const { starts, end } = scanGameStarts(f, 'fastchess');
  assert.equal(starts.length, 1);
  assert.equal(end, Buffer.byteLength(fixture.slice(0, fixture.lastIndexOf('\n', cut) + 1)));
});

test('parity: scan start count == Pipeline setPlayers count (fastchess fixture)', () => {
  assert.equal(scanGameStarts(fixturePath, 'fastchess').starts.length, countGames(fixture, 'fastchess'));
});

test('parity: myracle-style sequential init (A ucinewgame, go, then B ucinewgame), 2 games', () => {
  const L = (e: string, dir: '<---' | '--->', s: string) => `[Engine] [00:00:00.000000] <     1>  ${e} ${dir} ${s}`;
  const game = (a: string, b: string, mv: string) => [
    L(a, '<---', 'ucinewgame'),
    L(a, '<---', 'position startpos'),
    L(a, '<---', 'go wtime 1000 btime 1000'),
    L(b, '<---', 'ucinewgame'),
    L(a, '--->', `bestmove ${mv}`),
  ];
  const text = [...game('A', 'B', 'e2e4'), ...game('B', 'A', 'e2e4')].join('\n') + '\n';
  const f = tmpFile(text);
  assert.equal(scanGameStarts(f, 'fastchess').starts.length, 2);
  assert.equal(countGames(text, 'fastchess'), 2);
});

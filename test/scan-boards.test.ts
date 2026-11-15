import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanBoards } from '../src/results/log-scan.js';
import { Demux } from '../src/demux.js';
import { Pipeline, type BroadcastSink } from '../src/pipeline.js';
import { FastchessSource } from '../src/source/fastchess-source.js';

const fx = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
const nullSink = (): BroadcastSink => ({
  setSite() {}, setPlayers() {}, emitInitialPosition() {}, emitMove() {}, emitClocks() {}, emitPv() {}, emitResult() {},
});

/** Where each board's current game starts, as the live Demux allocates it. */
function liveAllocation(path: string): Map<number, string> {
  const owners = new Map<number, string>();
  const src = new FastchessSource();
  const demux = new Demux(() => new Pipeline(nullSink(), { white: 'W', black: 'B', site: 's' }));
  for (const l of readFileSync(path, 'utf8').split('\n')) {
    const n = src.normalize(l);
    if (!n) continue;
    const before = demux.count();
    demux.handleLine(n);
    if (n.direction === 'in' && n.uci === 'ucinewgame') {
      const id = demux.boardOf(n.channel!);
      if (id) owners.set(id, n.channel!);
    }
    void before;
  }
  return owners;
}

test('scanBoards: concurrent log -> one board per worker, current game start per board, same ids as live', () => {
  const path = fx('fastchess-concurrent.log');
  const s = scanBoards(path, 'fastchess');
  assert.equal(s.count, 3);
  const text = readFileSync(path);
  const live = liveAllocation(path);
  for (const b of s.boards) {
    assert.equal(live.get(b.id), b.channel, `board ${b.id}`);
    // the start offset is that channel's last ucinewgame pair's first line
    const line = text.subarray(b.start, text.indexOf(10, b.start)).toString();
    assert.match(line, new RegExp(`<\\s*${b.channel}>.*<--- ucinewgame`));
    const lastOpen = text.lastIndexOf(Buffer.from(`${b.channel}>  `));
    assert.ok(b.start <= lastOpen);
  }
  assert.ok(s.end > 0);
});

test('scanBoards: sequential logs (also appended runs with new thread ids) are one board', () => {
  assert.equal(scanBoards(fx('fastchess-adjudicated.log'), 'fastchess').count, 1);
  const dir = mkdtempSync(join(tmpdir(), 'scan-'));
  const p = join(dir, 'two-runs.log');
  const quit = '[Engine] [0] <                 777>  BerserkA <--- quit\n';
  writeFileSync(p, readFileSync(fx('fastchess-adjudicated.log'), 'utf8') + quit + readFileSync(fx('fastchess-multigame.log'), 'utf8'));
  assert.equal(scanBoards(p, 'fastchess').count, 1);
  assert.equal(scanBoards(fx('multi-game.uci'), 'raw').count, 1);
});

test('Demux.reserve: reserved channels get their boards; other channels wait until the reservation ends', () => {
  const T = (ch: string, eng: string, uci: string) => `[Engine] [0] <${ch.padStart(20)}>  ${eng} <--- ${uci}`;
  const src = new FastchessSource();
  const made: number[] = [];
  const demux = new Demux((id) => (made.push(id), new Pipeline(nullSink(), { white: 'W', black: 'B', site: 's' })));
  demux.reserve(new Map([['20', 3], ['10', 1]]), 3);
  assert.deepEqual(made, [1, 2, 3]);
  for (const l of [T('20', 'A', 'ucinewgame'), T('30', 'C', 'ucinewgame'), T('10', 'B', 'ucinewgame')]) demux.handleLine(src.normalize(l)!);
  assert.equal(demux.boardOf('20'), 3);
  assert.equal(demux.boardOf('10'), 1);
  assert.equal(demux.boardOf('30'), undefined);
  demux.endReservation();
  demux.handleLine(src.normalize(T('30', 'C', 'ucinewgame'))!);
  assert.equal(demux.boardOf('30'), 2);
});

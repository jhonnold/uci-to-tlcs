import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Pipeline, type BroadcastSink } from '../src/pipeline.js';
import { FastchessSource } from '../src/source/fastchess-source.js';
import { GameState } from '../src/game/game-state.js';
import type { ColorCode } from '../src/tlcs/protocol.js';

type Emit =
  | { k: 'pv'; color: ColorCode; depth: number; pv: string[] }
  | { k: 'move'; san: string }
  | { k: 'other' };

class Sink implements BroadcastSink {
  emits: Emit[] = [];
  setSite() {}
  setPlayers() {}
  emitInitialPosition() {}
  emitMove(a: { san: string }) {
    this.emits.push({ k: 'move', san: a.san });
  }
  emitClocks() {}
  emitPv(color: ColorCode, depth: number, _s: number, _t: number, _n: number, pv: string[]) {
    this.emits.push({ k: 'pv', color, depth, pv });
  }
  emitResult() {}
  get pvs() {
    return this.emits.filter((e): e is Extract<Emit, { k: 'pv' }> => e.k === 'pv');
  }
}

const PFX = '[Engine] [18:57:54.767216] <     139757375043264>  ';
const inn = (e: string, msg: string) => `${PFX}${e} <--- ${msg}`;
const out = (e: string, msg: string) => `${PFX}${e} ---> ${msg}`;
const GO = 'go wtime 2020 btime 2020 winc 20 binc 20';
const INFO = (depth: number, pv: string) => `info depth ${depth} multipv 1 score cp 10 nodes ${depth * 100} time 20 pv ${pv}`;

function setup(opts: { pvIntervalMs?: number } = {}) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const sink = new Sink();
  const src = new FastchessSource();
  const p = new Pipeline(sink, { white: 'W', black: 'B', site: 'S' }, opts);
  const feed = (l: string) => {
    const n = src.normalize(l);
    if (n) p.handleLine(n);
  };
  feed(inn('A', 'ucinewgame'));
  feed(inn('B', 'ucinewgame'));
  feed(inn('A', 'position startpos'));
  feed(inn('A', GO));
  return { sink, p, feed };
}

afterEach(() => mock.timers.reset());

test('coalesce: leading edge sends at once, later infos replace the slot, timer flushes the latest', () => {
  const { sink, feed } = setup();
  for (let d = 1; d <= 10; d++) feed(out('A', INFO(d, 'e2e4 e7e5')));
  assert.equal(sink.pvs.length, 1);
  assert.equal(sink.pvs[0].depth, 1);
  mock.timers.tick(200);
  assert.equal(sink.pvs.length, 2);
  assert.equal(sink.pvs[1].depth, 10);
  mock.timers.tick(1000);
  assert.equal(sink.pvs.length, 2, 'nothing pending, nothing more sent');
});

test('flush before move: latest PV (pre-move board) precedes the move', () => {
  const { sink, feed } = setup();
  for (let d = 1; d <= 5; d++) feed(out('A', INFO(d, 'e2e4 e7e5')));
  feed(out('A', 'bestmove e2e4'));
  const kinds = sink.emits.map((e) => e.k);
  assert.deepEqual(kinds, ['pv', 'pv', 'move']);
  assert.equal(sink.pvs[1].depth, 5);
  assert.equal(sink.pvs[1].pv[0], 'e2e4');
  assert.equal((sink.emits[2] as { san: string }).san, 'e4');
});

test('stale-PV guard: off-move engine info is never stored or emitted', () => {
  const { sink, feed } = setup();
  feed(out('A', INFO(1, 'e2e4')));
  feed(out('B', INFO(9, 'e7e5'))); // B is not on move
  feed(out('A', 'bestmove e2e4'));
  feed(out('B', INFO(10, 'e7e5'))); // now B is on move (fine) but within the window
  mock.timers.tick(200);
  assert.ok(sink.pvs.every((p) => p.depth !== 9));
  // after A's move, info from A (off-move) must not be emitted
  feed(out('A', INFO(11, 'g1f3')));
  mock.timers.tick(1000);
  assert.ok(sink.pvs.every((p) => p.depth !== 11));
});

test('a timer firing after the move does not emit the old-ply PV', () => {
  const { sink, feed } = setup();
  feed(out('A', INFO(1, 'e2e4 e7e5')));
  feed(out('A', INFO(2, 'e2e4 e7e5'))); // pending, timer armed
  feed(out('A', 'bestmove e2e4')); // flush consumes pending
  const n = sink.pvs.length;
  feed(out('B', INFO(3, 'e7e5'))); // pending for B, timer armed
  feed(inn('B', 'position startpos moves e2e4 e7e5'));
  feed(out('B', 'bestmove e7e5'));
  mock.timers.tick(1000);
  assert.deepEqual(
    sink.pvs.slice(n).map((p) => p.depth),
    [3],
    'only the B flush-before-move PV; no stray timer emits',
  );
});

test('pending PV is dropped on a new game and on quit; close() clears the timer', () => {
  const { sink, p, feed } = setup();
  feed(out('A', INFO(1, 'e2e4')));
  feed(out('A', INFO(2, 'e2e4'))); // pending
  feed(inn('A', 'ucinewgame')); // new game
  mock.timers.tick(1000);
  assert.equal(sink.pvs.length, 1);

  const s2 = setup();
  s2.feed(out('A', INFO(1, 'e2e4')));
  s2.feed(out('A', INFO(2, 'e2e4')));
  s2.feed(inn('A', 'quit'));
  mock.timers.tick(1000);
  assert.equal(s2.sink.pvs.length, 1);

  const s3 = setup();
  s3.feed(out('A', INFO(1, 'e2e4')));
  s3.feed(out('A', INFO(2, 'e2e4')));
  s3.p.close();
  mock.timers.tick(1000);
  assert.equal(s3.sink.pvs.length, 1);
  void p;
});

test('pvIntervalMs 0: every info is emitted', () => {
  const { sink, feed } = setup({ pvIntervalMs: 0 });
  for (let d = 1; d <= 6; d++) feed(out('A', INFO(d, 'e2e4')));
  assert.deepEqual(sink.pvs.map((p) => p.depth), [1, 2, 3, 4, 5, 6]);
});

test('same-ply rebuild with a different base clears the pending PV', () => {
  const { sink, feed } = setup();
  feed(out('A', INFO(1, 'e2e4')));
  feed(out('A', INFO(2, 'e2e4'))); // pending
  // identical (empty) move list but a different base: not a game reset, rebuilds the board
  feed(inn('A', 'position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'));
  mock.timers.tick(1000);
  assert.equal(sink.pvs.length, 1);
});

test('game-state: PV legal prefix in coords (castling, promotion, truncation) and applyMove SAN', () => {
  const g = new GameState();
  assert.ok(g.setPosition(false, 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', []));
  assert.deepEqual(g.legalPvPrefix(['e1g1', 'e8c8', 'a1a8']), ['e1g1', 'e8c8', 'a1a8']); // not truncated
  assert.deepEqual(g.legalPvPrefix(['e1g1', 'e8c8', 'e2e4']), ['e1g1', 'e8c8']); // illegal: truncated
  const q = new GameState();
  assert.ok(q.setPosition(false, 'k7/4P3/8/8/8/8/8/4K3 w - - 0 1', []));
  assert.deepEqual(q.legalPvPrefix(['e7e8Q']), ['e7e8q']); // promotion normalized to lowercase
  const h = new GameState();
  assert.equal(h.applyMove('e2e4')?.san, 'e4');
  assert.equal(h.applyMove('e7e5')?.san, 'e5');
  assert.equal(h.applyMove('e1e3'), null);
});

test('game-state: sameBase', () => {
  const g = new GameState();
  assert.ok(g.setPosition(true, undefined, ['e2e4']));
  assert.ok(g.sameBase(true, undefined));
  assert.ok(!g.sameBase(false, 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'));
  const f = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1';
  assert.ok(g.setPosition(false, f, []));
  assert.ok(g.sameBase(false, f));
  assert.ok(!g.sameBase(true, undefined));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Pipeline, formatLevel, type BroadcastSink } from '../src/pipeline.js';
import { FastchessSource } from '../src/source/fastchess-source.js';
import type { ColorCode } from '../src/tlcs/protocol.js';

type Emit =
  | { k: 'players'; white: string; black: string }
  | { k: 'init'; fen: string; fmr: number }
  | { k: 'move'; fen: string; color: ColorCode; n: number; san: string; fmr: number }
  | { k: 'clocks'; w: number; b: number }
  | { k: 'pv'; color: ColorCode; pv: string[] }
  | { k: 'result'; result: string }
  | { k: 'level'; text: string };

class Sink implements BroadcastSink {
  emits: Emit[] = [];
  setSite() {}
  setPlayers(white: string, black: string) {
    this.emits.push({ k: 'players', white, black });
  }
  emitInitialPosition(fen: string, fmr: number) {
    this.emits.push({ k: 'init', fen, fmr });
  }
  emitMove(a: { fenTruncated: string; color: ColorCode; fullMoveNumber: number; san: string; fmr: number }) {
    this.emits.push({ k: 'move', fen: a.fenTruncated, color: a.color, n: a.fullMoveNumber, san: a.san, fmr: a.fmr });
  }
  emitClocks(w: number, b: number) {
    this.emits.push({ k: 'clocks', w, b });
  }
  emitPv(color: ColorCode, _d: number, _s: number, _t: number, _n: number, pv: string[]) {
    this.emits.push({ k: 'pv', color, pv });
  }
  emitResult(result: string) {
    this.emits.push({ k: 'result', result });
  }
  emitLevel(text: string) {
    this.emits.push({ k: 'level', text });
  }
}

const STARTPOS = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';
const PFX = '[Engine] [18:57:54.767216] <     139757375043264>  ';
const inn = (e: string, msg: string) => `${PFX}${e} <--- ${msg}`;
const out = (e: string, msg: string) => `${PFX}${e} ---> ${msg}`;

function run(lines: string[], fenSetupMove?: boolean): Emit[] {
  const sink = new Sink();
  const src = new FastchessSource();
  const p = new Pipeline(sink, { white: 'White', black: 'Black', site: 'S', fenSetupMove });
  for (const l of lines) {
    const n = src.normalize(l);
    if (n) p.handleLine(n);
  }
  return sink.emits;
}

const GO = 'go wtime 2020 btime 2020 winc 20 binc 20';
const INFO = (mv: string) => `info depth 5 seq 1 multipv 1 score cp 10 nodes 100 nps 1000 time 20 pv ${mv}`;
const NEWGAME = [inn('A', 'ucinewgame'), inn('B', 'ucinewgame')];
const BLACK_EPD = 'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
const WHITE_EPD = 'r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1 w - - 0 1';

test('PGN-book start: base startpos, book moves replayed, level, no setup move', () => {
  const e = run([...NEWGAME, inn('A', 'position startpos moves e2e4 e7e5'), inn('A', GO)]);
  assert.deepEqual(e.map((x) => x.k), ['players', 'init', 'move', 'move', 'level', 'clocks']);
  assert.deepEqual(e[0], { k: 'players', white: 'A', black: 'B' });
  assert.deepEqual(e[1], { k: 'init', fen: STARTPOS, fmr: 0 });
  assert.deepEqual(e[2], { k: 'move', fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq', color: 'w', n: 1, san: 'e4', fmr: 0 });
  assert.equal((e[3] as Extract<Emit, { k: 'move' }>).san, 'e5');
  assert.deepEqual(e[4], { k: 'level', text: '0 0:02 0.02' });
});

test('PGN-book with odd ply count: first-go engine is Black', () => {
  const e = run([...NEWGAME, inn('B', 'position startpos moves e2e4'), inn('B', GO)]);
  assert.deepEqual(e[0], { k: 'players', white: 'A', black: 'B' });
  assert.equal((e[2] as Extract<Emit, { k: 'move' }>).san, 'e4');
});

test('EPD white to move: startpos reset, FEN, setup move, level; later move numbered from the EPD', () => {
  const e = run([
    ...NEWGAME,
    inn('A', `position fen ${WHITE_EPD}`),
    inn('A', GO),
    out('A', INFO('h2h3')),
    out('A', 'bestmove h2h3'),
  ]);
  const fen = 'r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1 w -';
  assert.deepEqual(e[0], { k: 'players', white: 'A', black: 'B' });
  assert.deepEqual(e[1], { k: 'init', fen: STARTPOS, fmr: 0 });
  assert.deepEqual(e[2], { k: 'init', fen, fmr: 0 });
  assert.deepEqual(e[3], { k: 'move', fen, color: 'w', n: 1, san: '(setup)', fmr: 0 });
  assert.equal(e[4].k, 'level');
  const pvI = e.findIndex((x) => x.k === 'pv');
  const mvI = e.findIndex((x, i) => i > 3 && x.k === 'move');
  assert.ok(pvI > 0 && pvI < mvI, 'PV precedes the move');
  assert.equal((e[mvI] as Extract<Emit, { k: 'move' }>).san, 'h3');
  assert.equal((e[mvI] as Extract<Emit, { k: 'move' }>).n, 1);
});

test('EPD black to move: first-go engine is Black; colours, PVs and numbering follow', () => {
  const e = run([
    ...NEWGAME,
    inn('B', `position fen ${BLACK_EPD}`),
    inn('B', GO),
    out('B', INFO('d7d6')),
    out('B', 'bestmove d7d6'),
    inn('A', `position fen ${BLACK_EPD} moves d7d6`),
    inn('A', GO),
    out('A', INFO('d2d4')),
    out('A', 'bestmove d2d4'),
  ]);
  assert.deepEqual(e[0], { k: 'players', white: 'A', black: 'B' });
  assert.deepEqual(e[3], {
    k: 'move',
    fen: 'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq',
    color: 'b',
    n: 2,
    san: '(setup)',
    fmr: 1,
  });
  const pvs = e.filter((x) => x.k === 'pv') as Extract<Emit, { k: 'pv' }>[];
  assert.deepEqual(pvs.map((p) => p.color), ['b', 'w']);
  const moves = e.filter((x) => x.k === 'move') as Extract<Emit, { k: 'move' }>[];
  assert.deepEqual(moves.slice(1).map((m) => `${m.n}${m.color}${m.san}`), ['2bd6', '3wd4']);
});

test('myracle order with a black-to-move base: late second ucinewgame still binds first-go engine to Black', () => {
  const e = run([
    inn('B', 'ucinewgame'),
    inn('B', `position fen ${BLACK_EPD}`),
    inn('B', GO),
    inn('A', 'ucinewgame'),
  ]);
  assert.ok(e.some((x) => x.k === 'players' && x.white === 'A' && x.black === 'B'));
  assert.ok(e.some((x) => x.k === 'move' && x.san === '(setup)' && x.color === 'b'));
});

test('second game after an EPD game repeats the setup sequence after its players', () => {
  const g1 = [...NEWGAME, inn('A', `position fen ${WHITE_EPD}`), inn('A', GO)];
  const g2 = [...NEWGAME, inn('B', `position fen ${BLACK_EPD}`), inn('B', GO)];
  const e = run([...g1, ...g2]);
  const kinds = e.map((x) => x.k);
  // game 1: players init init move level clocks; then synthesized result; game 2 same shape
  assert.deepEqual(kinds, [
    'players', 'init', 'init', 'move', 'level', 'clocks',
    'result',
    'players', 'init', 'init', 'move', 'level', 'clocks',
  ]);
});

test('fenSetupMove=false: plain FEN header, book moves still replayed; startpos unaffected', () => {
  const e = run([...NEWGAME, inn('A', `position fen ${WHITE_EPD} moves h2h3`), inn('A', GO)], false);
  assert.deepEqual(e.map((x) => x.k), ['players', 'init', 'move', 'level', 'clocks']);
  assert.equal((e[1] as Extract<Emit, { k: 'init' }>).fen.startsWith('r1bq1rk1'), true);
  assert.equal((e[2] as Extract<Emit, { k: 'move' }>).san, 'h3');
  const sp = (f: boolean) => run([...NEWGAME, inn('A', 'position startpos'), inn('A', GO)], f);
  assert.deepEqual(sp(false), sp(true));
});

test('stale-PV guard', () => {
  const e = run([
    ...NEWGAME,
    inn('A', 'position startpos'),
    out('B', INFO('e7e5')), // before the header: dropped
    inn('A', GO),
    out('B', INFO('e7e5')), // Black is not on move: dropped
    inn('A', INFO('e2e4')), // 'in' direction (GUI echo): dropped
    out('A', INFO('e2e4')),
    out('A', 'bestmove e2e4'),
  ]);
  const kinds = e.map((x) => x.k);
  assert.equal(kinds.filter((k) => k === 'pv').length, 1);
  assert.ok(kinds.indexOf('pv') < kinds.lastIndexOf('move'), 'PV precedes the move');
});

test('level formatting', () => {
  const stm = 'w' as const;
  assert.equal(formatLevel({ type: 'go', movetimeMs: 1000 }, stm), undefined);
  assert.equal(formatLevel({ type: 'go', nodes: 5000 }, stm), undefined);
  assert.equal(formatLevel({ type: 'go', wtimeMs: 60000, btimeMs: 60000, movestogo: 40 }, stm), '40 1 0');
  assert.equal(formatLevel({ type: 'go', wtimeMs: 3050, btimeMs: 3050, wincMs: 50, bincMs: 50 }, stm), '0 0:03 0.05');
  assert.equal(formatLevel({ type: 'go', wtimeMs: 2500, btimeMs: 2500 }, stm), '0 0:02.5 0');
  assert.equal(formatLevel({ type: 'go', wtimeMs: 1000, btimeMs: 900 }, stm), undefined);
});

test('level is emitted once per game', () => {
  const e = run([...NEWGAME, inn('A', 'position startpos'), inn('A', GO), out('A', 'bestmove e2e4'), inn('B', 'position startpos moves e2e4'), inn('B', 'go wtime 1990 btime 2020 winc 20 binc 20')]);
  assert.equal(e.filter((x) => x.k === 'level').length, 1);
});

test('FMR follows the FEN halfmove clock', () => {
  const e = run([
    ...NEWGAME,
    inn('A', 'position startpos'),
    inn('A', GO),
    out('A', 'bestmove g1f3'),
    inn('B', 'position startpos moves g1f3'),
    inn('B', GO),
    out('B', 'bestmove g8f6'),
    inn('A', 'position startpos moves g1f3 g8f6'),
    out('A', 'bestmove e2e4'),
  ]);
  const fmrs = (e.filter((x) => x.k === 'move') as Extract<Emit, { k: 'move' }>[]).map((m) => m.fmr);
  assert.deepEqual(fmrs, [1, 2, 0]);
});

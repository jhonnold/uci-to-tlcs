import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseInfoLine, scoreToCentipawns } from '../src/uci/info.js';
import { parseLine } from '../src/uci/parser.js';
import { GameState } from '../src/game/game-state.js';
import * as P from '../src/tlcs/protocol.js';
import { Pipeline, type BroadcastSink } from '../src/pipeline.js';
import type { ColorCode } from '../src/tlcs/protocol.js';

// ----------------------------------------------------------------- info parsing

test('parseInfoLine: cp score, units, fields', () => {
  const info = parseInfoLine('info depth 20 seldepth 28 multipv 1 score cp 35 nodes 1500000 nps 1200000 time 1200 pv e2e4 e7e5');
  assert.ok(info);
  assert.equal(info!.depth, 20);
  assert.equal(info!.seldepth, 28);
  assert.equal(info!.multipv, 1);
  assert.equal(info!.scoreKind, 'cp');
  assert.equal(info!.scoreValue, 35);
  assert.equal(info!.nodes, 1500000);
  assert.equal(info!.timeMs, 1200);
  assert.deepEqual(info!.pv, ['e2e4', 'e7e5']);
});

const FULL_INFO =
  'info depth 33 seldepth 64 score cp 61 wdl 196 801 3 nodes 18853873877 nps 263995696 hashfull 214 tbhits 36079 time 71417 pv h2h3 g8g7 f1g3';

test('parseInfoLine: seldepth, wdl, nps, hashfull, tbhits', () => {
  const info = parseInfoLine(FULL_INFO);
  assert.ok(info);
  assert.equal(info!.depth, 33);
  assert.equal(info!.seldepth, 64);
  assert.equal(info!.scoreValue, 61);
  assert.deepEqual(info!.wdl, [196, 801, 3]);
  assert.equal(info!.nodes, 18853873877);
  assert.equal(info!.nps, 263995696);
  assert.equal(info!.hashfull, 214);
  assert.equal(info!.tbhits, 36079);
  assert.equal(info!.timeMs, 71417);
  assert.deepEqual(info!.pv, ['h2h3', 'g8g7', 'f1g3']);
});

test('parseInfoLine: absent extended fields are null', () => {
  const info = parseInfoLine('info depth 5 score cp 1 nodes 10 time 1 pv e2e4');
  assert.ok(info);
  assert.equal(info!.seldepth, null);
  assert.equal(info!.wdl, null);
  assert.equal(info!.nps, null);
  assert.equal(info!.hashfull, null);
  assert.equal(info!.tbhits, null);
});

test('P.info: WINFO/BINFO tag-value line in raw UCI units, absent tags omitted', () => {
  const full = parseInfoLine(FULL_INFO)!;
  assert.equal(
    P.info('w', full, full.pv),
    'WINFO: depth 33 seldepth 64 score cp 61 wdl 196 801 3 nodes 18853873877 nps 263995696 hashfull 214 tbhits 36079 time 71417 pv h2h3 g8g7 f1g3',
  );
  const min = parseInfoLine('info depth 5 score cp 1 nodes 10 time 1 pv e2e4')!;
  assert.equal(P.info('b', min, min.pv), 'BINFO: depth 5 score cp 1 nodes 10 time 1 pv e2e4');
  const mate = parseInfoLine('info depth 30 score mate -3 lowerbound nodes 10 time 10 pv e2e4 e7e5')!;
  assert.equal(P.info('w', mate, ['e2e4']), 'WINFO: depth 30 score mate -3 lowerbound nodes 10 time 10 pv e2e4');
});

test('parseInfoLine: mate score', () => {
  const info = parseInfoLine('info depth 30 score mate 3 nodes 10 time 10 pv e2e4');
  assert.ok(info);
  assert.equal(info!.scoreKind, 'mate');
  assert.equal(info!.scoreValue, 3);
});

test('parseInfoLine: lowerbound is ignored but value still parses', () => {
  const info = parseInfoLine('info depth 12 score cp 50 lowerbound nodes 100 time 10 pv e2e4');
  assert.ok(info);
  assert.equal(info!.scoreValue, 50);
  assert.equal(info!.lowerbound, true);
});

test('parseInfoLine: returns null without depth/score/pv', () => {
  assert.equal(parseInfoLine('info string hello world'), null);
  assert.equal(parseInfoLine('info depth 5 nodes 100 time 10'), null); // no score, no pv
  assert.equal(parseInfoLine('info currmove e2e4 currmovenumber 1'), null);
});

test('scoreToCentipawns: cp passthrough, mate mapping (engine POV)', () => {
  assert.equal(scoreToCentipawns(parseInfoLine('info depth 1 score cp 35 time 1 pv e2e4')!), 35);
  assert.equal(scoreToCentipawns(parseInfoLine('info depth 1 score mate 3 time 1 pv e2e4')!), 100000 - 3);
  assert.equal(scoreToCentipawns(parseInfoLine('info depth 1 score mate -2 time 1 pv e2e4')!), -(100000 - 2));
});

// ------------------------------------------------------------------ line parser

test('parseLine: position startpos with moves', () => {
  assert.deepEqual(parseLine('position startpos moves e2e4 e7e5'), {
    type: 'position',
    startpos: true,
    fen: undefined,
    moves: ['e2e4', 'e7e5'],
  });
});

test('parseLine: position fen', () => {
  const ev = parseLine('position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1 moves e2e4');
  assert.deepEqual(ev, {
    type: 'position',
    startpos: false,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: ['e2e4'],
  });
});

test('parseLine: go clocks', () => {
  assert.deepEqual(parseLine('go wtime 300000 btime 299000 winc 2000 binc 2000'), {
    type: 'go',
    wtimeMs: 300000,
    btimeMs: 299000,
    wincMs: 2000,
    bincMs: 2000,
  });
});

test('parseLine: bestmove with ponder, and nullmoves', () => {
  assert.deepEqual(parseLine('bestmove e2e4 ponder e7e5'), { type: 'bestmove', move: 'e2e4', ponder: 'e7e5' });
  assert.deepEqual(parseLine('bestmove (none)'), { type: 'bestmove', move: null });
  assert.deepEqual(parseLine('bestmove 0000'), { type: 'bestmove', move: null });
});

test('parseLine: irrelevant lines drop to null', () => {
  for (const line of ['uci', 'isready', 'readyok', 'ucinewgame', '', '   ', 'option name Hash type spin']) {
    assert.equal(parseLine(line), null);
  }
});

// -------------------------------------------------------------------- GameState

test('GameState: apply move yields SAN, color, move number, truncated FEN, FMR', () => {
  const g = new GameState();
  g.setPosition(true, undefined, []);
  const m1 = g.applyMove('e2e4');
  assert.deepEqual(m1, { color: 'w', fullMoveNumber: 1, san: 'e4' });
  assert.equal(g.fenTruncated(), 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq');
  assert.equal(g.halfmoveClock(), 0);

  const m2 = g.applyMove('e7e5');
  assert.deepEqual(m2, { color: 'b', fullMoveNumber: 1, san: 'e5' });

  const m3 = g.applyMove('g1f3');
  assert.deepEqual(m3, { color: 'w', fullMoveNumber: 2, san: 'Nf3' });
  assert.equal(g.halfmoveClock(), 1); // knight move, no capture/pawn
});

test('GameState: promotion and castling coordinate moves', () => {
  const g = new GameState();
  g.setPosition(false, '4k3/P7/8/8/8/8/8/4K2R w K - 0 1', []);
  assert.deepEqual(g.applyMove('a7a8q'), { color: 'w', fullMoveNumber: 1, san: 'a8=Q+' });
  g.applyMove('e8e7'); // king escapes the check from the new queen on a8
  assert.equal(g.applyMove('e1g1')!.san, 'O-O');
});

test('GameState: PV stays in coords and truncates on illegal move', () => {
  const g = new GameState();
  g.setPosition(true, undefined, []);
  assert.deepEqual(g.legalPvPrefix(['e2e4', 'e7e5', 'g1f3', 'b8c6']), ['e2e4', 'e7e5', 'g1f3', 'b8c6']);
  assert.deepEqual(g.legalPvPrefix(['e2e4', 'e2e4']), ['e2e4']); // second is illegal ⇒ stop
});

test('GameState: result detection (Fool\'s mate)', () => {
  const g = new GameState();
  g.setPosition(true, undefined, ['f2f3', 'e7e5', 'g2g4', 'd8h4']);
  assert.equal(g.isGameOver(), true);
  assert.equal(g.result(), '0-1'); // white is checkmated
});

// ------------------------------------------------------------------- protocol

test('protocol: wire formats', () => {
  assert.equal(P.fen('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq'), 'FEN: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq');
  assert.equal(P.move('w', 1, 'e4'), 'WMOVE: 1. e4');
  assert.equal(P.move('b', 1, 'e5'), 'BMOVE: 1... e5');
  assert.equal(P.time('w', 30000, 29900), 'WTIME: 30000 otim 29900');
  assert.equal(P.time('b', 29900, 30000), 'BTIME: 29900 otim 30000');
  assert.equal(P.pv('w', 20, 35, 120, 1500000, ['e2e4', 'e7e5', 'g1f3']), 'WPV: 20 35 120 1500000 e2e4 e7e5 g1f3');
  assert.equal(P.result('1-0'), 'result: 1-0');
  assert.equal(P.msToCs(1200), 120);
});

// -------------------------------------------------------- end-to-end pipeline

type Emit =
  | { k: 'site'; site: string }
  | { k: 'players'; white: string; black: string }
  | { k: 'init'; fen: string; fmr: number }
  | { k: 'move'; fen: string; color: ColorCode; n: number; san: string; fmr: number }
  | { k: 'clocks'; w: number; b: number }
  | { k: 'pv'; color: ColorCode; depth: number; score: number; time: number; nodes: number; pv: string[] }
  | { k: 'result'; result: string };

class RecordingSink implements BroadcastSink {
  emits: Emit[] = [];
  setSite(site: string) {
    this.emits.push({ k: 'site', site });
  }
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
  emitPv(color: ColorCode, depth: number, score: number, time: number, nodes: number, pv: string[]) {
    this.emits.push({ k: 'pv', color, depth, score, time, nodes, pv });
  }
  emitResult(result: string) {
    this.emits.push({ k: 'result', result });
  }
}

test('pipeline: sample-game.uci produces the expected ordered emissions', () => {
  const path = fileURLToPath(new URL('../fixtures/sample-game.uci', import.meta.url));
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite' });
  for (const line of readFileSync(path, 'utf8').split('\n')) pipeline.handleLine({ uci: line });

  const e = sink.emits;
  // id-name fallback fills in the default names
  assert.deepEqual(e[0], { k: 'site', site: 'TestSite' });
  assert.deepEqual(e[1], { k: 'players', white: 'EngineWhite', black: 'EngineBlack' });
  assert.deepEqual(e[2], {
    k: 'init',
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq',
    fmr: 0,
  });
  assert.deepEqual(e[3], { k: 'clocks', w: 30000, b: 30000 });
  assert.deepEqual(e[4], { k: 'pv', color: 'w', depth: 1, score: 18, time: 1, nodes: 200, pv: ['e2e4'] });
  assert.deepEqual(e[5], { k: 'pv', color: 'w', depth: 20, score: 35, time: 120, nodes: 1500000, pv: ['e2e4', 'e7e5', 'g1f3', 'b8c6'] });
  assert.deepEqual(e[6], {
    k: 'move',
    fen: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq',
    color: 'w',
    n: 1,
    san: 'e4',
    fmr: 0,
  });

  // black's reply: engine-POV -28 broadcast as-is (side-to-move POV passthrough)
  const blackPv = e.find((x) => x.k === 'pv' && x.color === 'b') as Extract<Emit, { k: 'pv' }>;
  assert.equal(blackPv.score, -28);
  assert.deepEqual(blackPv.pv, ['e7e5', 'g1f3', 'b8c6', 'f1b5']);

  const blackMove = e.find((x) => x.k === 'move' && x.color === 'b') as Extract<Emit, { k: 'move' }>;
  assert.deepEqual({ n: blackMove.n, san: blackMove.san }, { n: 1, san: 'e5' });

  // no multipv>=2 lines leaked in, no result for an unfinished game
  assert.ok(!e.some((x) => x.k === 'result'));
});

test('parseLine: go movestogo', () => {
  assert.deepEqual(parseLine('go wtime 60000 btime 60000 movestogo 40'), {
    type: 'go',
    wtimeMs: 60000,
    btimeMs: 60000,
    movestogo: 40,
  });
});

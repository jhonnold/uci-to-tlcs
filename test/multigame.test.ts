import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Pipeline, type BroadcastSink } from '../src/pipeline.js';
import { RawUciSource } from '../src/source/raw-source.js';
import { FastchessSource } from '../src/source/fastchess-source.js';
import type { LogSource, NormalizedLine } from '../src/source/log-source.js';
import type { ColorCode } from '../src/tlcs/protocol.js';

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

const STARTPOS_TRUNC = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';

function drive(source: LogSource, fixture: string): Emit[] {
  const path = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite' });
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const n = source.normalize(line);
    if (n) pipeline.handleLine(n);
  }
  return sink.emits;
}

// indices of every emit of a given kind
const idx = (e: Emit[], k: Emit['k']) => e.flatMap((x, i) => (x.k === k ? [i] : []));

// --------------------------------------------------------- raw multi-game stream

test('raw multi-game: each game resets the board and restarts move numbering', () => {
  const e = drive(new RawUciSource(), 'multi-game.uci');

  // Two fool's-mate games, each ends with White checkmated.
  const results = e.filter((x) => x.k === 'result') as Extract<Emit, { k: 'result' }>[];
  assert.deepEqual(results.map((r) => r.result), ['0-1', '0-1']);

  // Two startpos initial positions (one per game).
  const inits = e.filter((x) => x.k === 'init') as Extract<Emit, { k: 'init' }>[];
  assert.equal(inits.length, 2);
  for (const i of inits) assert.equal(i.fen, STARTPOS_TRUNC);

  // Game-2 boundary order: result(game1) -> players(game2) -> init(game2) -> first move.
  const players2 = idx(e, 'players')[1];
  const init2 = idx(e, 'init')[1];
  const result1 = idx(e, 'result')[0];
  assert.ok(result1 < players2, 'game-1 result precedes game-2 players');
  assert.ok(players2 < init2, 'game-2 players precede game-2 init FEN');

  // No move is emitted between the game-2 players and its first move except via init,
  // and that first move restarts at move number 1.
  const firstMove2 = e.findIndex((x, i) => i > init2 && x.k === 'move');
  const fm = e[firstMove2] as Extract<Emit, { k: 'move' }>;
  assert.ok(init2 < firstMove2, 'game-2 init precedes first move');
  assert.deepEqual({ n: fm.n, san: fm.san, color: fm.color }, { n: 1, san: 'f3', color: 'w' });
});

// ----------------------------------------------------- tagged (fastchess) stream

test('fastchess multi-game: player names + colors swap between games', () => {
  const e = drive(new FastchessSource(), 'fastchess-multigame.log');

  // Game 1: EngA white / EngB black. Game 2 swaps to EngB white / EngA black.
  const players = e.filter((x) => x.k === 'players') as Extract<Emit, { k: 'players' }>[];
  assert.deepEqual(
    players.map((p) => ({ white: p.white, black: p.black })),
    [
      { white: 'EngA', black: 'EngB' },
      { white: 'EngB', black: 'EngA' },
    ],
  );

  // Both games end in a mate -> 0-1 (White mated).
  const results = e.filter((x) => x.k === 'result') as Extract<Emit, { k: 'result' }>[];
  assert.deepEqual(results.map((r) => r.result), ['0-1', '0-1']);

  // Players are emitted before any move of each game (node-tlcv resetMoves invariant).
  const players2 = idx(e, 'players')[1];
  const firstMove2 = e.findIndex((x, i) => i > players2 && x.k === 'move');
  assert.ok(players2 < firstMove2, 'game-2 players precede its first move');
  assert.ok(
    !e.slice(0, players2).some((x, i) => x.k === 'move' && i > idx(e, 'result')[0]),
    'no game-2 move precedes the game-2 players',
  );
  const fm = e[firstMove2] as Extract<Emit, { k: 'move' }>;
  assert.deepEqual({ n: fm.n, san: fm.san }, { n: 1, san: 'f3' });

  // SITE is emitted exactly once for the whole run.
  assert.equal(e.filter((x) => x.k === 'site').length, 1);
});

test('fastchess multi-token names: full names survive and moves are emitted', () => {
  const e = drive(new FastchessSource(), 'fastchess-multitoken.log');

  // The configured names keep their spaces / version / commit hash verbatim.
  const players = e.filter((x) => x.k === 'players') as Extract<Emit, { k: 'players' }>[];
  assert.deepEqual(
    players.map((p) => ({ white: p.white, black: p.black })),
    [{ white: 'Berserk A', black: 'Berserk 14 v2-rc.1 a4994ff' }],
  );

  // Regression (gaps.md I): single-token name capture dropped every engine line, so 0
  // moves were emitted. A real game now yields its full move list and a board result.
  const moves = e.filter((x) => x.k === 'move') as Extract<Emit, { k: 'move' }>[];
  assert.equal(moves.length, 4);
  assert.deepEqual(moves.map((m) => m.san), ['f3', 'e5', 'g4', 'Qh4#']);

  const results = e.filter((x) => x.k === 'result') as Extract<Emit, { k: 'result' }>[];
  assert.deepEqual(results.map((r) => r.result), ['0-1']);
});

// ----------------------------------------------- adjudicated end (no board result)

test('adjudicated game synthesizes result:* before the next game starts', () => {
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite' });

  const lines: NormalizedLine[] = [
    // Game 1 — ends with no checkmate (adjudicated away), so no board result.
    { uci: 'ucinewgame', engineId: 'EngA', direction: 'in' },
    { uci: 'ucinewgame', engineId: 'EngB', direction: 'in' },
    { uci: 'position startpos', engineId: 'EngA', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngA', direction: 'in' },
    { uci: 'bestmove e2e4', engineId: 'EngA', direction: 'out' },
    { uci: 'position startpos moves e2e4', engineId: 'EngB', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' },
    { uci: 'bestmove e7e5', engineId: 'EngB', direction: 'out' },
    // Game 2 — swapped colors.
    { uci: 'ucinewgame', engineId: 'EngB', direction: 'in' },
    { uci: 'ucinewgame', engineId: 'EngA', direction: 'in' },
    { uci: 'position startpos', engineId: 'EngB', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' },
    { uci: 'bestmove d2d4', engineId: 'EngB', direction: 'out' },
  ];
  for (const n of lines) pipeline.handleLine(n);

  const e = sink.emits;
  const synth = idx(e, 'result')[0];
  const players2 = idx(e, 'players')[1];
  assert.equal((e[synth] as Extract<Emit, { k: 'result' }>).result, '*');
  assert.ok(synth < players2, 'synthesized result precedes game-2 players');
  assert.deepEqual(
    e.filter((x) => x.k === 'players').map((p) => (p as Extract<Emit, { k: 'players' }>).white),
    ['EngA', 'EngB'],
  );
});

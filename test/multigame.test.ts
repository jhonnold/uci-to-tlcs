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
  | { k: 'cur'; fen: string; fmr: number }
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
  emitCurrentPosition(fen: string, fmr: number) {
    this.emits.push({ k: 'cur', fen, fmr });
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

// ------------------------------------------------- mid-game resync (bridge --from-end)

const FEN_AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq';
const FEN_AFTER_E4_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq';

test('resync (odd move count): black parity-bound, position published before names arrive', () => {
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite' });

  const lines: NormalizedLine[] = [
    // Bridge starts mid-game: 1 ply played, Black to move -> EngB is Black.
    { uci: 'position startpos moves e2e4', engineId: 'EngB', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' },
    { uci: 'bestmove e7e5', engineId: 'EngB', direction: 'out' },
    { uci: 'position startpos moves e2e4 e7e5', engineId: 'EngA', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngA', direction: 'in' },
    { uci: 'bestmove g1f3', engineId: 'EngA', direction: 'out' },
  ];
  for (const n of lines) pipeline.handleLine(n);

  const e = sink.emits;

  // The current position is the very first thing published (before any names),
  // so a client LOGONing during the binding gap already has the board.
  assert.equal(e[0].k, 'cur');
  assert.deepEqual({ fen: (e[0] as Extract<Emit, { k: 'cur' }>).fen, fmr: (e[0] as Extract<Emit, { k: 'cur' }>).fmr }, { fen: FEN_AFTER_E4, fmr: 0 });

  const players = e.filter((x) => x.k === 'players') as Extract<Emit, { k: 'players' }>[];
  assert.equal(players.length, 2);
  // Backstop header (first bestmove) carries the parity-bound black + fallback white,
  // and still precedes the first move (resetMoves invariant).
  assert.deepEqual(players[0], { k: 'players', white: 'White', black: 'EngB' });
  const firstPlayers = idx(e, 'players')[0];
  const firstMove = idx(e, 'move')[0];
  assert.ok(firstPlayers < firstMove, 'backstop players precede first move');
  // Once White's identity lands (its first `go`), the real names are re-sent.
  assert.deepEqual(players[1], { k: 'players', white: 'EngA', black: 'EngB' });
  assert.ok(idx(e, 'players')[1] > firstMove, 'corrected players arrive after the join-point move');

  // Moves continue from the join point.
  const moves = e.filter((x) => x.k === 'move') as Extract<Emit, { k: 'move' }>[];
  assert.deepEqual(
    moves.map((m) => ({ n: m.n, san: m.san, color: m.color })),
    [
      { n: 1, san: 'e5', color: 'b' },
      { n: 2, san: 'Nf3', color: 'w' },
    ],
  );
});

test('resync (even move count): white parity-bound, then black binds at its first go', () => {
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite' });

  const lines: NormalizedLine[] = [
    // 2 plies played, White to move -> EngA is White.
    { uci: 'position startpos moves e2e4 e7e5', engineId: 'EngA', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngA', direction: 'in' },
    { uci: 'bestmove g1f3', engineId: 'EngA', direction: 'out' },
    { uci: 'position startpos moves e2e4 e7e5 g1f3', engineId: 'EngB', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' },
    { uci: 'bestmove b8c6', engineId: 'EngB', direction: 'out' },
  ];
  for (const n of lines) pipeline.handleLine(n);

  const e = sink.emits;
  assert.equal(e[0].k, 'cur');
  assert.equal((e[0] as Extract<Emit, { k: 'cur' }>).fen, FEN_AFTER_E4_E5);

  const players = e.filter((x) => x.k === 'players') as Extract<Emit, { k: 'players' }>[];
  assert.equal(players.length, 2);
  assert.deepEqual(players[0], { k: 'players', white: 'EngA', black: 'Black' });
  assert.deepEqual(players[1], { k: 'players', white: 'EngA', black: 'EngB' });
  assert.ok(idx(e, 'players')[1] > idx(e, 'move')[0], 'corrected players arrive after the join-point move');
});

test('resync (untagged): header with CLI names at the first position', () => {
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite' });

  pipeline.handleLine({ uci: 'position startpos moves e2e4 e7e5' });
  pipeline.handleLine({ uci: 'bestmove g1f3' });

  const e = sink.emits;
  assert.equal(e.filter((x) => x.k === 'cur').length, 0, 'untagged resync uses the header path, not a bare position');
  assert.equal(e[0].k, 'site');
  const players = e.filter((x) => x.k === 'players') as Extract<Emit, { k: 'players' }>[];
  assert.deepEqual(players, [{ k: 'players', white: 'White', black: 'Black' }]);
  const init = e.find((x) => x.k === 'init') as Extract<Emit, { k: 'init' }>;
  assert.equal(init.fen, FEN_AFTER_E4_E5);
  const moves = e.filter((x) => x.k === 'move') as Extract<Emit, { k: 'move' }>[];
  assert.deepEqual(moves.map((m) => m.san), ['Nf3']);
});

test('resync after orphan bestmove (bridge starts between position and bestmove): no replay from move 1', () => {
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite' });

  const lines: NormalizedLine[] = [
    // The bridge's first line is a `bestmove` whose `position` was already written —
    // and one that is even legal from startpos, the nastiest case.
    { uci: 'bestmove e2e4', engineId: 'EngA', direction: 'out' },
    // First real position: 2 plies, White to move -> EngA is White.
    { uci: 'position startpos moves e2e4 e7e5', engineId: 'EngA', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngA', direction: 'in' },
    { uci: 'bestmove g1f3', engineId: 'EngA', direction: 'out' },
    { uci: 'position startpos moves e2e4 e7e5 g1f3', engineId: 'EngB', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' },
    { uci: 'bestmove b8c6', engineId: 'EngB', direction: 'out' },
  ];
  for (const n of lines) pipeline.handleLine(n);

  const e = sink.emits;

  // The resync position is the very first emit: the orphan bestmove started nothing.
  assert.equal(e[0].k, 'cur');
  assert.equal((e[0] as Extract<Emit, { k: 'cur' }>).fen, FEN_AFTER_E4_E5);
  const init = e.find((x) => x.k === 'init') as Extract<Emit, { k: 'init' }>;
  assert.equal(init.fen, FEN_AFTER_E4_E5, 'header FEN is the join position, not startpos');

  // Names: backstop (parity white + fallback black) then the corrected real pair.
  const players = e.filter((x) => x.k === 'players') as Extract<Emit, { k: 'players' }>[];
  assert.deepEqual(players, [
    { k: 'players', white: 'EngA', black: 'Black' },
    { k: 'players', white: 'EngA', black: 'EngB' },
  ]);

  // Moves continue from the join point — no e4/e5 replay.
  const moves = e.filter((x) => x.k === 'move') as Extract<Emit, { k: 'move' }>[];
  assert.deepEqual(moves.map((m) => ({ n: m.n, san: m.san, color: m.color })), [
    { n: 2, san: 'Nf3', color: 'w' },
    { n: 2, san: 'Nc6', color: 'b' },
  ]);
});

// ------------------------------------------------------ finished-games record

test('finished games are recorded with PGN numbers from meta.gameNumber', () => {
  const sink = new RecordingSink();
  const starts: number[] = [];
  const pipeline = new Pipeline(sink, {
    white: 'White',
    black: 'Black',
    site: 'TestSite',
    gameNumber: 41,
    onGameStart: (n) => starts.push(n),
  });

  // Game 1 (EngA white): fool's mate.
  const g1: NormalizedLine[] = [
    { uci: 'ucinewgame', engineId: 'EngA', direction: 'in' },
    { uci: 'ucinewgame', engineId: 'EngB', direction: 'in' },
    { uci: 'position startpos', engineId: 'EngA', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngA', direction: 'in' },
    { uci: 'bestmove f2f3', engineId: 'EngA', direction: 'out' },
    { uci: 'position startpos moves f2f3', engineId: 'EngB', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' },
    { uci: 'bestmove e7e5', engineId: 'EngB', direction: 'out' },
    { uci: 'position startpos moves f2f3 e7e5', engineId: 'EngA', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngA', direction: 'in' },
    { uci: 'bestmove g2g4', engineId: 'EngA', direction: 'out' },
    { uci: 'position startpos moves f2f3 e7e5 g2g4', engineId: 'EngB', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' },
    { uci: 'bestmove d8h4', engineId: 'EngB', direction: 'out' },
  ];
  for (const n of g1) pipeline.handleLine(n);

  assert.equal(pipeline.currentGameNumber, 41);
  assert.equal(pipeline.finishedGames().length, 0, 'game still open before its boundary');

  // Game 2 opens: game 1 closes (checkmated) and is recorded as PGN game 41.
  pipeline.handleLine({ uci: 'ucinewgame', engineId: 'EngB', direction: 'in' });
  pipeline.handleLine({ uci: 'ucinewgame', engineId: 'EngA', direction: 'in' });
  pipeline.handleLine({ uci: 'position startpos', engineId: 'EngB', direction: 'in' });
  pipeline.handleLine({ uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' });

  assert.deepEqual(pipeline.finishedGames(), [
    { number: 41, white: 'EngA', black: 'EngB', result: '0-1' },
  ]);
  assert.equal(pipeline.currentGameNumber, 42);
  assert.deepEqual(starts, [41, 42]);
});

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

// ------------------------------------------------- review regressions (PR #4 follow-up)

test('resync that never completes its bind does not swallow the next game boundary', () => {
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite' });

  const lines: NormalizedLine[] = [
    // Join mid-game on what turns out to be the game's LAST search: 3 plies played, Black
    // to move -> EngB is Black. Its reply is mate, so EngA never issues a tagged `go` and
    // the second colour never binds — the case that used to latch the boundary gate.
    { uci: 'position startpos moves f2f3 e7e5 g2g4', engineId: 'EngB', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' },
    { uci: 'bestmove d8h4', engineId: 'EngB', direction: 'out' },
    // Game 2, colours swapped (-repeat). This boundary must be honoured.
    { uci: 'ucinewgame', engineId: 'EngB', direction: 'in' },
    { uci: 'ucinewgame', engineId: 'EngA', direction: 'in' },
    { uci: 'position startpos', engineId: 'EngB', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' },
    { uci: 'bestmove d2d4', engineId: 'EngB', direction: 'out' },
  ];
  for (const n of lines) pipeline.handleLine(n);

  const e = sink.emits;
  const players = e.filter((x) => x.k === 'players') as Extract<Emit, { k: 'players' }>[];
  // Game 2 gets its own header with the swapped pair — not game 1's stale binding.
  assert.deepEqual(players[players.length - 1], { k: 'players', white: 'EngB', black: 'EngA' });
  // Game 2 starts from startpos, i.e. the boundary really reset the board.
  const inits = e.filter((x) => x.k === 'init') as Extract<Emit, { k: 'init' }>[];
  assert.equal(inits[inits.length - 1].fen, STARTPOS_TRUNC);
  // Game 1 was closed and recorded with its real (parity-bound) black.
  assert.deepEqual(pipeline.finishedGames(), [{ number: 1, white: 'White', black: 'EngB', result: '0-1' }]);
});

test('info before the first position is dropped (orphan search on --from-end)', () => {
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite' });

  // The bridge attaches mid-search: `info` lines land before their `position` is seen.
  pipeline.handleLine({ uci: 'info depth 12 score cp 34 nodes 1000 time 50 pv d2d4 d7d5 c2c4', engineId: 'EngA', direction: 'out' });
  assert.equal(sink.emits.length, 0, 'no PV against the untouched startpos board');

  // Once the real position lands, PVs flow again — scored from the right side to move.
  pipeline.handleLine({ uci: 'position startpos moves e2e4', engineId: 'EngB', direction: 'in' });
  pipeline.handleLine({ uci: 'info depth 12 score cp 20 nodes 1000 time 50 pv e7e5', engineId: 'EngB', direction: 'out' });
  const pvs = sink.emits.filter((x) => x.k === 'pv') as Extract<Emit, { k: 'pv' }>[];
  assert.deepEqual(pvs.map((p) => ({ color: p.color, pv: p.pv })), [{ color: 'b', pv: ['e5'] }]);
});

test('opening-book game (boundary already seen) emits one FEN, not a duplicate', () => {
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite' });

  const lines: NormalizedLine[] = [
    { uci: 'ucinewgame', engineId: 'EngA', direction: 'in' },
    { uci: 'ucinewgame', engineId: 'EngB', direction: 'in' },
    // fastchess opening book: the game's first position already carries two book plies.
    { uci: 'position startpos moves e2e4 e7e5', engineId: 'EngA', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngA', direction: 'in' },
    { uci: 'bestmove g1f3', engineId: 'EngA', direction: 'out' },
  ];
  for (const n of lines) pipeline.handleLine(n);

  const e = sink.emits;
  assert.equal(e.filter((x) => x.k === 'cur').length, 0, 'book position is not a resync');
  const inits = e.filter((x) => x.k === 'init') as Extract<Emit, { k: 'init' }>[];
  assert.equal(inits.length, 1);
  assert.equal(inits[0].fen, FEN_AFTER_E4_E5, 'header carries the book position');
  // White still binds from `go` order (parity is a resync-only shortcut).
  const players = e.filter((x) => x.k === 'players') as Extract<Emit, { k: 'players' }>[];
  assert.deepEqual(players, [{ k: 'players', white: 'EngA', black: 'EngB' }]);
});

test('currentGame(): the open game is visible before its boundary closes it', () => {
  const sink = new RecordingSink();
  const pipeline = new Pipeline(sink, { white: 'White', black: 'Black', site: 'TestSite', gameNumber: 7 });

  assert.equal(pipeline.currentGame(), undefined, 'no game before the first header');

  const g1: NormalizedLine[] = [
    { uci: 'ucinewgame', engineId: 'EngA', direction: 'in' },
    { uci: 'ucinewgame', engineId: 'EngB', direction: 'in' },
    { uci: 'position startpos', engineId: 'EngA', direction: 'in' },
    { uci: 'go wtime 1000 btime 1000', engineId: 'EngA', direction: 'in' },
    { uci: 'bestmove e2e4', engineId: 'EngA', direction: 'out' },
  ];
  for (const n of g1) pipeline.handleLine(n);

  // Open and in progress: absent from finishedGames(), present as `*`.
  assert.deepEqual(pipeline.finishedGames(), []);
  assert.deepEqual(pipeline.currentGame(), { number: 7, white: 'EngA', black: 'EngB', result: '*' });

  // At the next boundary it moves to the finished record and the new game becomes open.
  pipeline.handleLine({ uci: 'ucinewgame', engineId: 'EngB', direction: 'in' });
  pipeline.handleLine({ uci: 'ucinewgame', engineId: 'EngA', direction: 'in' });
  assert.deepEqual(pipeline.finishedGames(), [{ number: 7, white: 'EngA', black: 'EngB', result: '*' }]);
  assert.equal(pipeline.currentGame(), undefined, 'game 8 has no header yet');
});

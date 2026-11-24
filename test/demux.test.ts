import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Pipeline, type BroadcastSink } from '../src/pipeline.js';
import { Demux } from '../src/demux.js';
import { FastchessSource } from '../src/source/fastchess-source.js';
import { RawUciSource } from '../src/source/raw-source.js';
import type { LogSource, NormalizedLine } from '../src/source/log-source.js';
import type { ColorCode } from '../src/tlcs/protocol.js';

/** Every sink call, serialized, so two runs can be compared exactly. */
class Rec implements BroadcastSink {
  calls: string[] = [];
  setSite(s: string) {
    this.calls.push(`site ${s}`);
  }
  setPlayers(w: string, b: string) {
    this.calls.push(`players ${w} | ${b}`);
  }
  emitInitialPosition(f: string, fmr: number) {
    this.calls.push(`init ${f} ${fmr}`);
  }
  emitMove(a: { fenTruncated: string; color: ColorCode; fullMoveNumber: number; san: string; fmr: number }) {
    this.calls.push(`move ${a.color} ${a.fullMoveNumber} ${a.san} ${a.fenTruncated} ${a.fmr}`);
  }
  emitClocks(w: number, b: number) {
    this.calls.push(`clocks ${w} ${b}`);
  }
  emitPv(c: ColorCode, d: number, s: number, t: number, n: number, pv: string[]) {
    this.calls.push(`pv ${c} ${d} ${s} ${t} ${n} ${pv.join(' ')}`);
  }
  emitResult(r: string, g?: number) {
    this.calls.push(`result ${r} ${g ?? ''}`);
  }
  emitLevel(t: string) {
    this.calls.push(`level ${t}`);
  }
}

const META = { white: 'White', black: 'Black', site: 'S' };
const mk = (sink: BroadcastSink) => new Pipeline(sink, META, { pvIntervalMs: 0 });
const fixture = (f: string) => readFileSync(fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url)), 'utf8').split('\n');

function normalized(source: LogSource, lines: string[]): NormalizedLine[] {
  return lines.flatMap((l) => {
    const n = source.normalize(l);
    return n ? [n] : [];
  });
}

/** Feed lines through a Demux; returns the per-board recorded calls (index = board id). */
function viaDemux(lines: NormalizedLine[]): { boards: Rec[]; added: number[]; demux: Demux } {
  const boards: Rec[] = [];
  const added: number[] = [];
  const demux = new Demux(
    (id) => {
      boards[id] = new Rec();
      return mk(boards[id]);
    },
    { onBoardAdded: (id) => added.push(id) },
  );
  for (const n of lines) demux.handleLine(n);
  return { boards, added, demux };
}

/** Feed lines through one plain Pipeline (today's behaviour). */
function viaPipeline(lines: NormalizedLine[]): string[] {
  const r = new Rec();
  const p = mk(r);
  for (const n of lines) p.handleLine({ ...n, channel: undefined });
  return r.calls;
}

/** A synthetic fastchess engine line on worker thread `ch`. */
const T = (ch: string, eng: string, dir: 'in' | 'out', uci: string) =>
  `[Engine] [00:00:00.000000] <${ch.padStart(20)}>  ${eng} ${dir === 'in' ? '<---' : '--->'} ${uci}`;

/** Fool's mate on thread `ch` between engines w and b (ends on the board: result 0-1). */
function foolsMate(ch: string, w: string, b: string): string[] {
  const moves = ['f2f3', 'e7e5', 'g2g4', 'd8h4'];
  const out = [T(ch, w, 'in', 'ucinewgame'), T(ch, b, 'in', 'ucinewgame')];
  moves.forEach((m, i) => {
    const eng = i % 2 === 0 ? w : b;
    const pre = moves.slice(0, i);
    out.push(T(ch, eng, 'in', pre.length ? `position startpos moves ${pre.join(' ')}` : 'position startpos'));
    out.push(T(ch, eng, 'in', 'go wtime 1000 btime 1000'));
    out.push(T(ch, eng, 'out', `bestmove ${m}`));
  });
  return out;
}

/** The first half of a game (no result) on thread `ch`. */
function opening(ch: string, w: string, b: string): string[] {
  return foolsMate(ch, w, b).slice(0, 8);
}

// ------------------------------------------------------------------ real concurrent log

test('concurrent fastchess log: one board per worker thread, each equal to that thread alone', () => {
  const lines = normalized(new FastchessSource(), fixture('fastchess-concurrent.log'));
  const { boards, added } = viaDemux(lines);
  assert.deepEqual(added, [2, 3]);
  assert.equal(boards.length - 1, 3);

  // Board ids follow the order threads open their first game.
  const order: string[] = [];
  for (const n of lines) {
    if (n.direction === 'in' && n.uci === 'ucinewgame' && n.channel && !order.includes(n.channel)) order.push(n.channel);
  }
  assert.equal(order.length, 3);
  order.forEach((ch, i) => {
    const alone = viaPipeline(lines.filter((n) => n.channel === ch));
    // site is broadcast-scoped: every board's Pipeline emits it once, as a lone Pipeline does
    assert.deepEqual(boards[i + 1].calls, alone, `board ${i + 1} (thread ${ch})`);
  });

  // 6 games in the log, all shown.
  const games = [1, 2, 3].map((b) => boards[b].calls.filter((c) => c.startsWith('players')).length);
  assert.equal(games.reduce((a, x) => a + x, 0), 6);
});

test('single-channel fastchess log: board 1 only, identical to a plain Pipeline', () => {
  const lines = normalized(new FastchessSource(), fixture('fastchess-adjudicated.log'));
  const { boards, added } = viaDemux(lines);
  assert.deepEqual(added, []);
  assert.deepEqual(boards[1].calls, viaPipeline(lines));
});

test('two runs appended to one log (different thread ids): every game stays on board 1', () => {
  // fastchess quits every engine from its main thread at the end of a run, also at
  // -concurrency 1 (measured, fastchess 1.8.2); this fixture was cut before that teardown.
  const run1 = [...fixture('fastchess-adjudicated.log'), T('777', 'BerserkA', 'in', 'quit'), T('777', 'Berserk B', 'in', 'quit')];
  const run2 = fixture('fastchess-multigame.log'); // thread id 1, a different run
  const lines = normalized(new FastchessSource(), [...run1, ...run2]);
  assert.ok(new Set(lines.map((n) => n.channel)).size >= 2, 'fixture really has two thread ids');
  const { boards, added } = viaDemux(lines);
  assert.deepEqual(added, []);
  assert.deepEqual(boards[1].calls, viaPipeline(lines));
});

test('untagged raw transcript: board 1 only, identical to a plain Pipeline', () => {
  const lines = normalized(new RawUciSource(), fixture('multi-game.uci'));
  const { boards, added } = viaDemux(lines);
  assert.deepEqual(added, []);
  assert.deepEqual(boards[1].calls, viaPipeline(lines));
});

// ------------------------------------------------------------------ slot allocation

test('slot reuse: a new thread takes an idle board; a busy board forces a new one', () => {
  const src = new FastchessSource();
  const lines = normalized(src, [
    ...foolsMate('10', 'A', 'B'), // board 1, finished
    ...opening('20', 'C', 'D'), // board 1 is idle -> reused
    ...opening('30', 'E', 'F'), // board 1 busy -> board 2
  ]);
  const { boards, added } = viaDemux(lines);
  assert.deepEqual(added, [2]);
  assert.deepEqual(
    boards[1].calls.filter((c) => c.startsWith('players')),
    ['players A | B', 'players C | D'],
  );
  assert.deepEqual(boards[2].calls.filter((c) => c.startsWith('players')), ['players E | F']);
});

test('slot reuse: a thread keeps its own board for its next game', () => {
  const src = new FastchessSource();
  const lines = normalized(src, [
    ...opening('10', 'A', 'B'), // board 1
    ...opening('20', 'C', 'D'), // board 2
    ...foolsMate('10', 'B', 'A').slice(0), // thread 10's next game: board 1 again
  ]);
  const { boards } = viaDemux(lines);
  assert.deepEqual(
    boards[1].calls.filter((c) => c.startsWith('players') || c.startsWith('result')),
    ['players A | B', 'result * ', 'players B | A', 'result 0-1 '],
  );
  assert.deepEqual(boards[2].calls.filter((c) => c.startsWith('players')), ['players C | D']);
});

test('slot reuse: lowest idle board wins when a thread lost its own board', () => {
  const src = new FastchessSource();
  const lines = normalized(src, [
    ...opening('10', 'A', 'B'), // board 1
    ...foolsMate('20', 'C', 'D'), // board 2, finished
    ...foolsMate('30', 'E', 'F').slice(0, 2), // board 2 idle -> thread 30 takes board 2
  ]);
  const { boards, added } = viaDemux(lines);
  assert.deepEqual(added, [2]);
  assert.equal(boards[2].calls.filter((c) => c.startsWith('players')).length, 1); // E-F not bound yet (no go)
  assert.equal(boards[3], undefined);
});

test('a quit on an unknown thread (fastchess teardown) reaches every board and frees them', () => {
  const src = new FastchessSource();
  const lines = normalized(src, [
    ...opening('10', 'A', 'B'), // board 1, unfinished
    ...opening('20', 'C', 'D'), // board 2, unfinished
    T('99', 'A', 'in', 'quit'),
    ...opening('40', 'G', 'H'), // next run: board 1 (freed by the teardown)
  ]);
  const { boards, added } = viaDemux(lines);
  assert.deepEqual(added, [2]);
  assert.deepEqual(
    boards[1].calls.filter((c) => c.startsWith('players') || c.startsWith('result')),
    ['players A | B', 'result * ', 'players G | H'],
  );
});

test('lines of a thread that never opened a game are dropped', () => {
  const src = new FastchessSource();
  const lines = normalized(src, [T('5', 'A', 'out', 'id name Berserk'), T('5', 'A', 'in', 'stop'), ...opening('10', 'A', 'B')]);
  const { boards, added } = viaDemux(lines);
  assert.deepEqual(added, []);
  assert.equal(boards[1].calls.filter((c) => c.startsWith('players')).length, 1);
});

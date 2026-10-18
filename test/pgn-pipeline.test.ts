import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Pipeline, type BroadcastSink, type ResultAuthority } from '../src/pipeline.js';
import { RawUciSource } from '../src/source/raw-source.js';
import { makeSource } from '../src/source/index.js';
import type { NormalizedLine } from '../src/source/log-source.js';
import type { FinishedGame } from '../src/results/registry.js';
import { logger } from '../src/util/logger.js';

type Emit = { k: 'players' | 'init' | 'move' | 'result' | 'other'; v?: string };

class Rec implements BroadcastSink {
  emits: Emit[] = [];
  setSite() {}
  setPlayers(w: string, b: string) { this.emits.push({ k: 'players', v: `${w}|${b}` }); }
  emitInitialPosition() { this.emits.push({ k: 'init' }); }
  emitMove(a: { san: string }) { this.emits.push({ k: 'move', v: a.san }); }
  emitClocks() {}
  emitPv() {}
  emitResult(r: string) { this.emits.push({ k: 'result', v: r }); }
  results() { return this.emits.filter((e) => e.k === 'result').map((e) => e.v); }
}

class Fake implements ResultAuthority {
  m = new Map<number, FinishedGame>();
  refreshes = 0;
  lookups: number[] = [];
  onRefresh?: () => void;
  lookup(n: number) { this.lookups.push(n); return this.m.get(n); }
  refresh() { this.refreshes++; this.onRefresh?.(); }
  add(n: number, o: Partial<FinishedGame> & { result: string }) {
    this.m.set(n, { number: n, white: 'BerserkA', black: 'Berserk B', headers: {}, ...o });
  }
}

const fixText = readFileSync(new URL('../fixtures/fastchess-adjudicated.log', import.meta.url), 'utf8');
const src = makeSource('fastchess');
const fixLines: NormalizedLine[] = fixText.split('\n').flatMap((l) => { const n = src.normalize(l); return n ? [n] : []; });
// index (in fixLines) of the k-th (1-based) bestmove line
const bestIdx = fixLines.flatMap((n, i) => (n.direction === 'out' && n.uci?.startsWith('bestmove') ? [i] : []));
const newGameIdx = fixLines.flatMap((n, i) => (n.direction === 'in' && n.uci?.trim() === 'ucinewgame' ? [i] : []));
// first line of game 2 after its header is emitted (first `go` after game 2's first ucinewgame)
const g2go = fixLines.findIndex((n, i) => i > newGameIdx[2] && n.direction === 'in' && n.uci?.startsWith('go')) + 1;
const QUIT: NormalizedLine = { uci: 'quit', engineId: 'BerserkA', direction: 'in' };

function mk(auth?: Fake, extra: { holdTicks?: number; firstGameNumber?: number | (() => number) } = {}) {
  const sink = new Rec();
  const p = new Pipeline(sink, { white: 'White', black: 'Black', site: 's' }, auth ? { authority: auth, ...extra } : extra);
  return { sink, p };
}
const feed = (p: Pipeline, from: number, to: number) => { for (let i = from; i < to; i++) p.handleLine(fixLines[i]); };

function warnings() {
  const orig = logger.warn;
  const msgs: string[] = [];
  logger.warn = (m: string) => void msgs.push(m);
  return { msgs, restore: () => void (logger.warn = orig) };
}

// ---- synthetic tagged logs
let ts = 0;
const L = (e: string, dir: 'in' | 'out', s: string): NormalizedLine => ({ uci: s, engineId: e, direction: dir });
function mateGame(): NormalizedLine[] {
  // fool's mate, A white
  return [
    L('A', 'in', 'ucinewgame'), L('B', 'in', 'ucinewgame'),
    L('A', 'in', 'position startpos'), L('A', 'in', 'go wtime 1000 btime 1000'), L('A', 'out', 'bestmove f2f3'),
    L('B', 'in', 'position startpos moves f2f3'), L('B', 'in', 'go wtime 1000 btime 1000'), L('B', 'out', 'bestmove e7e5'),
    L('A', 'in', 'position startpos moves f2f3 e7e5'), L('A', 'in', 'go wtime 1000 btime 1000'), L('A', 'out', 'bestmove g2g4'),
    L('B', 'in', 'position startpos moves f2f3 e7e5 g2g4'), L('B', 'in', 'go wtime 1000 btime 1000'), L('B', 'out', 'bestmove d8h4'),
  ];
}
void ts;

test('1. replay: one authoritative result per game, none are *, game-1 result precedes game-2 players', () => {
  const a = new Fake();
  a.add(1, { result: '1-0', plyCount: 70, termination: 'adjudication' });
  a.add(2, { result: '0-1', plyCount: 63, white: 'Berserk B', black: 'BerserkA', termination: 'adjudication' });
  const { sink, p } = mk(a);
  feed(p, 0, fixLines.length);
  assert.deepEqual(sink.results(), ['1-0', '0-1']);
  const r1 = sink.emits.findIndex((e) => e.k === 'result');
  const pl = sink.emits.flatMap((e, i) => (e.k === 'players' ? [i] : []));
  assert.ok(r1 < pl[1]);
  assert.equal(sink.emits.slice(0, r1).filter((e) => e.k === 'move').length, 70, 'result right after ply 70');
  // baseline: no authority
  const base = mk();
  feed(base.p, 0, fixLines.length);
  assert.deepEqual(base.sink.results(), ['*']);
});

test('2. gate fires at PlyCount; misaligned (shorter) PlyCount warns once on overrun, one result', () => {
  const w = warnings();
  try {
    const a = new Fake();
    a.add(1, { result: '1-0', plyCount: 69 });
    const { sink, p } = mk(a);
    feed(p, 0, bestIdx[67] + 1);
    assert.deepEqual(sink.results(), [], 'not before ply 69');
    feed(p, bestIdx[67] + 1, bestIdx[68] + 1);
    assert.deepEqual(sink.results(), ['1-0'], 'at ply 69');
    feed(p, bestIdx[68] + 1, bestIdx[69] + 1);
    assert.deepEqual(sink.results(), ['1-0']);
    assert.equal(w.msgs.filter((m) => /exceed PGN PlyCount/.test(m)).length, 1);
  } finally { w.restore(); }
});

test('3. late entry: tick sends it; the boundary sends nothing more', () => {
  const a = new Fake();
  const { sink, p } = mk(a);
  feed(p, 0, newGameIdx[2]);
  assert.deepEqual(sink.results(), []);
  a.add(1, { result: '1-0', plyCount: 70 });
  p.onAuthorityTick();
  assert.deepEqual(sink.results(), ['1-0']);
  feed(p, newGameIdx[2], newGameIdx[2] + 5);
  assert.deepEqual(sink.results(), ['1-0']);
});

test('4. boundary pull: entry appears only at refresh(); sent once before next players', () => {
  const a = new Fake();
  a.onRefresh = () => a.add(1, { result: '1-0', plyCount: 999 }); // gate would never fire
  const { sink, p } = mk(a);
  const w = warnings();
  try {
    feed(p, 0, g2go);
    assert.deepEqual(sink.results(), ['1-0']);
    const ri = sink.emits.findIndex((e) => e.k === 'result');
    const pl = sink.emits.flatMap((e, i) => (e.k === 'players' ? [i] : []));
    assert.ok(ri < pl[1]);
  } finally { w.restore(); }
});

test('5. missing at boundary: fallback * with warning; a later add+tick sends no second result', () => {
  const w = warnings();
  try {
    const a = new Fake();
    const { sink, p } = mk(a);
    feed(p, 0, newGameIdx[2] + 4);
    assert.deepEqual(sink.results(), ['*']);
    assert.ok(w.msgs.some((m) => /no PGN entry for game 1; fallback \*/.test(m)));
    a.add(1, { result: '1-0', plyCount: 70 });
    p.onAuthorityTick();
    assert.deepEqual(sink.results(), ['*']);
  } finally { w.restore(); }
});

test('6/7. board mate in PGN mode: held until the entry; hold timeout sends board result once', () => {
  const w = warnings();
  try {
    const a = new Fake();
    const { sink, p } = mk(a, { holdTicks: 3 });
    for (const l of mateGame()) p.handleLine(l);
    assert.deepEqual(sink.results(), []);
    p.onAuthorityTick(); p.onAuthorityTick();
    assert.deepEqual(sink.results(), []);
    p.onAuthorityTick();
    assert.deepEqual(sink.results(), ['0-1']);
    assert.equal(w.msgs.filter((m) => /not seen after/.test(m)).length, 1);
    a.add(1, { result: '0-1', plyCount: 4, white: 'A', black: 'B' });
    p.onAuthorityTick(); p.onAuthorityTick();
    assert.deepEqual(sink.results(), ['0-1']);

    // entry arrives before the hold expires: sent once, hold never fires
    const b = new Fake();
    const m2 = mk(b, { holdTicks: 3 });
    for (const l of mateGame()) m2.p.handleLine(l);
    b.add(1, { result: '0-1', plyCount: 4, white: 'A', black: 'B' });
    m2.p.onAuthorityTick(); m2.p.onAuthorityTick(); m2.p.onAuthorityTick(); m2.p.onAuthorityTick();
    assert.deepEqual(m2.sink.results(), ['0-1']);
  } finally { w.restore(); }
});

test('8. quit: final pull sends the entry with shortfall warning; no entry => nothing, repeats nothing', () => {
  const w = warnings();
  try {
    const a = new Fake();
    const { sink, p } = mk(a);
    feed(p, 0, newGameIdx[2]);
    a.add(1, { result: '1-0', plyCount: 72 });
    p.onAuthorityTick();
    assert.deepEqual(sink.results(), []);
    p.handleLine(QUIT);
    assert.deepEqual(sink.results(), ['1-0']);
    assert.ok(w.msgs.some((m) => /only 70 plies seen/.test(m)));
    p.handleLine(QUIT); p.handleLine(QUIT);
    assert.deepEqual(sink.results(), ['1-0']);

    const b = new Fake();
    const m2 = mk(b);
    feed(m2.p, 0, newGameIdx[2]);
    m2.p.handleLine(QUIT); m2.p.handleLine(QUIT); m2.p.handleLine(QUIT);
    assert.deepEqual(m2.sink.results(), []);
  } finally { w.restore(); }
});

test('8b. mid-game quit with no entry is a no-op; entry + gate then gives exactly one result', () => {
  const a = new Fake();
  const { sink, p } = mk(a);
  feed(p, 0, bestIdx[30] + 1);
  p.handleLine(QUIT); // e.g. fastchess restart=on / recover
  assert.deepEqual(sink.results(), []);
  a.add(1, { result: '1-0', plyCount: 70 });
  feed(p, bestIdx[30] + 1, newGameIdx[2] + 4);
  assert.deepEqual(sink.results(), ['1-0']);
});

test('9. illegal move: PlyCount = plies+1 fires after the last applied move, no warning, last game too', () => {
  const w = warnings();
  try {
    const a = new Fake();
    a.add(1, { result: '0-1', plyCount: 71, termination: 'illegal move' });
    const { sink, p } = mk(a);
    feed(p, 0, bestIdx[69] + 1);
    assert.deepEqual(sink.results(), ['0-1']);
    assert.equal(w.msgs.length, 0);
    p.handleLine(QUIT);
    assert.deepEqual(sink.results(), ['0-1']);
  } finally { w.restore(); }
});

test('10. names: swapped names still gate+send, with a mismatch warning', () => {
  const w = warnings();
  try {
    const a = new Fake();
    a.add(1, { result: '1-0', plyCount: 70, white: 'Berserk B', black: 'BerserkA' });
    const { sink, p } = mk(a);
    feed(p, 0, bestIdx[69] + 1);
    assert.deepEqual(sink.results(), ['1-0']);
    assert.ok(w.msgs.some((m) => /differ from log/.test(m)));
  } finally { w.restore(); }
});

test('10b. stale PGN (names do not match): no mid-game gate; boundary still sends with warning', () => {
  const w = warnings();
  try {
    const a = new Fake();
    a.add(1, { result: '1-0', plyCount: 20, white: 'Old1', black: 'Old2' });
    const { sink, p } = mk(a);
    feed(p, 0, bestIdx[69] + 1);
    p.onAuthorityTick();
    assert.deepEqual(sink.results(), [], 'gate and tick deferred');
    feed(p, bestIdx[69] + 1, g2go);
    assert.deepEqual(sink.results(), ['1-0']);
    assert.ok(w.msgs.some((m) => /differ from log/.test(m)));
  } finally { w.restore(); }
});

test('11. numbering: firstGameNumber 5 -> 5,6; function called once; header backstop numbers', () => {
  const a = new Fake();
  const { p } = mk(a, { firstGameNumber: 5 });
  feed(p, 0, newGameIdx[0] + 1);
  assert.equal(p.currentGameNumber(), 5);
  feed(p, newGameIdx[0] + 1, bestIdx[71] + 1);
  assert.equal(p.currentGameNumber(), 6);
  assert.ok(a.lookups.includes(5) && a.lookups.includes(6));

  let calls = 0;
  const b = mk(new Fake(), { firstGameNumber: () => (calls++, 3) });
  assert.equal(calls, 0, 'lazy');
  feed(b.p, 0, fixLines.length);
  assert.equal(calls, 1);
  assert.equal(b.p.currentGameNumber(), 4);

  // header via onPosition/onBestMove (untagged, no ucinewgame)
  const raw = new RawUciSource();
  const c = mk(new Fake(), { firstGameNumber: 9 });
  for (const l of ['position startpos', 'go wtime 1 btime 1', 'bestmove e2e4']) { const n = raw.normalize(l); if (n) c.p.handleLine(n); }
  assert.equal(c.p.currentGameNumber(), 9);
});

test('12. ply invariant: position with prefix moves counts them; FEN start counts only moves', () => {
  // book prefix: startpos moves e2e4 e7e5, then A plays g1f3 -> 3 plies
  const mk1 = (positionCmd: string, best: string, ply: number) => {
    const a = new Fake();
    a.add(1, { result: '1-0', plyCount: ply, white: 'A', black: 'B' });
    const { sink, p } = mk(a);
    for (const l of [
      L('A', 'in', 'ucinewgame'), L('B', 'in', 'ucinewgame'),
      L('A', 'in', positionCmd), L('A', 'in', 'go wtime 1000 btime 1000'),
    ]) p.handleLine(l);
    assert.deepEqual(sink.results(), []);
    p.handleLine(L('A', 'out', `bestmove ${best}`));
    return sink.results();
  };
  assert.deepEqual(mk1('position startpos moves e2e4 e7e5', 'g1f3', 3), ['1-0']);
  assert.deepEqual(mk1('position fen rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'e2e4', 1), ['1-0']);
});

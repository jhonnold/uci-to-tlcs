import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planResume, numberingDump, ResumeSink, NUMBERING_HOLD_MS, type ResumeServer } from '../src/state/resume.js';
import type { FinishedGame } from '../src/results/registry.js';
import { logger } from '../src/util/logger.js';

function warnings() {
  const orig = logger.warn;
  const msgs: string[] = [];
  logger.warn = (m: string) => void msgs.push(m);
  return { msgs, done: () => void (logger.warn = orig) };
}

const starts = [0, 100, 200, 300, 400]; // K = 5
const base = { starts, end: 500, restored: [] as Array<number | undefined>, fromEnd: false, size: 520 };

test('planResume table', () => {
  // game K in progress (N = K-1), no restored clients
  let p = planResume({ ...base, finished: 4 });
  assert.deepEqual([p.offset, p.firstGame, p.current], [400, 5, 5]);
  // between games (N = K)
  p = planResume({ ...base, finished: 5 });
  assert.deepEqual([p.offset, p.firstGame, p.current], [500, 6, 6]);
  // restored next = K-1: ended during the outage
  p = planResume({ ...base, finished: 4, restored: [4] });
  assert.deepEqual([p.offset, p.firstGame, p.nexts], [300, 4, [4]]);
  // invalid nexts become current
  p = planResume({ ...base, finished: 4, restored: [undefined, 0, 11, 2.5] });
  assert.deepEqual(p.nexts, [5, 5, 5, 5]);
  assert.equal(p.firstGame, 5);
  // no PGN: last started game is current
  p = planResume({ ...base });
  assert.deepEqual([p.offset, p.firstGame], [400, 5]);
  // S = 1 starts at offset 0 (preamble)
  p = planResume({ ...base, starts: [50, 150], end: 300, finished: 1, restored: [1] });
  assert.deepEqual([p.offset, p.firstGame], [0, 1]);
  // no detected starts (raw log): legacy full replay
  p = planResume({ ...base, starts: [], end: 80, finished: 0, restored: [3] });
  assert.deepEqual([p.offset, p.firstGame, p.nexts], [0, 1, [1]]);
  // fromEnd
  p = planResume({ ...base, fromEnd: true, finished: 4 });
  assert.deepEqual([p.offset, p.firstGame, p.current], [520, undefined, undefined]);
});

test('planResume: finished > K warns and S = K+1', () => {
  const w = warnings();
  const p = planResume({ ...base, finished: 9 });
  w.done();
  assert.equal(p.current, 6);
  assert.match(w.msgs[0], /misaligned PGN/);
});

test('planResume: a client that missed more than 3 games replays only the last 3 (review NIT 1)', () => {
  const p = planResume({ ...base, starts: [0, 10, 20, 30, 40, 50, 60, 70], end: 90, finished: 7, restored: [2, 6, 5] });
  // K = 8, N = 7 -> current 8, floor 5
  assert.deepEqual(p.nexts, [5, 6, 5]);
  assert.deepEqual(p.clamped, [0]);
  assert.deepEqual([p.offset, p.firstGame], [40, 5]);
});

const g = (n: number, w = 'A', b = 'B', result = '1-0'): FinishedGame => ({ number: n, white: w, black: b, result, headers: {} }) as FinishedGame;

test('numberingDump: CTRESET then a single Game No. row for g-1; null without prior games', () => {
  assert.equal(numberingDump([g(1), g(2)], 1), null);
  const d = numberingDump([g(1), g(2), g(3)], 3)!;
  assert.equal(d[0], 'CTRESET');
  assert.ok(d.slice(1).every((l) => l.startsWith('CT:')));
  const rows = d.filter((l) => /^CT:\d+\s+\S/.test(l) && !/^CT:\d+\./.test(l));
  assert.equal(rows.length, 1);
  assert.match(rows[0], /^CT:2\s/);
});

test('numberingDump warns when the newest finished game is not g-1', () => {
  const w = warnings();
  numberingDump([g(1)], 3);
  w.done();
  assert.match(w.msgs[0], /newest finished is 1/);
});

// ---------------------------------------------------------------- ResumeSink

class FakeServer implements ResumeServer {
  calls: string[] = [];
  epoch = 0;
  clients = new Set<string>();
  held: string[] = [];
  addClient(ip: string, port: number) { this.calls.push(`add ${ip}:${port}`); this.clients.add(`${ip}:${port}`); return true; }
  getClient(d: string) { return this.clients.has(d) ? {} : undefined; }
  enqueue(dest: string | null, body: string, opts?: { holdMs?: number }) {
    this.calls.push(`enq ${dest} ${body.slice(0, 12)}${opts?.holdMs ? ` hold${opts.holdMs}` : ''}`);
    if (opts?.holdMs) this.held.push(body);
  }
  currentEpoch() { return this.epoch; }
  setSite() {}
  setPlayers(w: string) { this.epoch++; this.calls.push(`players ${w}`); }
  emitInitialPosition() {}
  emitMove() {}
  emitClocks() {}
  emitPv() {}
  emitResult() {}
  emitLevel() {}
}

test('ResumeSink: attach-before-setPlayers order, numbering dumps before each game, hold only on last line', () => {
  const srv = new FakeServer();
  const mapped: Array<[number, number]> = [];
  const reg = { games: [g(1), g(2), g(3)], refresh() {} };
  const sink = new ResumeSink(srv, { mapEpoch: (e, n) => mapped.push([e, n]) }, reg);
  let pg = 2;
  sink.begin(2, [{ ip: '1.1.1.1', port: 1, user: 'A', next: 2 }, { ip: '1.1.1.1', port: 2, user: 'B', next: 3 }, { ip: '1.1.1.1', port: 3, user: 'C', next: 5 }], 5, () => pg);
  sink.setPlayers('w2', 'b2');
  pg = 3;
  sink.setPlayers('w3', 'b3');
  pg = 4;
  sink.setPlayers('w4', 'b4');
  const before = srv.calls.length;
  sink.finishCatchUp();
  const idx = (s: string) => srv.calls.findIndex((c) => c.startsWith(s));
  assert.ok(idx('add 1.1.1.1:1') < idx('players w2'));
  assert.ok(idx('add 1.1.1.1:2') > idx('players w2') && idx('add 1.1.1.1:2') < idx('players w3'));
  // A gets a dump before each of games 2, 3, 4
  const a = srv.calls.filter((c) => c.startsWith('enq 1.1.1.1:1 CTRESET'));
  assert.equal(a.length, 3);
  assert.ok(srv.calls.indexOf(a[0]) < idx('players w2'));
  // exactly the last line of each dump carries the hold
  assert.equal(srv.held.length, 3 + 2 + 1); // A: games 2,3,4; B: 3,4; C: at finishCatchUp
  assert.ok(srv.calls.filter((c) => c.includes(`hold${NUMBERING_HOLD_MS}`)).length === srv.held.length);
  // C attached at finishCatchUp with a dump for current = 5 (newest row 3 is only the registry's newest < 5)
  assert.ok(srv.calls.slice(before).some((c) => c.startsWith('add 1.1.1.1:3')));
  assert.ok(srv.calls.slice(before).some((c) => c.startsWith('enq 1.1.1.1:3 CTRESET')));
  assert.deepEqual(mapped, [[1, 2], [2, 3], [3, 4]]);
});

test('ResumeSink: no registry / no prior game -> no dump; already-registered dest is not re-added; counter assert', () => {
  const srv = new FakeServer();
  srv.clients.add('1.1.1.1:1');
  const w = warnings();
  const sink = new ResumeSink(srv, undefined, undefined);
  sink.begin(1, [{ ip: '1.1.1.1', port: 1, user: 'A', next: 1 }], 1, () => 7);
  sink.setPlayers('w', 'b');
  sink.finishCatchUp();
  w.done();
  assert.equal(srv.calls.filter((c) => c.startsWith('add')).length, 0);
  assert.equal(srv.calls.filter((c) => c.includes('CTRESET')).length, 0);
  assert.ok(w.msgs.some((m) => /no registry/.test(m)));
  assert.ok(w.msgs.some((m) => /game counter 1 != pipeline 7/.test(m)));
  // after finishCatchUp the assertion is silent
  const w2 = warnings();
  sink.setPlayers('w', 'b');
  w2.done();
  assert.equal(w2.msgs.length, 0);
});

test('ResumeSink: lazy first game and current resolve on first use', () => {
  const srv = new FakeServer();
  const sink = new ResumeSink(srv, undefined, { games: [g(1), g(2)], refresh() {} });
  sink.begin(() => 3, [{ ip: '1.1.1.1', port: 9, user: 'Z', next: 3 }], () => 3, () => 3);
  sink.setPlayers('w', 'b');
  assert.ok(srv.calls.some((c) => c.startsWith('add 1.1.1.1:9')));
});

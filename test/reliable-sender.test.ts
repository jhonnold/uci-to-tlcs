import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReliableSender, type Outbound, type SenderOptions } from '../src/tlcs/reliable-sender.js';
import type { Position } from '../src/tlcs/protocol.js';
import { logger } from '../src/util/logger.js';
import { metrics } from '../src/metrics.js';

const BASE: Partial<SenderOptions> = {
  initialRtoMs: 10,
  minRtoMs: 5,
  maxRtoMs: 40,
  backoffFactor: 2,
  giveUpMs: 150,
};

const mg = (n: Parameters<typeof metrics.get>[0], l?: Record<string, string>) => metrics.get(n, l);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

/** Capture logger output (restores on done()). */
function captureLogs() {
  const lines: string[] = [];
  const orig = { ...logger };
  for (const lvl of ['debug', 'info', 'warn', 'error'] as const) {
    logger[lvl] = (m: string) => void lines.push(`${lvl}: ${m}`);
  }
  return {
    lines,
    count: (re: RegExp) => lines.filter((l) => re.test(l)).length,
    done: () => Object.assign(logger, orig),
  };
}

/** AckPolicy: milliseconds to wait before ACKing this copy, or null to drop (never ACK) it. */
type AckPolicy = (dest: string, id: number, copy: number, body: string) => number | null;

interface Rx {
  dest: string;
  id: number | null; // null => unnumbered
  body: string;
  t: number;
}

function harness(
  opts: Partial<SenderOptions> = {},
  policy: AckPolicy = () => 0,
  positionSteps: (board: number, pos: Position) => Outbound[] = (b, pos) => [{ body: `P${b}:${pos.fen}`, board: b, step: pos }],
) {
  const rx: Rx[] = [];
  const copies = new Map<string, number>();
  const collapses: Array<[number, string]> = [];
  const s: ReliableSender = new ReliableSender(
    {
      rawSend: (payload, dest) => {
        const m = /^<(\d+)>([\s\S]*)$/.exec(payload);
        if (!m) {
          rx.push({ dest, id: null, body: payload, t: performance.now() });
          return;
        }
        const id = Number(m[1]);
        rx.push({ dest, id, body: m[2], t: performance.now() });
        const key = `${dest}#${id}`;
        const copy = (copies.get(key) ?? 0) + 1;
        copies.set(key, copy);
        const d = policy(dest, id, copy, m[2]);
        if (d !== null) setTimeout(() => s.ack(dest, id), d);
      },
      positionSteps: (_d, b, pos) => {
        collapses.push([b, pos.fen]);
        return positionSteps(b, pos);
      },
    },
    { ...BASE, ...opts },
  );
  /** First-seen numbered bodies for a dest (what a deduping client would process). */
  const firstSeen = (dest: string): Array<{ id: number; body: string }> => {
    const seen = new Set<number>();
    const out: Array<{ id: number; body: string }> = [];
    for (const r of rx) {
      if (r.dest !== dest || r.id === null || seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, body: r.body });
    }
    return out;
  };
  return { s, rx, firstSeen, collapses };
}

/** A game line of `board` (not a move step). */
const game = (body: string, board = 1): Outbound => ({ body, board });
/** A move step of `board` that leaves the board at `fen`. */
const step = (body: string, fen: string, board = 1): Outbound => ({ body, board, step: { fen, fmr: 0, fullmove: 1 } });
const ctl = (body: string): Outbound => ({ body });

test('sender: ids are per client, start at 1, framing has no space', async () => {
  const h = harness();
  h.s.addClient('A');
  h.s.addClient('B');
  h.s.enqueue(null, ctl('x'));
  h.s.enqueue(null, ctl('y'));
  await waitFor(() => h.firstSeen('A').length === 2 && h.firstSeen('B').length === 2);
  assert.deepEqual(h.firstSeen('A'), [{ id: 1, body: 'x' }, { id: 2, body: 'y' }]);
  assert.deepEqual(h.firstSeen('B'), [{ id: 1, body: 'x' }, { id: 2, body: 'y' }]);
  h.s.close();
});

test('sender: stop-and-wait; wrong-id and unknown-dest ACKs are ignored', async () => {
  const h = harness({}, () => null);
  h.s.addClient('A');
  h.s.enqueue('A', ctl('one'));
  h.s.enqueue('A', ctl('two'));
  h.s.ack('A', 99);
  h.s.ack('nobody', 1);
  await sleep(30);
  assert.deepEqual(h.firstSeen('A'), [{ id: 1, body: 'one' }]);
  h.s.ack('A', 1);
  assert.deepEqual(h.firstSeen('A').map((x) => x.body), ['one', 'two']);
  h.s.close();
});

test('sender: ordering under loss (every 2nd copy ACKed)', async () => {
  const rt0 = mg('tlcs_retransmits_total');
  const h = harness({}, (_d, _id, copy) => (copy % 2 === 0 ? 0 : null));
  h.s.addClient('A');
  for (let i = 0; i < 20; i++) h.s.enqueue('A', ctl(`m${i}`));
  await waitFor(() => h.s.depth('A') === 0, 4000);
  const fs = h.firstSeen('A');
  assert.deepEqual(fs.map((x) => x.body), Array.from({ length: 20 }, (_, i) => `m${i}`));
  assert(fs.every((x, i) => i === 0 || x.id > fs[i - 1].id));
  assert(mg('tlcs_retransmits_total') - rt0 >= 1, 'retransmits counted');
  h.s.close();
});

test('sender: a client that never ACKs does not stall another', async () => {
  const h = harness({}, (d) => (d === 'A' ? null : 0));
  h.s.addClient('A');
  h.s.addClient('B');
  for (let i = 0; i < 10; i++) h.s.enqueue(null, ctl(`m${i}`));
  await waitFor(() => h.firstSeen('B').length === 10);
  assert.equal(h.firstSeen('A').length, 1);
  h.s.close();
});

test('sender: adaptive RTO converges to the floor; backoff gaps grow and cap; next item restarts at rto', async () => {
  const h = harness({}, (_d, id) => (id <= 20 ? 0 : null));
  h.s.addClient('A');
  for (let i = 0; i < 20; i++) h.s.enqueue('A', ctl(`w${i}`));
  await waitFor(() => h.s.depth('A') === 0);
  assert.equal(h.s.rttStats('A')!.rto, 5); // clamped to minRtoMs

  h.s.enqueue('A', ctl('never')); // id 21: never ACKed
  await sleep(220);
  const gaps: number[] = [];
  const ts = h.rx.filter((r) => r.id === 21).map((r) => r.t);
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  assert(gaps.length >= 4, `gaps ${gaps}`);
  for (let i = 1; i < gaps.length; i++) assert(gaps[i] >= gaps[i - 1] * 0.8 - 2, `non-decreasing: ${gaps}`);
  assert(gaps.every((g) => g <= 40 * 1.5 + 10), `capped: ${gaps}`);
  assert(gaps[0] < 30, `first gap ~minRto: ${gaps}`);
  h.s.close();
});

test('sender: Karn - an ACK after a retransmit does not move srtt', async () => {
  const h = harness({ initialRtoMs: 10 }, (_d, id, copy) => (id <= 5 ? 0 : copy >= 2 ? 0 : null));
  h.s.addClient('A');
  for (let i = 0; i < 5; i++) h.s.enqueue('A', ctl(`w${i}`));
  await waitFor(() => h.s.depth('A') === 0);
  const before = h.s.rttStats('A')!.srtt;
  h.s.enqueue('A', ctl('lossy')); // id 6: first copy lost
  await waitFor(() => h.s.depth('A') === 0);
  assert.equal(h.s.rttStats('A')!.srtt, before);
  h.s.close();
});

test('sender: RTT stepping above the RTO still converges (no permanent retransmits)', async () => {
  // true RTT 15 ms = 3x minRto; initial RTO 10 ms
  const h = harness({ initialRtoMs: 10 }, () => 15);
  h.s.addClient('A');
  for (let i = 0; i < 12; i++) h.s.enqueue('A', ctl(`m${i}`));
  await waitFor(() => h.s.depth('A') === 0, 4000);
  const st = h.s.rttStats('A');
  assert(st !== null, 'no clean sample ever taken');
  assert(st!.srtt >= 13, `srtt ${st!.srtt}`);
  h.s.close();
});

test('sender: one heavily retransmitted item does not blow up the next item\'s RTO', async () => {
  // item 1 needs 5 copies (elapsed ~ 10+20+40+40+40 ms); item 2's first timer must stay <= 2x the old RTO
  const h = harness({ initialRtoMs: 10, minRtoMs: 5 }, (_d, id, copy) => (id === 1 ? (copy >= 5 ? 0 : null) : id === 2 ? null : 0));
  h.s.addClient('A');
  h.s.enqueue('A', ctl('slow'));
  h.s.enqueue('A', ctl('next'));
  await waitFor(() => h.rx.filter((r) => r.id === 2).length >= 2);
  const ts = h.rx.filter((r) => r.id === 2).map((r) => r.t);
  assert(ts[1] - ts[0] <= 2 * 10 + 40, `next item's first gap ${ts[1] - ts[0]}ms`);
  h.s.close();
});


test('sender: give-up drops a move, a result and a control line alike; the next id follows', async () => {
  const gg0 = mg('tlcs_giveups_total', { kind: 'game' });
  const gc0 = mg('tlcs_giveups_total', { kind: 'control' });
  const dr0 = mg('tlcs_dropped_total', { reason: 'giveup' });
  const log = captureLogs();
  try {
    const h = harness({}, (_d, id) => (id <= 3 ? null : 0));
    let gaveUp = 0;
    h.s.addClient('A');
    h.s.enqueue('A', step('WMOVE: 1. e4', 'x'));
    h.s.enqueue('A', game('result: 1-0'));
    h.s.enqueue('A', { body: 'CT: x', onGiveUp: () => void gaveUp++ });
    h.s.enqueue('A', ctl('next'));
    await waitFor(() => h.s.depth('A') === 0, 2000);
    assert.deepEqual(h.firstSeen('A'), [
      { id: 1, body: 'WMOVE: 1. e4' },
      { id: 2, body: 'result: 1-0' },
      { id: 3, body: 'CT: x' },
      { id: 4, body: 'next' },
    ]);
    assert.equal(gaveUp, 1);
    assert.equal(mg('tlcs_giveups_total', { kind: 'game' }) - gg0, 2);
    assert.equal(mg('tlcs_giveups_total', { kind: 'control' }) - gc0, 1);
    assert.equal(mg('tlcs_dropped_total', { reason: 'giveup' }) - dr0, 3);
    assert.deepEqual(h.collapses, [], 'a give-up never rebuilds anything');
    h.s.close();
  } finally {
    log.done();
  }
});

test('sender: a line acked before giveUpMs is never dropped', async () => {
  const h = harness({ giveUpMs: 150 }, (_d, id, copy) => (id === 1 && copy < 3 ? null : 0));
  h.s.addClient('A');
  h.s.enqueue('A', game('result: 1-0'));
  h.s.enqueue('A', ctl('next'));
  await waitFor(() => h.s.depth('A') === 0, 1000);
  assert.deepEqual(h.firstSeen('A').map((x) => x.body), ['result: 1-0', 'next']);
  h.s.close();
});

test('sender: over maxQueue, each game\'s queued move steps collapse to its position steps at its newest step', async () => {
  const dr0 = mg('tlcs_dropped_total', { reason: 'stale' });
  const log = captureLogs();
  try {
    const h = harness({ maxQueue: 8 }, () => null);
    h.s.addClient('A');
    h.s.enqueue('A', ctl('lead')); // in flight, never ACKed by the policy
    h.s.enqueue('A', game('WPLAYER: a'));
    h.s.enqueue('A', step('FEN: a', 'fa'));
    h.s.enqueue('A', step('WMOVE: a', 'fb'));
    h.s.enqueue('A', step('BOARD 2 FEN: x', 'fx', 2));
    h.s.enqueue('A', game('result: 1-0'));
    h.s.enqueue('A', game('WPLAYER: b'));
    h.s.enqueue('A', step('FEN: c', 'fc'));
    h.s.enqueue('A', step('BOARD 2 FEN: y', 'fy', 2));
    assert.equal(h.s.depth('A'), 1 + 8, 'at the cap: nothing dropped');
    h.s.enqueue('A', step('FEN: d', 'fd')); // 9 queued game lines > 8
    assert.deepEqual(h.collapses.sort(), [[1, 'fb'], [1, 'fd'], [2, 'fy']]);
    for (let id = 1; id <= 7; id++) h.s.ack('A', id);
    // each game keeps its own final position ahead of its result
    assert.deepEqual(h.firstSeen('A').map((x) => x.body), ['lead', 'WPLAYER: a', 'P1:fb', 'result: 1-0', 'WPLAYER: b', 'P2:fy', 'P1:fd']);
    assert.equal(mg('tlcs_dropped_total', { reason: 'stale' }) - dr0, 6);
    assert.equal(log.count(/info: stale: A dropped 6 queued game line/), 1);
    h.s.close();
  } finally {
    log.done();
  }
});

test('sender: a long control backlog (a crosstable dump) never collapses the moves queued behind it', async () => {
  const h = harness({ maxQueue: 8 }, () => null);
  h.s.addClient('A');
  h.s.enqueue('A', ctl('lead'));
  for (let i = 0; i < 20; i++) h.s.enqueue('A', ctl(`CT:${i}`));
  h.s.enqueue('A', step('FEN: a', 'fa'));
  h.s.enqueue('A', step('WMOVE: a', 'fa'));
  h.s.enqueue('A', step('FMR: 0', 'fa'));
  assert.deepEqual(h.collapses, [], 'only queued move steps count towards maxQueue');
  assert.equal(h.s.depth('A'), 1 + 20 + 3);
  h.s.close();
});

test('sender: a board collapses only when its queued steps outnumber the position steps replacing them', async () => {
  const h = harness({ maxQueue: 4 }, () => null, (b, pos) => Array.from({ length: 3 }, (_, i) => ({ body: `P${b}:${pos.fen}:${i}`, board: b, step: pos })));
  h.s.addClient('A');
  h.s.enqueue('A', ctl('lead'));
  h.s.enqueue('A', step('BOARD 2 FEN: x', 'fx', 2)); // board 2: 1 step, never worth collapsing
  for (const f of ['a', 'b', 'c', 'd']) h.s.enqueue('A', step(`FEN: ${f}`, `f${f}`)); // 5 steps > 4
  for (let id = 1; id <= 5; id++) h.s.ack('A', id);
  assert.deepEqual(h.firstSeen('A').map((x) => x.body), ['lead', 'BOARD 2 FEN: x', 'P1:fd:0', 'P1:fd:1', 'P1:fd:2']);
  h.s.close();
});

test('sender: a collapse drops the stale PV/clock lines of the dropped moves, keeps later ones and control lines', async () => {
  const h = harness({ maxQueue: 5 }, () => null);
  h.s.addClient('A');
  h.s.enqueue('A', ctl('lead'));
  h.s.enqueue('A', step('FEN: a', 'fa'));
  h.s.enqueue('A', { body: 'WPV: 1', latest: 'WPV', board: 1 });
  h.s.enqueue('A', ctl('CHAT: hi'));
  h.s.enqueue('A', { body: 'WTIME: 1', latest: 'WTIME', board: 1 });
  h.s.enqueue('A', step('FEN: b', 'fb'));
  h.s.enqueue('A', { body: 'BPV: 2', latest: 'BPV', board: 1 });
  h.s.enqueue('A', step('FEN: c', 'fc')); // 6 game lines > 5
  h.s.enqueue('A', { body: 'WPV: 3', latest: 'WPV', board: 1 }); // after the newest step: kept
  for (let id = 1; id <= 3; id++) h.s.ack('A', id);
  assert.deepEqual(h.rx.map((r) => r.body), ['lead', 'CHAT: hi', 'P1:fc', 'WPV: 3']);
  h.s.close();
});

test('sender: PV/clock lines count towards maxQueue (they cannot pile up to the hard cap)', async () => {
  const h = harness({ maxQueue: 6, hardCap: 12 }, () => null);
  h.s.addClient('A');
  h.s.enqueue('A', ctl('lead'));
  for (let i = 0; i < 40; i++) {
    h.s.enqueue('A', { body: `WPV: ${i}`, latest: 'WPV', board: 1 });
    h.s.enqueue('A', step(`FEN: ${i}`, `f${i}`));
  }
  assert.ok(h.s.depth('A') <= 1 + 6 + 1, `depth ${h.s.depth('A')}`);
  h.s.close();
});

test('sender: latest items - idle gets raw at once; busy keeps only the newest, in queue order', async () => {
  const h = harness({}, () => null);
  h.s.addClient('A');
  h.s.enqueue('A', { body: 'WPV: first', latest: 'WPV' });
  assert.deepEqual(h.rx.map((r) => [r.id, r.body]), [[null, 'WPV: first']]);
  h.s.enqueue('A', ctl('x')); // busy now
  h.s.enqueue('A', { body: 'WPV: a', latest: 'WPV' });
  h.s.enqueue('A', { body: 'WPV: b', latest: 'WPV' });
  h.s.enqueue('A', ctl('y'));
  h.s.ack('A', 1);
  assert.deepEqual(h.rx.slice(1).map((r) => [r.id, r.body]), [[1, 'x'], [null, 'WPV: b'], [2, 'y']]);
  h.s.close();
});

test('sender: latest dedupe never moves a PV behind the numbered move it precedes', async () => {
  const h = harness({}, () => null);
  h.s.addClient('A');
  h.s.enqueue('A', ctl('busy')); // in flight, never ACKed by policy; ack manually below
  const pv = (k: 'WPV' | 'BPV', n: number): Outbound => ({ body: `${k}: ${n}`, latest: k });
  h.s.enqueue('A', pv('WPV', 1));
  h.s.enqueue('A', ctl('FEN 1'));
  h.s.enqueue('A', ctl('WMOVE 1. e4'));
  h.s.enqueue('A', pv('BPV', 1));
  h.s.enqueue('A', ctl('BMOVE 1... e5'));
  h.s.enqueue('A', pv('WPV', 2));
  h.s.enqueue('A', ctl('WMOVE 2. Nf3'));
  h.s.enqueue('A', pv('BPV', 2));
  h.s.enqueue('A', pv('BPV', 3)); // trailing run: replaces BPV 2
  for (let id = 1; id <= 6; id++) h.s.ack('A', id);
  const seq = h.rx.map((r) => r.body).filter((b) => /PV|MOVE/.test(b));
  assert.deepEqual(seq, [
    'WPV: 1', 'WMOVE 1. e4', 'BPV: 1', 'BMOVE 1... e5', 'WPV: 2', 'WMOVE 2. Nf3', 'BPV: 3',
  ]);
  h.s.close();
});

test('sender: ids never reset across remove/re-add; unknown dest is a no-op', async () => {
  const h = harness();
  h.s.addClient('A');
  h.s.enqueue('A', ctl('x'));
  await waitFor(() => h.s.depth('A') === 0);
  h.s.removeClient('A');
  h.s.enqueue('A', ctl('ghost'));
  assert(!h.s.has('A'));
  h.s.addClient('A');
  h.s.enqueue('A', ctl('y'));
  await waitFor(() => h.s.depth('A') === 0);
  assert.deepEqual(h.firstSeen('A'), [{ id: 1, body: 'x' }, { id: 2, body: 'y' }]);
  h.s.close();
});


test('sender: resync removes queued game and latest items (not control, not in flight) and appends the snapshot', async () => {
  const rf0 = mg('tlcs_resyncs_total', { kind: 'full' });
  const h = harness({}, () => null);
  h.s.addClient('A');
  h.s.enqueue('A', step('FEN: a', 'fa')); // in flight, id 1
  h.s.enqueue('A', step('WMOVE: b', 'fb'));
  h.s.enqueue('A', game('result: 1-0'));
  h.s.enqueue('A', { body: 'WPV: old', latest: 'WPV', board: 1 });
  h.s.enqueue('A', ctl('CHAT: hi'));
  h.s.resync('A', [game('WPLAYER: s'), { body: 'WPV: new', latest: 'WPV', board: 1 }]);
  assert.equal(mg('tlcs_resyncs_total', { kind: 'full' }) - rf0, 1);
  h.s.ack('A', 1);
  h.s.ack('A', 2);
  h.s.ack('A', 3);
  assert.deepEqual(h.rx.map((r) => [r.id, r.body]), [[1, 'FEN: a'], [2, 'CHAT: hi'], [3, 'WPLAYER: s'], [null, 'WPV: new']]);
  h.s.close();
});

test('sender: resync on an idle client sends the snapshot at once', async () => {
  const h = harness({}, () => 0);
  h.s.addClient('A');
  h.s.resync('A', [game('WPLAYER: s'), game('BPLAYER: t')]);
  await waitFor(() => h.s.depth('A') === 0);
  assert.deepEqual(h.firstSeen('A').map((x) => x.body), ['WPLAYER: s', 'BPLAYER: t']);
  h.s.close();
});

test('sender: resync for an unknown dest does not count', () => {
  const rf0 = mg('tlcs_resyncs_total', { kind: 'full' });
  const h = harness();
  h.s.resync('nobody', [game('x')]);
  assert.equal(mg('tlcs_resyncs_total', { kind: 'full' }) - rf0, 0);
  h.s.close();
});

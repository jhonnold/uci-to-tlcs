import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReliableSender, type Outbound, type SenderOptions } from '../src/tlcs/reliable-sender.js';
import { logger } from '../src/util/logger.js';

const BASE: Partial<SenderOptions> = {
  initialRtoMs: 10,
  minRtoMs: 5,
  maxRtoMs: 40,
  backoffFactor: 2,
  giveUpMs: 150,
  stallMs: 400,
};

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
  replay: (e: number, wr: boolean) => Outbound[] | null = () => null,
  onStalled?: (d: string) => void,
) {
  const rx: Rx[] = [];
  const copies = new Map<string, number>();
  const replays: Array<[number, boolean]> = [];
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
      replay: (e, wr) => {
        replays.push([e, wr]);
        return replay(e, wr);
      },
      onStalled,
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
  return { s, rx, firstSeen, replays };
}

const game = (body: string, epoch: number, critical = false): Outbound => ({ body, epoch, critical: critical || undefined });
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
  const h = harness({}, (_d, _id, copy) => (copy % 2 === 0 ? 0 : null));
  h.s.addClient('A');
  for (let i = 0; i < 20; i++) h.s.enqueue('A', ctl(`m${i}`));
  await waitFor(() => h.s.depth('A') === 0, 4000);
  const fs = h.firstSeen('A');
  assert.deepEqual(fs.map((x) => x.body), Array.from({ length: 20 }, (_, i) => `m${i}`));
  assert(fs.every((x, i) => i === 0 || x.id > fs[i - 1].id));
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
  assert(gaps[0] < 15, `first gap ~minRto: ${gaps}`);
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

test('sender: game give-up replaces the epoch tail with a replay under new ids', async () => {
  const r = [game('r1', 1), game('r2', 1)];
  const h = harness({}, (_d, id) => (performance.now() > T0 + 200 || id > 1 ? 0 : null), (e) => (e === 1 ? r : null));
  const T0 = performance.now();
  const log = captureLogs();
  try {
    h.s.addClient('A');
    h.s.enqueue('A', game('g1', 1));
    h.s.enqueue('A', game('g2', 1));
    h.s.enqueue('A', game('g3', 1));
    h.s.enqueue('A', ctl('c1'));
    h.s.enqueue('A', game('h1', 2));
    h.s.enqueue('A', game('h2', 2));
    await waitFor(() => h.firstSeen('A').length >= 6);
    await waitFor(() => h.s.depth('A') === 0);
    assert.deepEqual(h.firstSeen('A').map((x) => x.body), ['g1', 'r1', 'r2', 'c1', 'h1', 'h2']);
    assert.deepEqual(h.replays[0], [1, false]);
    assert(log.count(/give-up .*resync game 1/) === 1);
  } finally {
    log.done();
    h.s.close();
  }
});

test('sender: replay is asked withResult=true when a queued result is spliced', async () => {
  const h = harness({}, (_d, id) => (performance.now() > T0 + 200 || id > 1 ? 0 : null), (e, wr) => [game(wr ? 'rr' : 'r', e)]);
  const T0 = performance.now();
  h.s.addClient('A');
  h.s.enqueue('A', game('g1', 1));
  h.s.enqueue('A', game('g2', 1));
  h.s.enqueue('A', game('res', 1, true));
  await waitFor(() => h.s.depth('A') === 0);
  assert.deepEqual(h.replays[0], [1, true]);
  assert.deepEqual(h.firstSeen('A').map((x) => x.body), ['g1', 'rr']);
  h.s.close();
});

test('sender: control give-up drops the item, calls onGiveUp once, continues', async () => {
  const h = harness({}, (_d, id) => (id === 1 ? null : 0));
  let gaveUp = 0;
  h.s.addClient('A');
  h.s.enqueue('A', { body: 'ctl', onGiveUp: () => void gaveUp++ });
  h.s.enqueue('A', ctl('next'));
  await waitFor(() => h.firstSeen('A').length === 2, 1000);
  assert.equal(gaveUp, 1);
  assert.equal(h.replays.length, 0);
  h.s.close();
});

test('sender: critical item survives giveUpMs and is dropped after stallMs with an error', async () => {
  const log = captureLogs();
  try {
    const h = harness({ giveUpMs: 60, stallMs: 250 }, (_d, id) => (id === 1 ? null : 0));
    h.s.addClient('A');
    h.s.enqueue('A', game('res', 1, true));
    h.s.enqueue('A', ctl('next'));
    await sleep(150);
    assert.equal(h.firstSeen('A').length, 1, 'still retrying past giveUpMs');
    await waitFor(() => h.firstSeen('A').length === 2, 1000);
    assert(log.count(/error: give-up critical 1/) === 1);
    h.s.close();

    const h2 = harness({ giveUpMs: 60, stallMs: 250 }, (_d, id, copy) => (id === 1 && copy < 8 ? null : 0));
    h2.s.addClient('A');
    h2.s.enqueue('A', game('res', 1, true));
    await waitFor(() => h2.s.depth('A') === 0, 1000);
    assert(log.count(/give-up critical 1/) === 1, 'second run never gave up');
    h2.s.close();
  } finally {
    log.done();
  }
});

/** A tiny fake server: per-epoch streams, replay = first + last item (+ result). */
function fakeRecords() {
  const streams = new Map<number, Outbound[]>();
  const replay = (e: number, wr: boolean): Outbound[] | null => {
    const st = streams.get(e);
    if (!st) return null;
    const body = st.filter((i) => !i.critical);
    const out = [body[0], body[body.length - 1]].map((i) => ({ ...i }));
    const res = st.find((i) => i.critical);
    if (wr && res) out.push({ ...res });
    return out;
  };
  const add = (e: number, o: Outbound) => {
    if (!streams.has(e)) streams.set(e, []);
    streams.get(e)!.push(o);
  };
  return { streams, replay, add };
}

test('sender: a slow-but-ACKing client loses no result across coalesced epochs', async () => {
  const log = captureLogs();
  try {
    const rec = fakeRecords();
    const h = harness({ maxQueue: 8, stallMs: 60_000, giveUpMs: 5000 }, (_d, _id, copy) => (copy % 2 === 0 ? 0 : null), rec.replay);
    h.s.addClient('A');
    for (let e = 1; e <= 4; e++) {
      for (let i = 0; i < 15; i++) {
        const it = game(`e${e}m${i}`, e);
        rec.add(e, it);
        h.s.enqueue('A', it);
      }
      const res = game(`res${e}`, e, true);
      rec.add(e, res);
      h.s.enqueue('A', res);
    }
    await waitFor(() => h.s.depth('A') === 0, 8000);
    const bodies = h.firstSeen('A').map((x) => x.body);
    assert.deepEqual(bodies.filter((b) => b.startsWith('res')), ['res1', 'res2', 'res3', 'res4']);
    assert.equal(bodies[bodies.length - 1], 'res4');
    assert(bodies.includes('e4m14'));
    assert(log.count(/coalesced/) > 0);
    assert.equal(log.count(/stalled|give-up critical/), 0);
    assert.equal(h.s.referencedEpochs().size, 0);
    h.s.close();
  } finally {
    log.done();
  }
});

test('sender: stalled client is bounded to the newest epoch, again for each new epoch, and unstalls on ACK', async () => {
  const log = captureLogs();
  try {
    const rec = fakeRecords();
    let stalled = 0;
    let ackOn = false;
    const h = harness({ stallMs: 200, giveUpMs: 1000, maxQueue: 8 }, () => (ackOn ? 0 : null), rec.replay, () => void stalled++);
    h.s.addClient('A');
    const push = (e: number, n: number) => {
      for (let i = 0; i < n; i++) {
        const it = game(`e${e}m${i}`, e);
        rec.add(e, it);
        h.s.enqueue('A', it);
      }
      const res = game(`res${e}`, e, true);
      rec.add(e, res);
      h.s.enqueue('A', res);
    };
    push(1, 6);
    push(2, 6);
    push(3, 6);
    await waitFor(() => log.count(/error: stalled A/) >= 1, 1500);
    assert.equal(stalled, 1);
    assert.match(log.lines.find((l) => /error: stalled/.test(l))!, /\(\d+ results lost\)/);
    assert.deepEqual([...h.s.referencedEpochs()].sort(), [3, 1].sort()); // 1 stays only as the in-flight item
    // a new epoch while stalled drops the older queued one again
    push(4, 6);
    assert(!h.s.referencedEpochs().has(3));
    assert.equal(stalled, 1, 'onStalled fires once per episode');
    ackOn = true;
    await waitFor(() => h.s.depth('A') === 0, 2000);
    assert.equal(log.count(/unstalled A/), 1);
    h.s.close();
  } finally {
    log.done();
  }
});

test('sender: a client idle longer than stallMs is not "stalled" by one lost first copy', async () => {
  const log = captureLogs();
  try {
    let stalled = 0;
    const h = harness({ stallMs: 200, giveUpMs: 1000 }, (_d, _id, copy) => (copy === 1 ? null : 0), () => null, () => void stalled++);
    h.s.addClient('A');
    await sleep(300);
    h.s.enqueue('A', ctl('x'));
    h.s.enqueue('A', ctl('y'));
    await waitFor(() => h.s.depth('A') === 0, 1000);
    assert.equal(stalled, 0);
    assert.equal(log.count(/stalled/), 0);
    h.s.close();
  } finally {
    log.done();
  }
});

test('sender: coalescing collapses queued epochs only when the replay is shorter', async () => {
  const replays = new Map<number, Outbound[]>([
    [1, [game('a1', 1), game('a2', 1), game('a3', 1)]],
    [2, [game('b1', 2), game('b2', 2), game('b3', 2)]],
  ]);
  const h = harness({ maxQueue: 7 }, () => null, (e) => replays.get(e) ?? null);
  h.s.addClient('A');
  h.s.enqueue('A', ctl('lead')); // in flight forever
  for (let i = 0; i < 4; i++) h.s.enqueue('A', game(`x${i}`, 1));
  for (let i = 0; i < 3; i++) h.s.enqueue('A', game(`y${i}`, 2));
  assert.equal(h.s.depth('A'), 1 + 7, 'at the cap: nothing coalesced');
  h.s.enqueue('A', game('y3', 2)); // 8 > 7: both epochs collapse to their 3-item replays in one pass
  assert.equal(h.s.depth('A'), 1 + 3 + 3);

  const longer = new Map<number, Outbound[]>([[1, Array.from({ length: 20 }, (_, i) => game(`L${i}`, 1))]]);
  const h2 = harness({ maxQueue: 5 }, () => null, (e) => longer.get(e) ?? null);
  h2.s.addClient('A');
  h2.s.enqueue('A', ctl('lead'));
  for (let i = 0; i < 10; i++) h2.s.enqueue('A', game(`x${i}`, 1));
  assert.equal(h2.s.depth('A'), 11, 'longer replay: nothing coalesced');
  h.s.close();
  h2.s.close();
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

test('sender: resync on an idle client appends cur replay; a finished cur with nothing queued appends nothing', async () => {
  const h = harness({}, () => 0, (e) => [game(`r${e}`, e)]);
  h.s.addClient('A');
  h.s.resync('A', 2, false);
  await waitFor(() => h.firstSeen('A').length === 1);
  assert.deepEqual(h.replays, [[2, false]]);
  h.s.resync('A', 2, true);
  await sleep(30);
  assert.equal(h.firstSeen('A').length, 1);
  h.s.close();
});

test('sender: resync splices pending moves + result without duplicating the in-flight item', async () => {
  const h = harness({}, () => null, (e, wr) => [game(`R${e}${wr ? '+res' : ''}`, e)]);
  h.s.addClient('A');
  h.s.enqueue('A', game('m1', 1)); // in flight, id 1
  h.s.enqueue('A', game('m2', 1));
  h.s.enqueue('A', game('res1', 1, true));
  h.s.enqueue('A', game('n1', 2));
  h.s.resync('A', 2, false);
  h.s.ack('A', 1);
  h.s.ack('A', 2);
  h.s.ack('A', 3);
  assert.deepEqual(h.firstSeen('A').map((x) => [x.id, x.body]), [[1, 'm1'], [2, 'R1+res'], [3, 'R2']]);
  h.s.close();
});

test('sender: resync while the result is in flight does not replay the finished game', async () => {
  const h = harness({}, () => null, (e) => [game(`R${e}`, e)]);
  h.s.addClient('A');
  h.s.enqueue('A', game('res2', 2, true)); // in flight
  h.s.resync('A', 2, true);
  await sleep(40);
  assert.deepEqual([...new Set(h.rx.filter((r) => r.id !== null).map((r) => `${r.id}:${r.body}`))], ['1:res2']);
  assert.equal(h.replays.length, 0);
  h.s.close();
});

test('sender: referencedEpochs reflects queued and in-flight items and empties when drained', async () => {
  const h = harness({}, () => null);
  h.s.addClient('A');
  h.s.addClient('B');
  h.s.enqueue('A', game('a', 1));
  h.s.enqueue('A', game('b', 2));
  h.s.enqueue('B', game('c', 3));
  assert.deepEqual([...h.s.referencedEpochs()].sort(), [1, 2, 3]);
  h.s.ack('A', 1);
  h.s.ack('A', 2);
  h.s.ack('B', 1);
  assert.equal(h.s.referencedEpochs().size, 0);
  h.s.close();
});

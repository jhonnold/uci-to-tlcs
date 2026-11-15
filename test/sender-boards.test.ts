import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReliableSender, type Outbound } from '../src/tlcs/reliable-sender.js';
import { logger } from '../src/util/logger.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const orig = { ...logger };
  for (const l of ['debug', 'info', 'warn', 'error'] as const) logger[l] = () => {};
  return fn().finally(() => Object.assign(logger, orig));
}

/** A sender whose single client never ACKs (everything stays queued) unless `ack` is set. */
function harness(opts: { stallMs?: number } = {}) {
  const sent: string[] = [];
  const replays: Array<[number, boolean, string | undefined]> = [];
  const records = new Map<number, Outbound[]>();
  let ack = false;
  const s: ReliableSender = new ReliableSender(
    {
      rawSend: (p, d) => {
        sent.push(p);
        const m = /^<(\d+)>/.exec(p);
        if (m && ack) setTimeout(() => s.ack(d, Number(m[1])), 0);
      },
      replay: (e, wr, dest) => {
        replays.push([e, wr, dest]);
        return records.get(e) ?? null;
      },
    },
    { initialRtoMs: 10, minRtoMs: 5, maxRtoMs: 20, giveUpMs: 5000, stallMs: opts.stallMs ?? 60_000, maxQueue: 1000 },
  );
  s.addClient('A');
  return { s, sent, replays, records, setAck: (v: boolean) => void (ack = v) };
}

const item = (body: string, epoch: number, board: number, critical = false): Outbound => ({ body, epoch, board, critical: critical || undefined });

test('stalled client keeps the newest epoch of every board, not only the newest overall', () =>
  quiet(async () => {
    const h = harness({ stallMs: 100 });
    h.s.enqueue('A', { body: 'ctl' }); // in flight forever
    for (const [e, b] of [
      [1, 1],
      [2, 2],
      [3, 1],
      [4, 2],
    ] as const) {
      for (let i = 0; i < 3; i++) h.s.enqueue('A', item(`e${e}`, e, b));
    }
    await waitFor(() => !h.s.referencedEpochs().has(1), 1500);
    assert.deepEqual([...h.s.referencedEpochs()].sort(), [3, 4]);
    h.s.close();
  }));

test('the replay hook is told which client the replay is for', () =>
  quiet(async () => {
    const h = harness();
    h.records.set(7, [item('R', 7, 2)]);
    h.s.resyncAll('A', [
      { epoch: 5, finished: true },
      { epoch: 7, finished: false },
    ]);
    assert.deepEqual(h.replays, [[7, false, 'A']]);
    assert.equal(h.sent.at(-1), '<1>R');
    h.s.close();
  }));

test('resyncAll appends each unfinished current game in board order', () =>
  quiet(async () => {
    const h = harness();
    h.setAck(true);
    h.records.set(1, [item('b1', 1, 1)]);
    h.records.set(2, [item('b2', 2, 2)]);
    h.s.resyncAll('A', [
      { epoch: 1, finished: false },
      { epoch: 2, finished: false },
    ]);
    await waitFor(() => h.sent.length === 2);
    assert.deepEqual(h.sent, ['<1>b1', '<2>b2']);
    h.s.close();
  }));

test('dropGameItems removes queued game and latest items, keeps control items and the in-flight one', () =>
  quiet(async () => {
    const h = harness();
    h.s.enqueue('A', item('inflight', 1, 1));
    h.s.enqueue('A', item('g', 1, 1));
    h.s.enqueue('A', { body: 'WPV: 1', latest: 'WPV' });
    h.s.enqueue('A', { body: 'CHAT: hi' });
    assert.equal(h.s.dropGameItems('A'), 2);
    assert.equal(h.s.depth('A'), 2); // in flight + CHAT
    h.setAck(true);
    h.s.ack('A', 1);
    await waitFor(() => h.sent.includes('<2>CHAT: hi'));
    h.s.close();
  }));

test('latest items of different boards do not replace each other', () =>
  quiet(async () => {
    const h = harness();
    h.s.enqueue('A', { body: 'ctl' }); // busy: latest items queue
    h.s.enqueue('A', { body: 'BOARD 1 WPV: a', latest: 'WPV@1' });
    h.s.enqueue('A', { body: 'BOARD 2 WPV: b', latest: 'WPV@2' });
    h.s.enqueue('A', { body: 'BOARD 1 WPV: c', latest: 'WPV@1' });
    h.setAck(true);
    h.s.ack('A', 1);
    await waitFor(() => h.sent.length >= 3);
    assert.deepEqual(h.sent.slice(1), ['BOARD 2 WPV: b', 'BOARD 1 WPV: c']);
    h.s.close();
  }));

test('hard cap never evicts a pinned control item (BOARDS:)', () =>
  quiet(async () => {
    const sent: string[] = [];
    const s = new ReliableSender({ rawSend: (p) => void sent.push(p), replay: () => null }, { hardCap: 3, maxQueue: 1000, initialRtoMs: 1000 });
    s.addClient('A');
    s.enqueue('A', { body: 'inflight' });
    s.enqueue('A', { body: 'BOARDS: 1 2', pinned: true });
    for (let i = 0; i < 5; i++) s.enqueue('A', { body: `c${i}` });
    assert.equal(s.depth('A'), 4); // in flight + 3 kept: the pinned one and the newest control items
    for (let i = 1; i <= 4; i++) s.ack('A', i);
    assert.ok(sent.includes('<2>BOARDS: 1 2'));
    s.close();
  }));

test('enqueueAll: a coalesce in between cannot split GAMENO from its result', () =>
  quiet(async () => {
    const recs = new Map<number, Outbound[]>();
    const s = new ReliableSender(
      { rawSend: () => {}, replay: (e, wr) => (wr ? recs.get(e)! : recs.get(e)!.filter((x) => !x.critical && !/GAMENO/.test(x.body))) },
      { maxQueue: 2, initialRtoMs: 1000 },
    );
    s.addClient('A');
    const g = [item('m1', 1, 2), item('m2', 1, 2), item('m3', 1, 2)];
    const no = item('BOARD 2 GAMENO: 4', 1, 2);
    const res = item('BOARD 2 result: 1-0', 1, 2, true);
    recs.set(1, [item('short', 1, 2), no, res]);
    s.enqueue('A', { body: 'inflight' });
    for (const x of g) s.enqueue('A', x);
    s.enqueueAll('A', [no, res]);
    assert.ok(s.referencedEpochs().has(1));
    // the queue now holds the replay with both lines, in order
    const bodies: string[] = [];
    const s2 = s as unknown as { clientsMap: Map<string, { queue: Outbound[] }> };
    for (const it of s2.clientsMap.get('A')!.queue) bodies.push(it.body);
    assert.deepEqual(bodies.slice(-2), ['BOARD 2 GAMENO: 4', 'BOARD 2 result: 1-0']);
    s.close();
  }));

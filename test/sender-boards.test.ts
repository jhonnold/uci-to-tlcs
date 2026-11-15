import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ReliableSender } from '../src/tlcs/reliable-sender.js';
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
function harness() {
  const sent: string[] = [];
  let ack = false;
  const s: ReliableSender = new ReliableSender(
    {
      rawSend: (p, d) => {
        sent.push(p);
        const m = /^<(\d+)>/.exec(p);
        if (m && ack) setTimeout(() => s.ack(d, Number(m[1])), 0);
      },
    },
    { initialRtoMs: 10, minRtoMs: 5, maxRtoMs: 20, giveUpMs: 5000, maxQueue: 1000 },
  );
  s.addClient('A');
  return { s, sent, setAck: (v: boolean) => void (ack = v) };
}

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
    const s = new ReliableSender({ rawSend: (p) => void sent.push(p) }, { hardCap: 3, maxQueue: 1000, initialRtoMs: 1000 });
    s.addClient('A');
    s.enqueue('A', { body: 'inflight' });
    s.enqueue('A', { body: 'BOARDS: 1 2', pinned: true });
    for (let i = 0; i < 5; i++) s.enqueue('A', { body: `c${i}` });
    assert.equal(s.depth('A'), 4); // in flight + 3 kept: the pinned one and the newest control items
    for (let i = 1; i <= 4; i++) s.ack('A', i);
    assert.ok(sent.includes('<2>BOARDS: 1 2'));
    s.close();
  }));

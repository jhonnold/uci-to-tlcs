import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReliableSender, type Outbound } from '../src/tlcs/reliable-sender.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function mk() {
  const sent: Array<{ t: number; payload: string }> = [];
  const acked: string[] = [];
  const s = new ReliableSender(
    { rawSend: (payload) => void sent.push({ t: performance.now(), payload }), replay: () => null, onAcked: (_d, it: Outbound) => void acked.push(it.body) },
    { initialRtoMs: 200, minRtoMs: 100, maxRtoMs: 400 },
  );
  s.addClient('c');
  return { s, sent, acked, ackLast: () => { const m = /^<(\d+)>/.exec(sent[sent.length - 1].payload); s.ack('c', Number(m![1])); } };
}

test('hold: nothing numbered is sent for holdMs after the ACK, then the next id goes out', async () => {
  const { s, sent, ackLast } = mk();
  s.enqueue('c', { body: 'one', holdMs: 60 });
  s.enqueue('c', { body: 'two' });
  assert.equal(sent.length, 1);
  const tAck = performance.now();
  ackLast();
  assert.equal(sent.length, 1, 'held');
  await sleep(30);
  assert.equal(sent.length, 1, 'still held');
  await sleep(60);
  assert.equal(sent.length, 2);
  assert.match(sent[1].payload, /^<2>two/);
  assert.ok(sent[1].t - tAck >= 55);
  s.close();
});

test('hold: a latest item enqueued during the hold is queued, not raw-sent, and goes out after it', async () => {
  const { s, sent, ackLast } = mk();
  s.enqueue('c', { body: 'one', holdMs: 50 });
  ackLast();
  s.enqueue('c', { body: 'PV', latest: 'WPV' });
  assert.equal(sent.length, 1);
  await sleep(90);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload, 'PV');
  s.close();
});

test('hold: removeClient during the hold clears the timer; nothing is sent afterwards', async () => {
  const { s, sent, ackLast } = mk();
  s.enqueue('c', { body: 'one', holdMs: 40 });
  s.enqueue('c', { body: 'two' });
  ackLast();
  s.removeClient('c');
  await sleep(80);
  assert.equal(sent.length, 1);
  s.close();
});

test('items without holdMs behave as before; onAcked fires per ACK', () => {
  const { s, sent, acked, ackLast } = mk();
  s.enqueue('c', { body: 'one' });
  s.enqueue('c', { body: 'two' });
  ackLast();
  assert.equal(sent.length, 2);
  assert.deepEqual(acked, ['one']);
  s.close();
});

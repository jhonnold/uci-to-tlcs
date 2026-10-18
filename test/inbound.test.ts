import { test } from 'node:test';
import assert from 'node:assert/strict';

import { InboundDeduper, parseAck, parseNumbered } from '../src/tlcs/inbound.js';

test('parseNumbered accepts <N> and < N>, keeps ">" in the body, rejects junk', () => {
  assert.deepEqual(parseNumbered('<42>PING'), { id: 42, body: 'PING' });
  assert.deepEqual(parseNumbered('< 42>PING'), { id: 42, body: 'PING' });
  assert.deepEqual(parseNumbered('<7>CHAT: a>b'), { id: 7, body: 'CHAT: a>b' });
  for (const bad of ['<0>x', '<>x', '<abc>x', 'PING']) assert.equal(parseNumbered(bad), null, bad);
});

test('parseAck tolerates spacing', () => {
  for (const ok of ['ACK: 42', 'ACK:42', 'ACK:   42']) assert.equal(parseAck(ok), 42, ok);
  for (const bad of ['ACKX', 'ACK: x', 'PING']) assert.equal(parseAck(bad), null, bad);
});

test('InboundDeduper: duplicates, independent keys, ring eviction, reset', () => {
  const d = new InboundDeduper(4);
  assert.equal(d.isDuplicate('a', 1), false);
  assert.equal(d.isDuplicate('a', 1), true);
  assert.equal(d.isDuplicate('b', 1), false);
  for (let i = 2; i <= 5; i++) d.isDuplicate('a', i);
  assert.equal(d.isDuplicate('a', 1), false, 'evicted after ring size');
  d.reset('a');
  assert.equal(d.isDuplicate('a', 5), false);
});

test('InboundDeduper.isDuplicateLogon: retransmitted LOGON is a duplicate, a restarted counter is not', () => {
  const d = new InboundDeduper();
  assert.equal(d.isDuplicateLogon('a', 1), false);
  assert.equal(d.isDuplicateLogon('a', 1), true, 'retransmit of the same LOGON');
  assert.equal(d.isDuplicate('a', 2), false);
  assert.equal(d.isDuplicateLogon('a', 1), false, 'client restarted: counter back at 1');
  assert.equal(d.isDuplicate('a', 2), false, 'ring was reset');
});

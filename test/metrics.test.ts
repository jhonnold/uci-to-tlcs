import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { Metrics, sentType, receivedType, startMetricsServer } from '../src/metrics.js';

test('metrics: inc/get with and without labels; label order is irrelevant', () => {
  const m = new Metrics();
  m.inc('tlcs_retransmits_total');
  m.inc('tlcs_retransmits_total', {}, 2);
  assert.equal(m.get('tlcs_retransmits_total'), 3);
  m.inc('tlcs_messages_sent_total', { type: 'FEN', x: 'a' });
  m.inc('tlcs_messages_sent_total', { x: 'a', type: 'FEN' });
  assert.equal(m.get('tlcs_messages_sent_total', { type: 'FEN', x: 'a' }), 2);
  assert.equal(m.get('tlcs_messages_sent_total', { type: 'nope' }), 0);
});

test('metrics: render on a fresh instance seeds known series, omits open-ended ones', () => {
  const m = new Metrics();
  const out = m.render();
  assert(out.endsWith('\n'));
  for (const n of ['tlcs_retransmits_total', 'tlcs_messages_sent_total']) {
    assert(out.includes(`# HELP ${n} `) && out.includes(`# TYPE ${n} counter`));
  }
  for (const l of [
    'tlcs_retransmits_total 0',
    'tlcs_giveups_total{kind="game"} 0',
    'tlcs_giveups_total{kind="control"} 0',
    'tlcs_giveups_total{kind="critical"} 0',
    'tlcs_resyncs_total{kind="full"} 0',
    'tlcs_resyncs_total{kind="giveup"} 0',
  ]) assert(out.split('\n').includes(l), l);
  assert(!out.includes('tlcs_messages_sent_total{'));
  m.inc('tlcs_giveups_total', { kind: 'game' });
  m.inc('tlcs_giveups_total', { kind: 'game' });
  assert(m.render().includes('tlcs_giveups_total{kind="game"} 2\n'));
});

test('metrics: label values are escaped', () => {
  const m = new Metrics();
  m.inc('tlcs_messages_sent_total', { type: 'a"b\\c\nd' });
  assert(m.render().includes('tlcs_messages_sent_total{type="a\\"b\\\\c\\nd"} 1\n'));
});

const fake = {
  clientList: () => [{ dest: '1.2.3.4:5' }, { dest: '6.7.8.9:10' }],
  queueDepth: (d: string) => (d === '1.2.3.4:5' ? 3 : 0),
};

test('metrics: gauges render from the source', () => {
  const out = new Metrics().render([
    { name: 'tlcs_clients', help: 'c', samples: [[{}, 2]] },
    { name: 'tlcs_client_queue_depth', help: 'q', samples: [[{ dest: '1.2.3.4:5' }, 3]] },
  ]);
  assert(out.includes('tlcs_clients 2\n'));
  assert(out.includes('tlcs_client_queue_depth{dest="1.2.3.4:5"} 3\n'));
});

test('metrics: sentType / receivedType', () => {
  assert.equal(sentType('<12>FEN: x'), 'FEN');
  assert.equal(sentType('ACK: 3'), 'ACK');
  assert.equal(sentType('LOGON SUCCESSFUL'), 'LOGON');
  assert.equal(sentType('result 1-0'), 'result');
  assert.equal(sentType('<3>'), 'other');
  assert.equal(receivedType('< 42>CHAT: hi'), 'CHAT');
  assert.equal(receivedType('LOGONv15:bob'), 'LOGONv15');
  assert.equal(receivedType('XYZZY'), 'other');
});

test('metrics: HTTP serves /metrics, 404 elsewhere', async () => {
  const srv = startMetricsServer(0, '127.0.0.1', fake);
  try {
    if (!srv.listening) await new Promise<void>((r) => srv.once('listening', () => r()));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const r = await fetch(`${base}/metrics`);
    assert.equal(r.status, 200);
    assert((r.headers.get('content-type') ?? '').startsWith('text/plain; version=0.0.4'));
    const body = await r.text();
    assert(body.includes('tlcs_clients 2\n'));
    assert(body.includes('tlcs_client_queue_depth{dest="1.2.3.4:5"} 3\n'));
    assert.equal((await fetch(`${base}/`)).status, 404);
  } finally {
    srv.close();
  }
});

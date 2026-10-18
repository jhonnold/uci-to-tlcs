import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DesktopReceiver,
  DesktopSender,
  LossInjector,
  NodeTlcvReceiver,
  ReloginLimiter,
  SilenceMonitor,
  desktopField,
  resolveBind,
} from '../scripts/lib/mock-core.js';
import { isIdRestart, isLive, mid, parseDesktop, parseNodeTlcv, splitOnCommand } from '../scripts/lib/tlcs-frame.js';
import { MockSession } from '../scripts/lib/mock-session.js';
import { TlcsServer } from '../src/tlcs/server.js';

test('framing: node-tlcv view', () => {
  assert.deepEqual(parseNodeTlcv('<42>X'), { numbered: true, idString: '42', id: 42, body: 'X' });
  const sp = parseNodeTlcv('< 42>X');
  assert.equal(sp.id, 42);
  assert.equal(sp.idString, ' 42');
  assert.equal(parseNodeTlcv('<1>a>b>c').body, 'a>b>c');
  assert.equal(parseNodeTlcv('<42>X\r\n').body, 'X');
  assert.equal(parseNodeTlcv('PONG').numbered, false);
});

test('framing: desktop view', () => {
  assert.equal(parseDesktop('<42>X').id, 42);
  assert.equal(parseDesktop('< 42>X').id, 42);
  for (const s of ['<0>X', '<>X', '<abc>X']) assert.equal(parseDesktop(s).numbered, false, s);
  assert.equal(parseDesktop('<abc>X').body, '<abc>X');
  assert.equal(parseDesktop('<42>SITE: x ').body, 'SITE: x ');
  assert.equal(parseDesktop('<7>a>b').body, 'a>b');
  const d = new DesktopReceiver();
  assert.equal(d.receive('<42>LOGON SUCCESSFUL\r\n').verdict, 'gated');
  assert.equal(d.gate, false);
});

test('ACK strings differ by model', () => {
  assert.equal(new NodeTlcvReceiver().receive('< 42>X').ack, 'ACK:  42');
  assert.equal(new DesktopReceiver().receive('< 42>X').ack, 'ACK: 42');
});

test('isIdRestart', () => {
  const cases: Array<[number, number, boolean]> = [[1, 5, true], [4, 5, false], [50, 500, true], [50, 120, false], [101, 500, false], [5, 5, false]];
  for (const [id, last, exp] of cases) assert.equal(isIdRestart(id, last), exp, `${id},${last}`);
});

test('splitOnCommand / liveness', () => {
  for (const b of ['FEN: x', 'WMOVE: 1. e4', 'result 1-0']) assert.equal(isLive(b), true, b);
  for (const b of ['PONG', 'MSG: hi', 'LOGON SUCCESSFUL', 'ADDUSER: x', 'FEATURE: PING', 'MENU: x', 'level 40 5 0', 'FOO: x']) {
    assert.equal(isLive(b), false, b);
  }
  assert.equal(splitOnCommand('FOO: x'), null);
});

test('NodeTlcvReceiver id sequence', () => {
  const r = new NodeTlcvReceiver();
  const v = [1, 2, 3, 3, 2, 1, 2].map((i) => r.receive(`<${i}>PONG`));
  assert.deepEqual(v.map((x) => x.verdict), ['accepted', 'accepted', 'accepted', 'out-of-order', 'out-of-order', 'restart', 'accepted']);
  assert.equal(v[3].ack, 'ACK: 3');
});

test('DesktopReceiver gate, ring, fields', () => {
  const d = new DesktopReceiver();
  const g = d.receive('<1>FEN: x');
  assert.equal(g.verdict, 'gated');
  assert.equal(g.ack, 'ACK: 1');
  assert.equal(d.receive('LOGON SUCCESSFUL').verdict, 'accepted');
  assert.equal(d.receive('<5>PONG').verdict, 'accepted');
  assert.equal(d.receive('<5>PONG').verdict, 'duplicate');
  assert.equal(d.receive('<3>PONG').verdict, 'accepted'); // no ordering check
  for (let i = 10; i < 111; i++) d.receive(`<${i}>PONG`);
  assert.equal(d.receive('<5>PONG').verdict, 'accepted'); // evicted
  assert.equal(d.receive('FEATURE: PING').featurePing, true);
  assert.equal(d.receive('<200>ACK: 4').ackedId, 4);
  assert.deepEqual(desktopField('SITE: My Event'), { name: 'SITE', value: ' My Event' });
  assert.deepEqual(desktopField('WPLAYER: Berserk A'), { name: 'WPLAYER', value: 'Berserk A' });
  assert.equal(mid('abcdef', 4), 'def');
});

test('ReloginLimiter', () => {
  let now = 1000;
  const l = new ReloginLimiter(() => now, 60_000, 600_000);
  assert.equal(l.allow(), true);
  now += 1000;
  assert.equal(l.allow(), false);
  l.noteData(now); // live data after the attempt
  now += 1000;
  assert.equal(l.allow(), true);
  // non-live burst never calls noteData -> blocked
  now += 1000;
  assert.equal(l.allow(), false);
  now += 60_000;
  assert.equal(l.allow(), true);
  // same-stamp ordering: data stamped at the same instant as the attempt does not recover
  const l2 = new ReloginLimiter(() => now, 60_000, 600_000);
  assert.equal(l2.allow(now), true);
  l2.noteData(now);
  assert.equal(l2.allow(now), false);
  l2.close();
  now += 120_000;
  assert.equal(l2.allow(now), false);
});

test('ReloginLimiter watchdog', () => {
  let now = 5000;
  const l = new ReloginLimiter(() => now, 60_000, 600_000);
  now += 600_000;
  assert.equal(l.watchdogDue(now), false);
  now += 1;
  assert.equal(l.watchdogDue(now), true);
});

test('DesktopSender', () => {
  const s = new DesktopSender();
  assert.equal(s.send('PING', 0), '< 1>PING');
  assert.equal(s.send('PING', 0), '< 2>PING');
  assert.deepEqual(s.tick(500).resend, []);
  assert.deepEqual(s.tick(1500).resend, ['< 1>PING', '< 2>PING']);
  s.ack(1);
  assert.deepEqual(s.tick(3000).resend, ['< 2>PING']);
  let t = 3000;
  let gave: number[] = [];
  for (let i = 0; i < 40 && !gave.length; i++) gave = s.tick((t += 1500)).giveups;
  assert.deepEqual(gave, [2]);
  assert.equal(s.pending, 0);
});

test('SilenceMonitor', () => {
  const m = new SilenceMonitor(0);
  assert.deepEqual(m.check(9_000), []);
  assert.deepEqual(m.check(35_000), ['slow', 'very slow']);
  m.reset(35_000);
  assert.deepEqual(m.check(105_000), ['slow', 'very slow', 'no response', 'disconnect']);
});

test('LossInjector', () => {
  const seq = (seed: number) => {
    const l = new LossInjector(0.5, 0.5, seed);
    return Array.from({ length: 50 }, () => JSON.stringify(l.decide('in', '<1>x')));
  };
  assert.deepEqual(seq(3), seq(3));
  assert.notDeepEqual(seq(3), seq(4));
  const none = new LossInjector(0, 0, 1);
  assert.ok(Array.from({ length: 100 }, () => none.decide('in', 'x')).every((d) => d.kind === 'pass'));
  const all = new LossInjector(1, 0, 1);
  assert.ok(Array.from({ length: 100 }, () => all.decide('out', 'ACK: 1')).every((d) => d.kind === 'drop'));
  assert.ok(Array.from({ length: 100 }, () => all.decide('out', 'LOGONv15:x')).every((d) => d.kind === 'pass'));
});

test('resolveBind', () => {
  assert.deepEqual(resolveBind({ bind: '', port: 16066, ephemeral: false }), { address: '127.0.0.2', port: 16066 });
  assert.deepEqual(resolveBind({ bind: '', port: 1, ephemeral: true }), { address: '127.0.0.1', port: 0 });
  assert.deepEqual(resolveBind({ bind: '', port: 1, ephemeral: false, localPort: 16450 }), { address: '127.0.0.1', port: 16450 });
  assert.deepEqual(resolveBind({ bind: '127.0.0.3', port: 1, ephemeral: false, localPort: 1 }), { address: '127.0.0.3', port: 1 });
  assert.throws(() => resolveBind({ bind: '', port: 1, ephemeral: true, localPort: 5 }));
});

test('integration: desktop session against TlcsServer', async () => {
  const server = new TlcsServer({ port: 0, bindAddr: '127.0.0.1' });
  await new Promise<void>((r) => server.start(() => r()));
  const port = server.address().port;
  let code: number | undefined;
  const s = new MockSession({
    server: '127.0.0.1', port, bind: '', ephemeral: true, user: 'it', mode: 'desktop', drop: 0, reorder: 0, seed: 1,
    quiet: true, reloginMin: 60, dataTimeout: 600, forcePing: false, noDisconnect: true, exitAfter: 1, onExit: (c) => (code = c),
  });
  s.start();
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(s.gateOpen, true);
  assert.equal(code, 0);
  server.close();
});

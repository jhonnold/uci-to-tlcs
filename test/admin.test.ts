import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  AdminCommands,
  BanList,
  RateLimiter,
  redactSecrets,
  MSG_BOOTED,
  MSG_FULL,
  RATE_DEFAULT,
  type AdminHost,
  type AdminOptions,
} from '../src/tlcs/admin.js';
import { MSG_NOT_CONNECTED } from '../src/tlcs/commands.js';
import { logger } from '../src/util/logger.js';
import type { ClientInfo } from '../src/tlcs/server.js';

interface Call {
  fn: string;
  dest: string | null;
  body: string;
}

class FakeHost implements AdminHost {
  clients = new Map<string, ClientInfo>();
  calls: Call[] = [];
  enqueue(dest: string | null, body: string): void {
    this.calls.push({ fn: 'enqueue', dest, body });
  }
  sendRaw(dest: string, body: string): void {
    this.calls.push({ fn: 'sendRaw', dest, body });
  }
  removeClient(dest: string): ClientInfo | undefined {
    const c = this.clients.get(dest);
    this.clients.delete(dest);
    this.calls.push({ fn: 'removeClient', dest, body: '' });
    return c;
  }
  getClient(dest: string): Readonly<ClientInfo> | undefined {
    return this.clients.get(dest);
  }
  clientList(): Array<{ dest: string } & Readonly<ClientInfo>> {
    return Array.from(this.clients, ([dest, c]) => ({ dest, ...c }));
  }
  add(ip: string, port: number, user: string): string {
    this.clients.set(`${ip}:${port}`, { ip, port, user, lastSeen: 0 });
    return `${ip}:${port}`;
  }
  take(): Call[] {
    const c = this.calls;
    this.calls = [];
    return c;
  }
}

const P = 'CHAT: [SERVER] ';
const A = '10.0.0.1';

function setup(over: Partial<AdminOptions> = {}) {
  const host = new FakeHost();
  const clock = { t: 1_000_000 };
  const adm = new AdminCommands(host, {
    adminPass: 'pw',
    maxClients: 0,
    bannedIps: [],
    rateLimit: RATE_DEFAULT,
    now: () => clock.t,
    ...over,
  });
  const send = (port: number, msg: string, ip = A): boolean => adm.handle(msg, ip, port);
  return { host, adm, clock, send };
}
const raws = (h: FakeHost) => h.take().filter((c) => c.fn === 'sendRaw').map((c) => c.body);

test('redactSecrets', () => {
  for (const s of ['ADMIN:pw', '< 3>ADMIN: pw', 'admin : pw', 'CHAT: (u) Admin:pw']) {
    const r = redactSecrets(s);
    assert(!r.includes('pw'), r);
    assert(r.includes('ADMIN:***'), r);
  }
  assert.equal(redactSecrets('CHAT: hi'), 'CHAT: hi');
  for (const m of ['A\x01DMIN:pw', 'CHAT: ADMIN\x01:pw', 'ad\x7fmin \x02: pw']) assert.equal(redactSecrets(m).includes('pw'), false, m);
});

test('disabled: every admin command only says disabled', () => {
  for (const adminPass of [undefined, '', '  ']) {
    const { host, adm, send } = setup({ adminPass });
    host.add(A, 1, 'a');
    assert.equal(adm.enabled, false);
    host.take();
    for (const m of ['ADMIN:x', 'admin :x', 'SECURITY', 'BOOT:a', 'SRBOOT:a']) {
      assert(send(1, m));
      assert.deepEqual(host.take(), [{ fn: 'sendRaw', dest: `${A}:1`, body: P + 'Admin commands are disabled' }]);
    }
  }
});

test('ADMIN from an unknown dest: not connected, no failure counted', () => {
  const { host, send } = setup();
  send(1, 'ADMIN:bad');
  assert.deepEqual(raws(host), [MSG_NOT_CONNECTED]);
  host.add(A, 1, 'a');
  for (let i = 0; i < 5; i++) send(1, 'ADMIN:bad');
  assert.deepEqual(raws(host), Array(5).fill(P + 'Admin access denied'));
});

test('lockout is per dest (ip:port), not per IP; expires; survives forget', () => {
  const { host, adm, clock, send } = setup();
  host.add(A, 1, 'a');
  host.add(A, 2, 'b');
  host.take();
  for (let i = 0; i < 5; i++) send(1, 'ADMIN:bad');
  assert.deepEqual(raws(host), Array(5).fill(P + 'Admin access denied'));
  send(1, 'ADMIN:pw');
  assert.deepEqual(raws(host), [P + 'Admin login locked, try later']);
  send(2, 'ADMIN:pw'); // same IP, other port
  assert.deepEqual(raws(host), [P + 'Admin access granted']);
  adm.forget(`${A}:1`);
  send(1, 'ADMIN:pw');
  assert.deepEqual(raws(host), [P + 'Admin login locked, try later']);
  clock.t += 600_001;
  send(1, 'ADMIN:pw');
  assert.deepEqual(raws(host), [P + 'Admin access granted']);
  send(1, 'ADMIN:bad');
  send(1, 'ADMIN:pw');
  send(1, 'ADMIN:pw');
  assert.equal(raws(host).filter((m) => m.includes('denied')).length, 1, 'a success clears the failures');
});

test('secret match is case/whitespace tolerant; 5 failures then 10 min: 5 fresh', () => {
  const { host, send } = setup({ adminPass: ' s3cr et' });
  host.add(A, 1, 'a');
  host.take();
  for (const m of ['admin:s3cr et', 'ADMIN :  s3cr et ', '\x01ADMIN:s3cr et']) {
    send(1, m);
    assert.deepEqual(raws(host), [P + 'Admin access granted'], m);
  }
});

test('admin-like CHAT is consumed silently, enabled or not, known or not', () => {
  for (const o of [{}, { adminPass: undefined }]) {
    const { host, send } = setup(o);
    for (const m of ['CHAT: ADMIN:pw', 'CHAT: admin : pw', 'CHAT: (web) ADMIN:pw', 'CHAT: \x01Admin:pw', 'CHAT: (a)b) ADMIN:x']) {
      assert.equal(send(1, m), true, m);
      host.add(A, 1, 'a');
      assert.equal(send(1, m), true, m);
      host.clients.clear();
    }
    assert.deepEqual(host.take(), []);
  }
  const { send } = setup();
  for (const m of ['CHAT: hello', 'CHAT: the admin is away', 'CHAT: (web) hi admin: x']) assert.equal(send(1, m), false, m);
});

test('SECURITY: not authorized before a grant, SECUSER lines after', () => {
  const { host, send } = setup();
  host.add(A, 1, 'alice');
  host.add('10.0.0.2', 2, 'bob');
  host.take();
  send(1, 'SECURITY');
  assert.deepEqual(raws(host), [P + 'Not authorized']);
  send(1, 'ADMIN:pw');
  host.take();
  send(1, 'SECURITY');
  assert.deepEqual(host.take(), [
    { fn: 'sendRaw', dest: `${A}:1`, body: 'SECUSER: alice:10.0.0.1' },
    { fn: 'sendRaw', dest: `${A}:1`, body: 'SECUSER: bob:10.0.0.2' },
  ]);
});

test('BOOT targets by IP, ip:port, name; unknown; order of effects', () => {
  const { host, send } = setup();
  host.add(A, 1, 'admin');
  send(1, 'ADMIN:pw');
  host.add('10.0.0.2', 5, 'v1');
  host.add('10.0.0.2', 6, 'v2');
  host.add('10.0.0.3', 7, 'v3');
  host.add('10.0.0.4', 8, 'v4');
  host.take();
  send(1, 'BOOT:10.0.0.2');
  assert.deepEqual(host.take().map((c) => `${c.fn}:${c.dest}:${c.body}`), [
    `sendRaw:10.0.0.2:5:${MSG_BOOTED}`,
    'removeClient:10.0.0.2:5:',
    'enqueue:*:DELUSER: v1'.replace('*', 'null'),
    'enqueue:null:CHAT: [SERVER] - v1 has left!',
    `sendRaw:10.0.0.2:6:${MSG_BOOTED}`,
    'removeClient:10.0.0.2:6:',
    'enqueue:null:DELUSER: v2',
    'enqueue:null:CHAT: [SERVER] - v2 has left!',
  ]);
  send(1, 'BOOT:10.0.0.3:7');
  assert(!host.clients.has('10.0.0.3:7'));
  send(1, 'BOOT:v4');
  assert(!host.clients.has('10.0.0.4:8'));
  host.take();
  send(1, 'BOOT:x\x01y');
  assert.deepEqual(raws(host), [P + 'No such user: xy']);
});

test('SRBOOT bans; refuses own IP; ring of 100 evicts, config bans stay', () => {
  const { host, adm, send } = setup({ bannedIps: ['9.9.9.9'] });
  host.add(A, 1, 'admin');
  send(1, 'ADMIN:pw');
  host.add('10.0.0.2', 2, 'v');
  host.take();
  send(1, 'SRBOOT:admin');
  assert.deepEqual(raws(host), [P + 'Refusing to ban your own IP']);
  assert(host.clients.has(`${A}:1`));
  send(1, 'SRBOOT:v');
  assert.equal(adm.isBanned('10.0.0.2'), true);
  assert(!host.clients.has('10.0.0.2:2'));
  assert.equal(adm.isBanned('9.9.9.9'), true);
  for (let i = 0; i < 100; i++) {
    host.add(`10.1.0.${i}`, 9, `u${i}`);
    send(1, `SRBOOT:10.1.0.${i}`);
  }
  assert.equal(adm.isBanned('10.0.0.2'), false, 'oldest evicted');
  assert.equal(adm.isBanned('10.1.0.99'), true);
  assert.equal(adm.isBanned('9.9.9.9'), true);
});

test('forget revokes; a grant does not cover another port on the same IP', () => {
  const { host, adm, send } = setup();
  host.add(A, 1, 'a');
  host.add(A, 2, 'b');
  send(1, 'ADMIN:pw');
  host.take();
  send(2, 'SECURITY');
  assert.deepEqual(raws(host), [P + 'Not authorized']);
  adm.forget(`${A}:1`);
  send(1, 'SECURITY');
  assert.deepEqual(raws(host), [P + 'Not authorized']);
});

test('admitLogon: MAXCLIENTS', () => {
  const unl = setup();
  unl.host.add(A, 1, 'a');
  assert.equal(unl.adm.admitLogon(`${A}:9`, true), true);

  const { host, adm, clock } = setup({ maxClients: 1 });
  host.add(A, 1, 'a');
  assert.equal(adm.admitLogon(`${A}:2`, true), false);
  assert.deepEqual(raws(host), [MSG_FULL]);
  assert.equal(adm.admitLogon(`${A}:2`, true), false);
  assert.deepEqual(raws(host), [], 'notice once per minute');
  clock.t += 60_001;
  assert.equal(adm.admitLogon(`${A}:2`, true), false);
  assert.deepEqual(raws(host), [MSG_FULL]);
  assert.equal(adm.admitLogon(`${A}:1`, false), true, 're-logon is always admitted');
});

test('RateLimiter token bucket', () => {
  let t = 0;
  const rl = new RateLimiter({ burst: 3, perSec: 1 }, () => t);
  assert.deepEqual([1, 2, 3, 4].map(() => rl.allow('a')), [true, true, true, false]);
  assert.equal(rl.allow('b'), true);
  t += 1000;
  assert.deepEqual([rl.allow('a'), rl.allow('a')], [true, false]);
  t += 10_000;
  rl.prune();
  assert.equal(rl.allow('a'), true);
});

test('BanList keeps config bans', () => {
  const b = new BanList(['1.1.1.1']);
  assert(b.has('1.1.1.1'));
  assert(!b.has('2.2.2.2'));
  b.add('2.2.2.2');
  assert(b.has('2.2.2.2'));
});

test('allowDatagram warns once per minute per IP when dropping', () => {
  const warn = mock.method(logger, 'warn', () => {});
  try {
    const { adm } = setup({ rateLimit: { burst: 1, perSec: 0.001 } });
    assert.equal(adm.allowDatagram('1.2.3.4'), true);
    for (let i = 0; i < 5; i++) assert.equal(adm.allowDatagram('1.2.3.4'), false);
    assert.equal(warn.mock.callCount(), 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /rate limit.*1\.2\.3\.4/);
  } finally {
    warn.mock.restore();
  }
});

test('the secret and wrong candidates are never logged', () => {
  const lines: string[] = [];
  const ms = (['info', 'warn', 'debug'] as const).map((k) => mock.method(logger, k, (s: unknown) => void lines.push(String(s))));
  try {
    const { host, send } = setup({ adminPass: 'topsecret-pw' });
    host.add(A, 1, 'a');
    host.add(A, 2, 'v');
    send(1, 'ADMIN:wrong-guess-1');
    send(1, 'ADMIN:topsecret-pw');
    send(1, 'CHAT: (x) ADMIN:leak-zz');
    send(1, 'BOOT:v');
    assert(lines.length > 0);
    for (const l of lines) assert(!/topsecret|wrong-guess|leak-zz/.test(l), l);
  } finally {
    for (const m of ms) m.mock.restore();
  }
});

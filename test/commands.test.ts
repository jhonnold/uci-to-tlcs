import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  SessionCommands,
  sanitizeName,
  sanitizeText,
  uniqueName,
  packageVersion,
  MSG_NOT_CONNECTED,
  MSG_OLD_VIEWER,
  MSG_NO_EMAIL,
  type SessionHost,
} from '../src/tlcs/commands.js';
import type { ClientInfo } from '../src/tlcs/server.js';

interface Call {
  fn: string;
  dest: string | null;
  body: string;
}

class FakeHost implements SessionHost {
  clients = new Map<string, ClientInfo>();
  calls: Call[] = [];
  t = 1_000_000;
  enqueue(dest: string | null, body: string): void {
    this.calls.push({ fn: 'enqueue', dest, body });
  }
  sendRaw(dest: string, body: string): void {
    this.calls.push({ fn: 'sendRaw', dest, body });
  }
  addClient(ip: string, port: number, user: string): boolean {
    const d = `${ip}:${port}`;
    const isNew = !this.clients.has(d);
    this.calls.push({ fn: 'addClient', dest: d, body: user });
    this.clients.set(d, { ip, port, user, lastSeen: this.t });
    return isNew;
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
  resync(dest: string): void {
    this.calls.push({ fn: 'resync', dest, body: '' });
  }
  queueDepth(): number {
    return 3;
  }
  take(): Call[] {
    const c = this.calls;
    this.calls = [];
    return c;
  }
}

const H = '127.0.0.1';
function setup(menus: string[] = [], timeout = 70000) {
  const host = new FakeHost();
  const sc = new SessionCommands(host, { menus, clientTimeoutMs: timeout, now: () => host.t });
  const logon = (port: number, name: string) => sc.handle(`LOGONv15:${name}`, H, port);
  return { host, sc, logon };
}
const seq = (calls: Call[]) => calls.map((c) => (c.fn === 'resync' ? 'resync' : `${c.fn}:${c.dest ?? '*'}:${c.body}`));

test('sanitize / uniqueName', () => {
  assert.equal(sanitizeName('Desk<Bob>:1'), 'DeskBob1');
  assert.equal(sanitizeName('a\x01b'), 'ab');
  assert.equal(sanitizeName('  x  '), 'x');
  assert.equal(sanitizeName('x'.repeat(40)).length, 30);
  for (const e of ['', '  ', ':<>']) assert.equal(sanitizeName(e), 'Anonymous');
  assert.equal(sanitizeText('a\nb\x7fc '), 'abc');
  assert.equal(sanitizeText('a:<b>'), 'a:<b>');
  assert.equal(uniqueName('a', new Set()), 'a');
  assert.equal(uniqueName('a', new Set(['a'])), 'a 1');
  assert.equal(uniqueName('a', new Set(['a', 'a 1'])), 'a 2');
});

test('old LOGON: is refused', () => {
  const { host, sc } = setup();
  assert.equal(sc.handle('LOGON:x', H, 1), true);
  assert.deepEqual(host.take(), [{ fn: 'sendRaw', dest: `${H}:1`, body: MSG_OLD_VIEWER }]);
});

test('logon burst order and fan-out', () => {
  const { host, sc, logon } = setup(['MENU1', 'MENU2']);
  logon(1, 'o1');
  logon(2, 'o2');
  host.take();
  logon(3, 'new');
  const calls = host.take();
  const d = `${H}:3`;
  assert.deepEqual(seq(calls.filter((c) => c.dest === d || c.fn === 'resync')), [
    `addClient:${d}:new`,
    `sendRaw:${d}:LOGON SUCCESSFUL`,
    `enqueue:${d}:FEATURE: PING`,
    'resync',
    `enqueue:${d}:ADDUSER: new`,
    `enqueue:${d}:ADDUSER: o1`,
    `enqueue:${d}:ADDUSER: o2`,
    `enqueue:${d}:MENU1`,
    `enqueue:${d}:MENU2`,
  ]);
  for (const p of [1, 2]) {
    const o = seq(calls.filter((c) => c.dest === `${H}:${p}`));
    assert.deepEqual(o, [`enqueue:${H}:${p}:ADDUSER: new`, `enqueue:${H}:${p}:CHAT: [Server] new has arrived!`]);
  }
  assert.equal(sc.stats.connects, 3);
});

test('empty names -> Anonymous; taken name suffixed', () => {
  const { host, sc, logon } = setup();
  sc.handle('LOGONv15:', H, 1);
  sc.handle('LOGONv15', H, 2);
  assert.deepEqual([...host.clients.values()].map((c) => c.user), ['Anonymous', 'Anonymous 1']);
  logon(3, 'bob');
  logon(4, 'bob');
  assert.equal(host.clients.get(`${H}:4`)!.user, 'bob 1');
});

test('same-dest re-logon: same name keeps slot, no fan-out; new name sends DELUSER', () => {
  const { host, logon } = setup();
  logon(1, 'a');
  logon(2, 'b');
  host.take();
  logon(2, 'b');
  let calls = host.take();
  assert.equal(host.clients.get(`${H}:2`)!.user, 'b');
  assert(!calls.some((c) => c.body.startsWith('DELUSER')));
  assert(!calls.some((c) => c.dest === `${H}:1`), 'no fan-out');
  assert(calls.some((c) => c.body === 'LOGON SUCCESSFUL'));
  logon(2, 'c');
  calls = host.take();
  const mine = calls.filter((c) => c.dest === `${H}:2`).map((c) => c.body);
  assert(mine.indexOf('DELUSER: b') + 1 === mine.indexOf('ADDUSER: c'));
  assert.deepEqual(
    calls.filter((c) => c.dest === `${H}:1`).map((c) => c.body),
    ['DELUSER: b', 'ADDUSER: c'],
  );
});

test('LOGOFF', () => {
  const { host, sc, logon } = setup();
  logon(1, 'a');
  host.take();
  sc.handle('LOGOFF', H, 9);
  assert.deepEqual(host.take(), []);
  sc.handle('LOGOFF', H, 1);
  assert.deepEqual(seq(host.take()), [`removeClient:${H}:1:`, 'enqueue:*:DELUSER: a', 'enqueue:*:CHAT: [SERVER] - a has left!']);
});

test('CHANGE', () => {
  const { host, sc, logon } = setup();
  logon(1, 'a');
  logon(2, 'Probe');
  host.take();
  sc.handle('CHANGE: Probe', H, 1);
  assert.deepEqual(seq(host.take()), [
    `addClient:${H}:1:Probe 1`,
    'enqueue:*:DELUSER: a',
    'enqueue:*:ADDUSER: Probe 1',
    'enqueue:*:CHAT: [SERVER] - Alias changed from a to Probe 1',
  ]);
  sc.handle('CHANGE:Probe 1', H, 1);
  assert.deepEqual(host.take(), []);
  sc.handle('CHANGE: Zed', H, 1);
  assert.equal(host.clients.get(`${H}:1`)!.user, 'Zed');
  host.take();
  sc.handle('CHANGE: Q', H, 77);
  assert.deepEqual(host.take(), [{ fn: 'sendRaw', dest: `${H}:77`, body: MSG_NOT_CONNECTED }]);
});

test('CHAT relay and sanitising', () => {
  const { host, sc, logon } = setup();
  logon(1, 'alice');
  host.take();
  sc.handle('CHAT: hi there', H, 1);
  sc.handle('CHAT: a\x01b', H, 1);
  sc.handle('CHAT:', H, 1);
  assert.deepEqual(seq(host.take()), ['enqueue:*:CHAT: [alice] - hi there', 'enqueue:*:CHAT: [alice] - ab']);
  sc.handle('CHAT: hi', H, 9);
  assert.deepEqual(host.take(), [{ fn: 'sendRaw', dest: `${H}:9`, body: MSG_NOT_CONNECTED }]);
});

test('private queries are unicast', () => {
  const { host, sc, logon } = setup();
  logon(1, 'alice');
  logon(2, 'bob');
  host.take();
  const ask = (q: string) => {
    sc.handle(`CHAT: ${q}`, H, 1);
    return host.take();
  };
  const want = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const check = (q: string, re: RegExp[]) => {
    const c = ask(q);
    assert.equal(c.length, re.length, q);
    c.forEach((x, i) => {
      assert.equal(x.fn, 'sendRaw');
      assert.equal(x.dest, `${H}:1`);
      assert.match(x.body, re[i]);
    });
  };
  check('<who>', [/^CHAT: \[SERVER\] Users=2$/]);
  check('<time>', [/^CHAT: \[SERVER\] Date=\d\d-\d\d-\d{4}, Time=\d\d:\d\d:\d\d$/]);
  check('<ver>', [new RegExp(`^CHAT: \\[SERVER\\] Version uci-to-tlcs ${want.replace(/\./g, '\\.')}$`)]);
  assert.equal(packageVersion(), want);
  check('<stats>', [/connects: 2/, /result table/, /e-mails/, /Chat relay/, /Server start: /]);
  check('<q>', [/Dropped=0/, /Re-send queue=3/, /Message queue=6/]);
});

test('VOTE ignored; EMAIL/SEND refused', () => {
  const { host, sc, logon } = setup();
  logon(1, 'a');
  host.take();
  assert.equal(sc.handle('VOTE: x', H, 1), true);
  assert.deepEqual(host.take(), []);
  sc.handle('EMAIL: a@b', H, 1);
  sc.handle('SEND: 1', H, 1);
  assert.deepEqual(host.take().map((c) => c.body), [MSG_NO_EMAIL, MSG_NO_EMAIL]);
  assert.equal(sc.stats.emails, 2);
});

test('PING: known -> PONG; unknown notice with numbered-only rate limit', () => {
  const { host, sc, logon } = setup();
  logon(1, 'a');
  host.take();
  sc.handle('PING', H, 1);
  sc.handle('PING', H, 1, true);
  assert.deepEqual(host.take().map((c) => `${c.fn}:${c.body}`), ['enqueue:PONG', 'enqueue:PONG']);

  const n = () => host.take().filter((c) => c.body === MSG_NOT_CONNECTED).length;
  for (let i = 0; i < 3; i++) {
    sc.handle('PING', H, 5);
    host.t += 10_000;
  }
  assert.equal(n(), 3, 'plain PING never rate limited');
  sc.handle('PING', H, 6, true);
  assert.equal(n(), 1);
  host.t += 10_000;
  sc.handle('PING', H, 6, true);
  assert.equal(n(), 0);
  host.t += 51_000;
  sc.handle('PING', H, 6, true);
  assert.equal(n(), 1);
  // logon clears the limiter
  sc.handle('PING', H, 6, true);
  assert.equal(n(), 0);
  logon(6, 'x');
  sc.handle('LOGOFF', H, 6);
  host.take();
  sc.handle('PING', H, 6, true);
  assert.equal(n(), 1);
  // CHAT / CHANGE never limited
  sc.handle('CHAT: a', H, 7);
  sc.handle('CHAT: a', H, 7);
  sc.handle('CHANGE: a', H, 7);
  assert.equal(n(), 3);
});

test('reap: idle clients removed, announced, counted; limiter pruned', () => {
  const { host, sc, logon } = setup([], 70000);
  logon(1, 'stale');
  host.t += 50_000;
  logon(2, 'fresh');
  host.t += 30_000; // stale idle 80 s, fresh 30 s
  host.take();
  sc.reap();
  assert.deepEqual(seq(host.take()), [
    `removeClient:${H}:1:`,
    'enqueue:*:DELUSER: stale',
    'enqueue:*:CHAT: [SERVER] - Lost connection with stale',
  ]);
  assert.equal(sc.stats.dropped, 1);
  assert([...host.clients.keys()].join() === `${H}:2`);
  // limiter pruned: after >60 s the entry is gone (observable via a notice at +61 s even without reap, so just ensure no throw)
  sc.handle('PING', H, 9, true);
  host.t += 61_000;
  sc.reap();
  host.take();
  sc.handle('PING', H, 9, true);
  assert.equal(host.take().length, 1);
});

test('handle returns false for RESULTTABLE (counted) and unknown', () => {
  const { sc } = setup();
  assert.equal(sc.handle('RESULTTABLE', H, 1), false);
  assert.equal(sc.stats.resultTableRequests, 1);
  assert.equal(sc.handle('FOO', H, 1), false);
});

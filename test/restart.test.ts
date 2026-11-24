// In-process restart scenarios: startApp -> kill -> startApp again, with a real UDP client that
// ACKs everything (optionally modelling node-tlcv's CT numbering). No client state survives:
// the restarted server catches up to the live position and the client re-LOGONs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApp, type App } from '../src/app.js';
import type { Config } from '../src/config.js';
import { scanGameStarts } from '../src/results/log-scan.js';
import { logger } from '../src/util/logger.js';

const HOST = '127.0.0.1';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

const fixLog = readFileSync(new URL('../fixtures/fastchess-adjudicated.log', import.meta.url));
const fixPgn = readFileSync(new URL('../fixtures/fastchess-adjudicated.pgn', import.meta.url), 'utf8');
const pgnEntries = (pgn: string): string[] => pgn.split(/(?=^\[Event )/m).filter((s) => s.trim());
const fixEntries = pgnEntries(fixPgn);
const STARTS = scanGameStarts(new URL('../fixtures/fastchess-adjudicated.log', import.meta.url).pathname, 'fastchess').starts;

/** First newline-aligned offset at or after `n` in `buf`. */
const lineAfter = (buf: Buffer, n: number): number => buf.indexOf(0x0a, n) + 1;

function capture() {
  const lines: string[] = [];
  const orig = { ...logger };
  for (const l of ['debug', 'info', 'warn', 'error'] as const) logger[l] = (m: string) => void lines.push(`${l}: ${m}`);
  return { lines, done: () => Object.assign(logger, orig) };
}

interface Rx { t: number; id: number | null; body: string }

/** Stand-in client: ACKs every numbered datagram; optionally models node-tlcv's CT -> game-number logic. */
class Client {
  sock: Socket = createSocket('udp4');
  port = 0;
  rx: Rx[] = [];
  ackTimes: number[] = [];
  // numbering model
  model = false;
  ctText: string[] = [];
  ctTimer: NodeJS.Timeout | null = null;
  cur = 1;
  saved: number[] = [];
  private seen = new Set<string>();
  constructor(private serverPort: () => number) {}
  async open(): Promise<this> {
    this.sock.on('message', (b) => this.onMsg(b.toString().trim()));
    await new Promise<void>((r) => { this.sock.once('listening', () => r()); this.sock.bind(0, HOST); });
    this.port = this.sock.address().port;
    return this;
  }
  send(m: string): void { this.sock.send(m, this.serverPort(), HOST); }
  dest(): string { return `${HOST}:${this.port}`; }
  private onMsg(raw: string): void {
    const m = /^<(\d+)>([\s\S]*)$/.exec(raw);
    if (!m) { this.rx.push({ t: performance.now(), id: null, body: raw }); return; }
    const id = Number(m[1]);
    this.send(`ACK: ${id}`);
    this.ackTimes.push(performance.now());
    const key = `${id}:${m[2]}`;
    if (this.seen.has(key)) return; // retransmitted copy
    this.seen.add(key);
    this.rx.push({ t: performance.now(), id, body: m[2] });
    if (this.model) this.models(m[2]);
  }
  private models(body: string): void {
    if (body === 'CTRESET') {
      this.ctText = [];
      if (this.ctTimer) clearTimeout(this.ctTimer);
      this.ctTimer = null;
    } else if (body.startsWith('CT:')) {
      this.ctText.push(body.slice(3));
      if (this.ctTimer) clearTimeout(this.ctTimer);
      this.ctTimer = setTimeout(() => {
        this.ctTimer = null;
        const h = this.ctText.findIndex((l) => l.startsWith('Game No.'));
        const row = h >= 0 ? this.ctText[h + 1] : undefined;
        const n = row ? Number(row.trim().split(/\s+/)[0]) : NaN;
        if (Number.isFinite(n)) this.cur = n + 1;
      }, 100);
    } else if (body.startsWith('result:')) {
      this.saved.push(this.cur);
      this.send('RESULTTABLE');
    }
  }
  /** The server process restarted: ids start over, so copies seen before no longer count as duplicates. */
  resetSeen(): void { this.seen.clear(); }
  bodies(from = 0): string[] { return this.rx.slice(from).map((r) => r.body); }
  close(): void { if (this.ctTimer) clearTimeout(this.ctTimer); this.sock.close(); }
}

function mkCfg(dir: string, port: number, over: Partial<Config> = {}): Config {
  return {
    logPath: path.join(dir, 'fc.log'), format: 'fastchess', port, bindAddr: HOST, white: 'White', black: 'Black', site: 'T',
    fromStart: true, delayMs: 100, delayAfterMoveMs: 0, delayAfterGameMs: 0, fenSetupMove: true, menus: [],
    tourneyPgn: path.join(dir, 'games.pgn'), saveDebug: false,
    clientTimeoutMs: 70000, maxClients: 0, bannedIps: [], pvIntervalMs: 0, logFormat: 'human', ...over,
  };
}

const isMove = (b: string) => b.startsWith('WMOVE:') || b.startsWith('BMOVE:');
/** Wait until `c` has received nothing new for `quietMs`. */
async function settle(c: Client, quietMs = 300, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  let n = -1;
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    if (Date.now() - t0 > ms) throw new Error('never settled');
    if (c.rx.length !== n) {
      n = c.rx.length;
      since = Date.now();
    }
    await sleep(10);
  }
}

/** Shared set-up: app1 on `log` bytes [0, cut) with `pgn`, one client logged on and receiving moves. */
async function phase1(dir: string, cut: number, pgn: string, clientModel = false) {
  writeFileSync(path.join(dir, 'fc.log'), fixLog.subarray(0, cut));
  writeFileSync(path.join(dir, 'games.pgn'), pgn);
  const app1 = await startApp(mkCfg(dir, 0));
  let port = app1.server.address().port;
  const client = await new Client(() => port).open();
  client.model = clientModel;
  client.send('LOGONv15:tester');
  await waitFor(() => client.rx.some((r) => r.body === 'LOGON SUCCESSFUL'));
  // the log is caught up before the LOGON, so the client gets a snapshot: its position steps end with a move
  await waitFor(() => client.bodies().some(isMove));
  return { app1, client, port };
}

test('restart mid-game: nothing is sent until the client speaks; PING gets the notice; re-LOGON gets numbering then the live position', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'restart-'));
  const { app1, client, port } = await phase1(dir, lineAfter(fixLog, STARTS[1] + 20000), fixEntries[0]);
  await settle(client);
  const liveFen = client.bodies().filter((b) => b.startsWith('FEN:')).at(-1);
  app1.close();
  await sleep(150);
  client.resetSeen();
  const cap = capture();
  const mark = client.rx.length;
  const app2 = await startApp(mkCfg(dir, port));
  try {
    await sleep(400);
    assert.equal(client.rx.length, mark, 'nothing sent before the client speaks');
    client.send('PING');
    await waitFor(() => client.bodies(mark).some((b) => /no longer connected/.test(b)));
    client.send('LOGONv15:tester');
    await waitFor(() => client.bodies(mark).some((b) => /^[WB]MOVE: \d+\.+ \(setup\)$/.test(b)));
    await settle(client);
    const bb = client.bodies(mark);
    assert.ok(bb.includes('LOGON SUCCESSFUL'));
    const w = bb.findIndex((b) => b.startsWith('WPLAYER'));
    assert.ok(bb.indexOf('CTRESET') > bb.indexOf('LOGON SUCCESSFUL') && bb.indexOf('CTRESET') < w, 'numbering dump precedes the snapshot');
    assert.ok(bb.some((b) => /^CT:1\s/.test(b)), 'newest finished game row is 1');
    assert.equal(bb.filter((b) => b.startsWith('FEN:')).at(-1), liveFen, 'the snapshot is the live position');
    assert.ok(!bb.some((b) => b.startsWith('result:')));
    assert.ok(cap.lines.some((l) => /start: caught up game 2 from offset/.test(l)), cap.lines.filter((l) => /start:/.test(l)).join('\n'));
  } finally {
    cap.done();
    app2.close();
    client.close();
  }
});

test('restart: a game that ended during the outage is not replayed; the re-LOGON numbering keeps node-tlcv\'s numbers right', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'restart-'));
  const cut = lineAfter(fixLog, STARTS[1] + 20000);
  const { app1, client, port } = await phase1(dir, cut, fixEntries[0], true);
  await settle(client);
  const cur1 = client.cur; // game 2 in progress: node-tlcv numbers it 2 (logon numbering)
  app1.close();
  await sleep(150);
  client.resetSeen();
  appendFileSync(path.join(dir, 'fc.log'), fixLog.subarray(cut));
  appendFileSync(path.join(dir, 'games.pgn'), fixEntries[1]);
  const mark = client.rx.length;
  const cap = capture();
  const app2 = await startApp(mkCfg(dir, port));
  try {
    client.send('LOGONv15:tester');
    await waitFor(() => client.bodies(mark).includes('LOGON SUCCESSFUL'));
    await settle(client);
    assert.equal(cur1, 2);
    await waitFor(() => client.cur === 3, 2000);
    assert.deepEqual(client.saved, [], 'game 2 was never sent again');
    assert.ok(!client.bodies(mark).some((b) => b.startsWith('result:') || b.startsWith('WPLAYER')));
  } finally {
    cap.done();
    app2.close();
    client.close();
  }
});

test('SAVEDEBUG interplay and close() are idempotent-safe', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'restart-'));
  writeFileSync(path.join(dir, 'fc.log'), fixLog);
  writeFileSync(path.join(dir, 'games.pgn'), fixPgn);
  const app: App = await startApp(mkCfg(dir, 0, { saveDebug: true, iniPath: path.join(dir, 'server.ini') }));
  await sleep(1300);
  app.close();
  const files = readdirSync(dir).filter((f) => f.startsWith('Debug-'));
  assert.equal(files.length, 2);
});

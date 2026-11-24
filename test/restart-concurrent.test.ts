// startApp with a concurrent fastchess log: boards, TLCS-MG clients, kill + restart with a state file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { logger } from '../src/util/logger.js';

const HOST = '127.0.0.1';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

const LOG = readFileSync(new URL('../fixtures/fastchess-concurrent.log', import.meta.url));
const PGN = readFileSync(new URL('../fixtures/fastchess-concurrent.pgn', import.meta.url), 'utf8');
const ENTRIES = PGN.split(/(?=^\[Event )/m).filter((s) => s.trim());
const tag = (e: string, t: string) => new RegExp(`^\\[${t} "([^"]*)"\\]`, 'm').exec(e)![1];
const lineAfter = (buf: Buffer, n: number): number => buf.indexOf(0x0a, n) + 1;

class Client {
  sock: Socket = createSocket('udp4');
  port = 0;
  rx: string[] = [];
  private seen = new Set<string>();
  constructor(private serverPort: () => number) {}
  async open(): Promise<this> {
    this.sock.on('message', (b) => this.onMsg(b.toString().trim()));
    await new Promise<void>((r) => this.sock.bind(0, HOST, r));
    this.port = this.sock.address().port;
    return this;
  }
  send(m: string): void {
    this.sock.send(m, this.serverPort(), HOST);
  }
  dest(): string {
    return `${HOST}:${this.port}`;
  }
  private onMsg(raw: string): void {
    const m = /^<(\d+)>([\s\S]*)$/.exec(raw);
    if (!m) return void this.rx.push(raw);
    this.send(`ACK: ${m[1]}`);
    const key = `${m[1]}:${m[2]}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.rx.push(m[2]);
  }
  resetSeen(): void {
    this.seen.clear();
  }
  close(): void {
    this.sock.close();
  }
}

function mkCfg(dir: string, port: number): Config {
  return {
    logPath: path.join(dir, 'fc.log'), format: 'fastchess', port, bindAddr: HOST, white: 'White', black: 'Black', site: 'T',
    fromStart: true, delayMs: 100, delayAfterMoveMs: 0, delayAfterGameMs: 0, fenSetupMove: true, menus: [],
    tourneyPgn: path.join(dir, 'games.pgn'), saveDebug: false,
    clientTimeoutMs: 70000, maxClients: 0, bannedIps: [], pvIntervalMs: 0, logFormat: 'human',
  };
}

/** `[board, gameno, result, white, black]` for every result a TLCS-MG client saw with a GAMENO. */
function mgResults(lines: string[]): Array<[number, number, string, string, string]> {
  const st = new Map<number, { w?: string; b?: string; no?: number }>();
  const out: Array<[number, number, string, string, string]> = [];
  for (const l of lines) {
    const m = /^BOARD (\d+) (\w+):?\s*(.*)$/.exec(l);
    if (!m) continue;
    const b = Number(m[1]);
    const v = st.get(b) ?? {};
    st.set(b, v);
    if (m[2] === 'WPLAYER') v.w = m[3];
    else if (m[2] === 'BPLAYER') v.b = m[3];
    else if (m[2] === 'GAMENO') v.no = Number(m[3]);
    else if (m[2] === 'result') {
      if (v.no !== undefined) out.push([b, v.no, m[3], v.w!, v.b!]);
      v.no = undefined;
    }
  }
  return out;
}

const checkAgainstPgn = (res: Array<[number, number, string, string, string]>) => {
  for (const [b, no, r, w, bl] of res) {
    const e = ENTRIES[no - 1];
    assert.deepEqual([w, bl, r], [tag(e, 'White'), tag(e, 'Black'), tag(e, 'Result')], `board ${b} GAMENO ${no}`);
  }
};

const quiet = () => {
  const orig = { ...logger };
  for (const l of ['debug', 'info', 'warn', 'error'] as const) logger[l] = () => {};
  return () => Object.assign(logger, orig);
};

test('concurrent log end to end: 3 boards, every GAMENO matches the PGN, legacy client sees board 1 only', async () => {
  const restore = quiet();
  const dir = mkdtempSync(path.join(tmpdir(), 'mg-app-'));
  writeFileSync(path.join(dir, 'fc.log'), '');
  writeFileSync(path.join(dir, 'games.pgn'), PGN);
  const app = await startApp(mkCfg(dir, 0));
  const port = app.server.address().port;
  const mg = await new Client(() => port).open();
  const old = await new Client(() => port).open();
  mg.send('LOGONv15:mg');
  old.send('LOGONv15:old');
  await waitFor(() => mg.rx.includes('LOGON SUCCESSFUL') && old.rx.includes('LOGON SUCCESSFUL'));
  mg.send('MULTIGAME: 1');
  await waitFor(() => mg.rx.includes('MULTIGAME: 1'));
  appendFileSync(path.join(dir, 'fc.log'), LOG);
  await waitFor(() => mgResults(mg.rx).length === 6, 15000).catch((e) => {
    console.error('results so far', JSON.stringify(mgResults(mg.rx)), 'boards', app.server.boardCount(), 'rx', mg.rx.length);
    console.error(mg.rx.filter((l) => /result|GAMENO|BOARDS|MULTI/.test(l)).join('\n'));
    mg.close(); old.close(); app.close(); restore();
    throw e;
  });
  const res = mgResults(mg.rx);
  checkAgainstPgn(res);
  assert.deepEqual(res.map((x) => x[1]).sort(), [1, 2, 3, 4, 5, 6]);
  assert.equal(new Set(res.map((x) => x[0])).size, 3);
  assert.ok(mg.rx.includes('BOARDS: 1 2 3'));
  assert.deepEqual(old.rx.filter((l) => /^(BOARD|BOARDS:|MULTIGAME:|GAMENO)/.test(l)), []);
  const oldResults = old.rx.filter((l) => l.startsWith('result:')).length;
  assert.equal(oldResults, res.filter((x) => x[0] === 1).length, 'legacy client got board 1 results');
  mg.close();
  old.close();
  app.close();
  restore();
});

test('concurrent restart: the client re-LOGONs and opts in, gets every board\'s live position, then correct results', async () => {
  const restore = quiet();
  const dir = mkdtempSync(path.join(tmpdir(), 'mg-restart-'));
  const cut = lineAfter(LOG, Math.floor(LOG.length * 0.35));
  writeFileSync(path.join(dir, 'fc.log'), LOG.subarray(0, cut));
  writeFileSync(path.join(dir, 'games.pgn'), PGN);
  const app1 = await startApp(mkCfg(dir, 0));
  const port = app1.server.address().port;
  const mg = await new Client(() => port).open();
  mg.send('LOGONv15:mg');
  await waitFor(() => mg.rx.includes('LOGON SUCCESSFUL'));
  mg.send('MULTIGAME: 1');
  await waitFor(() => mg.rx.includes('BOARDS: 1 2 3'));
  await sleep(200);
  app1.close();

  const before = mg.rx.length;
  mg.resetSeen();
  const app2 = await startApp(mkCfg(dir, port));
  assert.equal(app2.server.isMulti(mg.dest()), false, 'nothing restored');
  assert.equal(app2.server.boardCount(), 3);
  mg.send('LOGONv15:mg');
  await waitFor(() => mg.rx.slice(before).includes('LOGON SUCCESSFUL'));
  mg.send('MULTIGAME: 1');
  await waitFor(() => [1, 2, 3].every((b) => mg.rx.slice(before).some((l) => l.startsWith(`BOARD ${b} WPLAYER:`))));
  const reply = mg.rx.indexOf('MULTIGAME: 1', before);
  assert.ok(!mg.rx.slice(reply).some((l) => /^(WPLAYER|WMOVE|BMOVE|FEN):/.test(l)), 'no bare game line after the reply');
  appendFileSync(path.join(dir, 'fc.log'), LOG.subarray(cut));
  const after = () => mgResults(mg.rx.slice(reply));
  await waitFor(() => after().length >= 3, 15000);
  await sleep(300);
  checkAgainstPgn(after());
  const nos = after().map((x) => x[1]);
  assert.equal(new Set(nos).size, nos.length, 'each game number once');
  mg.close();
  app2.close();
  restore();
});

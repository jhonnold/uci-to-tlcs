import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { TlcsServer } from '../src/tlcs/server.js';
import { Pipeline } from '../src/pipeline.js';
import { Demux } from '../src/demux.js';
import { FastchessSource } from '../src/source/fastchess-source.js';
import type { NormalizedLine } from '../src/source/log-source.js';
import { parseInfoLine } from '../src/uci/info.js';
import { MG_TOKEN, isGameLine } from '../scripts/lib/tlcs-frame.js';

const HOST = '127.0.0.1';

function startServer(maxQueue?: number): Promise<TlcsServer> {
  return new Promise((resolve) => {
    const s = new TlcsServer({ port: 0, bindAddr: HOST, maxQueue });
    s.start(() => resolve(s));
  });
}

/** Auto-ACKing client; records first-seen bodies with `numbered` flags. */
class Client {
  readonly sock: Socket = createSocket('udp4');
  readonly got: Array<{ body: string; numbered: boolean }> = [];
  /** While false, numbered datagrams are neither ACKed nor recorded (a client that lags). */
  acking = true;
  private seen = new Set<number>();
  constructor(private readonly port: number) {}
  static async open(port: number): Promise<Client> {
    const c = new Client(port);
    c.sock.on('message', (buf) => c.onMsg(buf.toString().trim()));
    await new Promise<void>((r) => c.sock.bind(0, HOST, r));
    return c;
  }
  private onMsg(raw: string): void {
    const m = /^<(\d+)>([\s\S]*)$/.exec(raw);
    if (!m) return void this.got.push({ body: raw, numbered: false });
    if (!this.acking) return;
    const id = Number(m[1]);
    this.send(`ACK: ${id}`);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.got.push({ body: m[2], numbered: true });
  }
  send(s: string): void {
    this.sock.send(s, this.port, HOST);
  }
  bodies(): string[] {
    return this.got.map((g) => g.body);
  }
  numbered(): string[] {
    return this.got.filter((g) => g.numbered).map((g) => g.body);
  }
  close(): void {
    this.sock.close();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}
/** Wait until `c` has received nothing new for `quietMs`. */
async function settle(c: Client, quietMs = 150, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  let n = -1;
  let since = Date.now();
  while (Date.now() - since < quietMs) {
    if (Date.now() - t0 > ms) throw new Error('never settled');
    if (c.got.length !== n) {
      n = c.got.length;
      since = Date.now();
    }
    await sleep(10);
  }
}

const GAME_TOKENS = { test: isGameLine };
const MG_TOKENS = MG_TOKEN;

const fixtureLines = (): NormalizedLine[] => {
  const src = new FastchessSource();
  const text = readFileSync(fileURLToPath(new URL('../fixtures/fastchess-concurrent.log', import.meta.url)), 'utf8');
  return text.split('\n').flatMap((l) => {
    const n = src.normalize(l);
    return n ? [n] : [];
  });
};

const META = { white: 'W', black: 'B', site: 'MG' };

/** Drive the concurrent fixture into the server's boards (as app.ts will). */
function driveBoards(server: TlcsServer, lines: NormalizedLine[]): Demux {
  const d = new Demux((id) => new Pipeline(server.board(id), META, { pvIntervalMs: 0 }));
  for (const n of lines) d.handleLine(n);
  return d;
}

/** Board 1's thread: the first channel to open a game. */
const firstChannel = (lines: NormalizedLine[]) => lines.find((n) => n.direction === 'in' && n.uci === 'ucinewgame')!.channel;

test('legacy client: board-1 game lines equal a board-1-only run; no TLCS-MG token ever', async () => {
  const lines = fixtureLines();
  // the whole fixture arrives at once: a queue that never fills, so no stale move is dropped
  const a = await startServer(100_000);
  const b = await startServer(100_000);
  const ca = await Client.open(a.address().port);
  const cb = await Client.open(b.address().port);
  ca.send('LOGONv15:legacy');
  cb.send('LOGONv15:legacy');
  await waitFor(() => ca.bodies().includes('LOGON SUCCESSFUL') && cb.bodies().includes('LOGON SUCCESSFUL'));

  driveBoards(a, lines);
  const p = new Pipeline(b, META, { pvIntervalMs: 0 });
  const ch = firstChannel(lines);
  for (const n of lines.filter((x) => x.channel === ch)) p.handleLine(n);

  await settle(ca);
  await settle(cb);
  assert.equal(a.boardCount(), 3);
  const game = (c: Client) => c.numbered().filter((x) => GAME_TOKENS.test(x));
  assert.ok(game(ca).length > 100);
  assert.deepEqual(game(ca), game(cb));
  assert.deepEqual(ca.bodies().filter((x) => MG_TOKENS.test(x)), []);
  for (const c of [ca, cb]) c.close();
  a.close();
  b.close();
});

test('opt-in: MULTIGAME reply, BOARDS, then every board\'s snapshot wrapped; no bare game line after the reply', async () => {
  const lines = fixtureLines();
  // stop mid-tournament: drop everything after the first game result on any thread
  const s = await startServer();
  const half = lines.slice(0, Math.floor(lines.length / 6));
  driveBoards(s, half);
  assert.equal(s.boardCount(), 3);
  const c = await Client.open(s.address().port);
  c.send('LOGONv15:mg');
  await waitFor(() => c.bodies().includes('LOGON SUCCESSFUL'));
  c.send('MULTIGAME: 1');
  await waitFor(() => c.bodies().includes('MULTIGAME: 1'));
  await settle(c);
  const all = c.numbered();
  const at = all.indexOf('MULTIGAME: 1');
  assert.equal(all[at + 1], 'BOARDS: 1 2 3');
  const after = all.slice(at + 1);
  assert.deepEqual(after.filter((x) => GAME_TOKENS.test(x)), [], 'no bare game line after the reply');
  for (const id of [1, 2, 3]) {
    const mine = after.filter((x) => x.startsWith(`BOARD ${id} `));
    assert.match(mine[0], new RegExp(`^BOARD ${id} WPLAYER: `));
    assert.match(mine[1], new RegExp(`^BOARD ${id} BPLAYER: `));
    assert.ok(mine.some((x) => /^BOARD \d+ [WB]MOVE: \d+\.+ \(setup\)$/.test(x)), `board ${id} got its position`);
    assert.ok(!mine.some((x) => /^BOARD \d+ [WB]MOVE: \d+\.+ [^(]/.test(x)), `board ${id}: no move history`);
  }
  // boards come in order: board 1's snapshot before board 2's
  const firstOf = (id: number) => after.findIndex((x) => x.startsWith(`BOARD ${id} `));
  assert.ok(firstOf(1) < firstOf(2) && firstOf(2) < firstOf(3));
  c.close();
  s.close();
});

test('live: wrapped numbered and latest lines per board; new board announced; GAMENO before result', async () => {
  const s = await startServer();
  const c = await Client.open(s.address().port);
  const legacy = await Client.open(s.address().port);
  c.send('LOGONv15:mg');
  legacy.send('LOGONv15:old');
  await waitFor(() => c.bodies().includes('LOGON SUCCESSFUL') && legacy.bodies().includes('LOGON SUCCESSFUL'));
  c.send('MULTIGAME: 1');
  await waitFor(() => c.bodies().includes('BOARDS: 1'));

  const b2 = s.board(2);
  await waitFor(() => c.bodies().includes('BOARDS: 1 2'));
  b2.setPlayers('A', 'B');
  b2.emitInitialPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq', 0);
  const info = parseInfoLine('info depth 3 score cp 20 nodes 100 time 5 pv e2e4 e7e5')!;
  b2.emitPv('w', 3, 20, 1, 100, ['e2e4', 'e7e5'], info);
  b2.emitMove({ fenTruncated: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq', color: 'w', fullMoveNumber: 1, san: 'e4', fmr: 0 });
  b2.emitResult('1-0', 7, true);
  s.emitResult('*', 3, false); // board 1, no PGN entry: no GAMENO
  await waitFor(() => c.bodies().includes('BOARD 1 result: *') && legacy.bodies().includes('result: *'));
  await settle(c);

  const nb = c.numbered();
  const i = nb.indexOf('BOARD 2 WPLAYER: A');
  assert.deepEqual(nb.slice(i, i + 4), ['BOARD 2 WPLAYER: A', 'BOARD 2 BPLAYER: B', 'BOARD 2 FEN: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq', 'BOARD 2 FMR: 0']);
  assert.ok(c.got.some((g) => !g.numbered && g.body === 'BOARD 2 WPV: 3 20 1 100 e2e4 e7e5'), 'latest items stay unnumbered');
  const r = nb.indexOf('BOARD 2 result: 1-0');
  assert.equal(nb[r - 1], 'BOARD 2 GAMENO: 7');
  assert.ok(!nb.some((x) => /^BOARD 1 GAMENO/.test(x)));
  // the legacy client saw nothing of board 2 and no new token
  assert.deepEqual(legacy.bodies().filter((x) => MG_TOKENS.test(x) || /WPLAYER: A/.test(x)), []);
  for (const x of [c, legacy]) x.close();
  s.close();
});

test('re-LOGON drops the opt-in (bare board-1 resync); MULTIGAME from an unknown client is ignored', async () => {
  const s = await startServer();
  s.setPlayers('X', 'Y');
  s.board(2).setPlayers('A', 'B');
  const stranger = await Client.open(s.address().port);
  stranger.send('MULTIGAME: 1');
  const c = await Client.open(s.address().port);
  c.send('LOGONv15:mg');
  await waitFor(() => c.bodies().includes('LOGON SUCCESSFUL'));
  c.send('MULTIGAME: 1');
  await waitFor(() => c.bodies().includes('BOARD 2 WPLAYER: A'));
  const n = c.got.length;
  c.send('LOGONv15:mg');
  await waitFor(() => c.got.slice(n).some((g) => g.body === 'WPLAYER: X'));
  await settle(c);
  assert.ok(!c.got.slice(n).some((g) => /^BOARD /.test(g.body)));
  assert.equal(s.isMulti(`${HOST}:${c.sock.address().port}`), false);
  await sleep(50);
  assert.deepEqual(stranger.bodies(), []);
  for (const x of [c, stranger]) x.close();
  s.close();
});

test('opt-in of a lagging client: its queued bare lines become the wrapped snapshot; a finished game is not resent', async () => {
  const s = await startServer();
  const c = await Client.open(s.address().port);
  c.send('LOGONv15:lag');
  await waitFor(() => c.bodies().includes('LOGON SUCCESSFUL'));
  await settle(c);
  c.acking = false;
  s.setPlayers('X', 'Y');
  s.emitInitialPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq', 0);
  s.emitResult('1-0', 4, true);
  s.board(2).setPlayers('A', 'B');
  c.send('MULTIGAME: 1');
  await sleep(100);
  c.acking = true;
  await waitFor(() => c.bodies().includes('BOARD 2 BPLAYER: B'), 5000);
  await settle(c);
  const nb = c.numbered();
  const after = nb.slice(nb.indexOf('MULTIGAME: 1'));
  assert.deepEqual(after.filter((x) => GAME_TOKENS.test(x)), [], 'no bare game line after the reply');
  assert.ok(!nb.some((x) => /result|GAMENO/.test(x)), 'the finished game is not resent');
  c.close();
  s.close();
});

test('re-LOGON of a lagging TLCS-MG client: no wrapped line reaches it afterwards', async () => {
  const s = await startServer();
  const c = await Client.open(s.address().port);
  c.send('LOGONv15:mg');
  await waitFor(() => c.bodies().includes('LOGON SUCCESSFUL'));
  c.send('MULTIGAME: 1');
  await waitFor(() => c.bodies().includes('BOARDS: 1'));
  await settle(c);
  c.acking = false;
  const b2 = s.board(2);
  b2.setPlayers('A', 'B');
  b2.emitClocks(100, 100);
  s.setPlayers('X', 'Y');
  s.emitClocks(200, 200);
  c.send('LOGONv15:mg');
  await sleep(100);
  const n = c.got.length;
  c.acking = true;
  await waitFor(() => c.got.slice(n).some((g) => g.body === 'WPLAYER: X'), 5000);
  await settle(c);
  // the in-flight item may still be a wrapped one; nothing queued after the LOGON is
  const after = c.got.slice(n).map((g) => g.body);
  const firstBare = after.indexOf('WPLAYER: X');
  assert.deepEqual(after.slice(firstBare).filter((x) => MG_TOKEN.test(x)), []);
  c.close();
  s.close();
});

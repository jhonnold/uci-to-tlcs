import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';

import { TlcsServer, type ServerOptions } from '../src/tlcs/server.js';
import { parseInfoLine } from '../src/uci/info.js';
import { logger } from '../src/util/logger.js';
import { metrics } from '../src/metrics.js';
import { ResultService } from '../src/results/result-commands.js';
import type { GameRegistry } from '../src/results/registry.js';

const HOST = '127.0.0.1';

/** Start a server on an OS-assigned port and resolve once it's listening. */
function startServer(extra: Partial<ServerOptions> = {}): Promise<{ server: TlcsServer; port: number }> {
  return new Promise((resolve) => {
    const server = new TlcsServer({ port: 0, bindAddr: HOST, ...extra });
    server.start(() => resolve({ server, port: server.address().port }));
  });
}

/**
 * A minimal node-tlcv stand-in bound to an *ephemeral* port (never the broadcast
 * port). It auto-ACKs `<N>`-wrapped reliable messages, optionally PINGs to stay
 * alive, and records every body it receives.
 */
class TestClient {
  readonly sock: Socket;
  port = 0;
  readonly received: string[] = [];
  /** Ids of the first-seen numbered messages, parallel to the numbered entries of `received`. */
  readonly ids: number[] = [];
  /** Parallel to `received`: the id of each entry, or null for an unnumbered body. */
  readonly receivedIds: Array<number | null> = [];
  /** Every datagram, raw, in arrival order (including retransmitted copies). */
  readonly raw: string[] = [];
  /** Drop (do not ACK or record) the first copy of every Nth id; 0 = never. */
  dropEvery = 0;
  /** While true, receive and record nothing and ACK nothing (a client that went deaf). */
  paused = false;
  private seenIds = new Set<number>();
  private pinger: NodeJS.Timeout | null = null;

  private constructor(
    private readonly serverPort: number,
    readonly user: string,
  ) {
    this.sock = createSocket('udp4');
  }

  static create(serverPort: number, user: string): Promise<TestClient> {
    const c = new TestClient(serverPort, user);
    return new Promise((resolve) => {
      c.sock.on('message', (buf) => c.onMessage(buf.toString().trim()));
      c.sock.on('listening', () => {
        c.port = c.sock.address().port;
        resolve(c);
      });
      c.sock.bind(0, HOST); // 0 => OS-assigned ephemeral port
    });
  }

  private onMessage(raw: string): void {
    if (this.paused) return;
    this.raw.push(raw);
    if (raw.startsWith('<')) {
      const close = raw.indexOf('>');
      const id = Number(raw.slice(1, close));
      if (this.dropEvery && id % this.dropEvery === 0 && !this.seenIds.has(id) && !this.droppedOnce.has(id)) {
        this.droppedOnce.add(id);
        return;
      }
      this.send(`ACK: ${id}`);
      if (this.seenIds.has(id)) return; // retransmitted copy: ACKed, not re-processed
      this.seenIds.add(id);
      this.ids.push(id);
      this.received.push(raw.slice(close + 1));
      this.receivedIds.push(id);
    } else {
      this.received.push(raw);
      this.receivedIds.push(null);
    }
  }

  private droppedOnce = new Set<number>();

  send(msg: string): void {
    this.sock.send(msg, this.serverPort, HOST);
  }

  logon(): void {
    this.send(`LOGONv15:${this.user}`);
  }

  startPinging(everyMs: number): void {
    this.pinger = setInterval(() => this.send('PING'), everyMs);
  }

  close(): void {
    if (this.pinger) clearInterval(this.pinger);
    this.sock.close();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `pred` holds, or reject after `timeoutMs`. */
function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      if (pred()) {
        clearInterval(t);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(t);
        reject(new Error('timed out waiting for condition'));
      }
    }, 10);
  });
}

test('server: replies to the client source port (ephemeral client receives)', async () => {
  const rx0 = metrics.get('tlcs_messages_received_total', { type: 'LOGONv15' });
  const tx0 = metrics.get('tlcs_messages_sent_total', { type: 'LOGON' });
  const rf0 = metrics.get('tlcs_resyncs_total', { kind: 'full' });
  const { server, port } = await startServer();
  const client = await TestClient.create(port, 'tester');
  try {
    // The client bound an ephemeral port, NOT the broadcast port: a strict-TLCS
    // server (reply to broadcast port) would never reach it.
    assert.notEqual(client.port, port);
    client.logon();
    await waitFor(() => client.received.includes('LOGON SUCCESSFUL'));
    assert(metrics.get('tlcs_messages_received_total', { type: 'LOGONv15' }) - rx0 >= 1);
    assert(metrics.get('tlcs_messages_sent_total', { type: 'LOGON' }) - tx0 >= 1);
    assert(metrics.get('tlcs_resyncs_total', { kind: 'full' }) - rf0 >= 1);
  } finally {
    client.close();
    server.close();
  }
});

test('server: keys clients by ip:port so two clients on one host both get moves', async () => {
  const { server, port } = await startServer();
  const a = await TestClient.create(port, 'alice');
  const b = await TestClient.create(port, 'bob');
  try {
    assert.notEqual(a.port, b.port); // same IP, distinct ephemeral ports
    a.logon();
    b.logon();
    await waitFor(() => a.received.includes('LOGON SUCCESSFUL') && b.received.includes('LOGON SUCCESSFUL'));

    server.emitMove({
      fenTruncated: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq',
      color: 'w',
      fullMoveNumber: 1,
      san: 'e4',
      fmr: 0,
    });

    const sawMove = (c: TestClient) => c.received.some((m) => m.startsWith('WMOVE'));
    await waitFor(() => sawMove(a) && sawMove(b));
  } finally {
    a.close();
    b.close();
    server.close();
  }
});

// Every LOGON now gets a FULL replay (not a board-only snapshot): a snapshot cannot repair
// a client whose board is already loaded (node-tlcv after a server restart or a reap), so
// the server replays players, the start position, every SAN and the latest position.
test('server: mid-game LOGON replays site, players, full move history, latest position, clocks and PV before further moves', async () => {
  const { server, port } = await startServer();
  const early = await TestClient.create(port, 'early');
  const late = await TestClient.create(port, 'late');
  const fen2 = 'FEN: rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq';
  try {
    early.logon();
    await waitFor(() => early.received.includes('LOGON SUCCESSFUL'));

    // A game in progress: header + two moves + clocks + a PV, all before `late` joins.
    server.setSite('Midgame Arena');
    server.setPlayers('Engine W', 'Engine B');
    server.emitMove({
      fenTruncated: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq',
      color: 'w',
      fullMoveNumber: 1,
      san: 'e4',
      fmr: 0,
    });
    server.emitMove({
      fenTruncated: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq',
      color: 'b',
      fullMoveNumber: 1,
      san: 'e5',
      fmr: 0,
    });
    server.emitClocks(98_000, 97_500);
    server.emitPv('w', 5, 12, 100, 100, ['g1f3']);
    server.emitInfo('w', parseInfoLine('info depth 5 seldepth 9 score cp 12 hashfull 7 nodes 100 time 1000 pv g1f3')!, ['g1f3']);

    // Wait for the pre-logon reliable queue to drain (FMR is each move's last msg).
    await waitFor(() => early.received.filter((m) => m === 'FMR: 0').length === 2);

    late.logon();
    // Wait for the WHOLE snapshot (WPV is its last reliable message) before
    // asserting order, so a slow ACK round-trip can't make a later idx() -1.
    await waitFor(() => late.received.includes('WPV: 5 12 100 100 g1f3'));
    const winfo = 'WINFO: depth 5 seldepth 9 score cp 12 nodes 100 hashfull 7 time 1000 pv g1f3';
    await waitFor(() => late.received.includes(winfo));

    // Snapshot content: the LATEST position (not move 1), current players/site.
    const idx = (m: string) => late.received.indexOf(m);
    assert(idx('SITE: Midgame Arena') !== -1);
    assert(idx('WPLAYER: Engine W') !== -1);
    assert(idx('BPLAYER: Engine B') !== -1);
    assert(idx(fen2) !== -1);

    // Replay order: SITE -> players -> first position -> both SANs -> latest FEN/FMR -> clocks -> PV.
    const e4fen = 'FEN: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq';
    assert(idx('SITE: Midgame Arena') < idx('WPLAYER: Engine W'));
    assert(idx('WPLAYER: Engine W') < idx('BPLAYER: Engine B'));
    assert(idx('BPLAYER: Engine B') < idx(e4fen));
    assert(idx(e4fen) < idx('WMOVE: 1. e4'));
    assert(idx('WMOVE: 1. e4') < idx('BMOVE: 1... e5'));
    // fen2 is the LAST FEN, after the SANs and before the clocks.
    assert.equal(late.received.lastIndexOf(fen2), late.received.map((m) => m.startsWith('FEN:')).lastIndexOf(true));
    assert(idx('BMOVE: 1... e5') < late.received.lastIndexOf(fen2));
    assert(late.received.lastIndexOf('FMR: 0') < idx('WTIME: 98000 otim 97500'));
    assert(late.received.lastIndexOf(fen2) < late.received.lastIndexOf('FMR: 0'));
    assert(idx('WTIME: 98000 otim 97500') < idx('WPV: 5 12 100 100 g1f3'));
    assert(idx('WPV: 5 12 100 100 g1f3') < idx(winfo));

    // The next live move lands only after the snapshot is complete.
    server.emitMove({
      fenTruncated: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKBNR b KQkq',
      color: 'w',
      fullMoveNumber: 2,
      san: 'Nf3',
      fmr: 1,
    });
    await waitFor(() => late.received.some((m) => m.startsWith('WMOVE') && m.includes('Nf3')));
    assert(idx('WPV: 5 12 100 100 g1f3') < late.received.findIndex((m) => m.startsWith('WMOVE') && m.includes('Nf3')));
  } finally {
    early.close();
    late.close();
    server.close();
  }
});

test('server: reaps a silent client after the idle timeout', async () => {
  const { server, port } = await startServer({ clientTimeoutMs: 150, reapIntervalMs: 40 });
  const alice = await TestClient.create(port, 'alice');
  const bob = await TestClient.create(port, 'bob');
  try {
    alice.logon();
    await waitFor(() => alice.received.includes('LOGON SUCCESSFUL'));
    alice.startPinging(40); // keeps alice's lastSeen fresh

    bob.logon();
    await waitFor(() => bob.received.includes('LOGON SUCCESSFUL'));
    await waitFor(() => alice.received.includes('ADDUSER: bob'));

    // bob now goes silent; the reaper should drop him and notify alice.
    await waitFor(() => alice.received.includes('DELUSER: bob'), 2000);
    await waitFor(() => alice.received.includes('CHAT: [SERVER] - Lost connection with bob'));

    // A reaped client's next PING gets the "no longer connected" notice, and its re-LOGON continues its ids.
    const lastId = Math.max(...bob.ids);
    bob.send('PING');
    await waitFor(() => bob.received.includes('MSG: You are no longer connected to the server.  Please re-connect.'));
    bob.logon();
    await waitFor(() => bob.ids.length > 0 && Math.max(...bob.ids) > lastId);
  } finally {
    alice.close();
    bob.close();
    server.close();
  }
});

const FEN_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq';
const FEN_START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';
const mv = (server: TlcsServer, n: number): void =>
  server.emitMove({ fenTruncated: `${FEN_E4}-${n}`, color: n % 2 ? 'w' : 'b', fullMoveNumber: Math.ceil(n / 2), san: `m${n}`, fmr: n });
const bodiesFrom = (c: TestClient, from: string): string[] => c.received.slice(c.received.indexOf(from));

test('server: numbered inbound PING/CHAT are ACKed on every copy and deduped', async () => {
  const { server, port } = await startServer();
  const a = await TestClient.create(port, 'alice');
  const b = await TestClient.create(port, 'bob');
  try {
    a.logon();
    b.logon();
    await waitFor(() => a.received.includes('LOGON SUCCESSFUL') && b.received.includes('LOGON SUCCESSFUL'));
    a.send('< 7>PING');
    await waitFor(() => a.raw.includes('ACK: 7') && a.received.includes('PONG'));
    a.send('< 7>PING');
    await waitFor(() => a.raw.filter((m) => m === 'ACK: 7').length === 2);
    await sleep(40);
    assert.equal(a.received.filter((m) => m === 'PONG').length, 1, 'duplicate not re-dispatched');

    a.send('<8>CHAT: hi');
    a.send('<8>CHAT: hi');
    await waitFor(() => b.received.includes('CHAT: [alice] - hi'));
    await sleep(60);
    assert.equal(b.received.filter((m) => m === 'CHAT: [alice] - hi').length, 1);

    a.send('LOGONv15:alice'); // re-LOGON resets the dedupe ring (restarted desktop counter)
    await sleep(40);
    a.send('< 7>PING');
    await waitFor(() => a.received.filter((m) => m === 'PONG').length === 2);
  } finally {
    a.close();
    b.close();
    server.close();
  }
});

test('server: a retransmitted numbered LOGON is dispatched once', async () => {
  const { server, port } = await startServer();
  const a = await TestClient.create(port, 'carol');
  try {
    a.send('<1>LOGONv15:carol');
    await waitFor(() => a.received.includes('LOGON SUCCESSFUL'));
    a.send('<1>LOGONv15:carol');
    await waitFor(() => a.raw.filter((m) => m === 'ACK: 1').length === 2);
    await sleep(60);
    assert.equal(a.received.filter((m) => m === 'LOGON SUCCESSFUL').length, 1, JSON.stringify(a.received));
  } finally {
    a.close();
    server.close();
  }
});

test('server: a lossy client still gets every move, in order, with increasing ids', async () => {
  const { server, port } = await startServer({ minRtoMs: 10, maxRtoMs: 80, initialRtoMs: 20 });
  const c = await TestClient.create(port, 'lossy');
  try {
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL'));
    c.dropEvery = 3;
    server.setPlayers('W', 'B');
    for (let n = 1; n <= 10; n++) mv(server, n);
    await waitFor(() => c.received.filter((m) => m.startsWith('FMR:')).length === 10, 4000);
    const moves = c.received.filter((m) => /^[WB]MOVE/.test(m));
    assert.deepEqual(moves.map((m) => m.split(' ').pop()), Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
    assert(c.ids.every((id, i) => i === 0 || id > c.ids[i - 1]));
  } finally {
    c.close();
    server.close();
  }
});

test('server: a client that stops ACKing gets a replay under new ids after give-up; others are unaffected', async () => {
  const { server, port } = await startServer({ giveUpMs: 60, minRtoMs: 10, initialRtoMs: 15, maxRtoMs: 30 });
  const a = await TestClient.create(port, 'a');
  const b = await TestClient.create(port, 'b');
  try {
    a.logon();
    b.logon();
    await waitFor(() => a.received.includes('LOGON SUCCESSFUL') && b.received.includes('LOGON SUCCESSFUL'));
    await sleep(40);
    a.paused = true;
    server.setPlayers('W', 'B');
    server.emitInitialPosition(FEN_START, 0);
    for (let n = 1; n <= 3; n++) mv(server, n);
    await waitFor(() => b.received.filter((m) => m.startsWith('FMR:')).length === 4, 1000); // b is prompt
    await sleep(150); // past giveUpMs
    const before = Math.max(0, ...a.ids);
    const n0 = a.ids.length;
    a.paused = false;
    await waitFor(() => a.received.filter((m) => m.startsWith('FMR:')).length >= 1 && a.received.includes('WMOVE: 2. m3'), 3000);
    assert(a.ids.length > n0 && a.ids.slice(n0).every((id) => id > before), JSON.stringify([before, a.ids]));
    assert.deepEqual(
      a.received.filter((m) => m.startsWith('WPLAYER') || m.startsWith('BPLAYER')),
      ['WPLAYER: W', 'BPLAYER: B'],
    );
    assert.equal(a.received.filter((m) => /^[WB]MOVE/.test(m)).length, 3, 'each SAN exactly once');
    assert.equal(a.received.filter((m) => m.startsWith('FEN:')).at(-1), `FEN: ${FEN_E4}-3`);
  } finally {
    a.close();
    b.close();
    server.close();
  }
});

test('server: ids continue across a re-LOGON of the same client', async () => {
  const { server, port } = await startServer();
  const c = await TestClient.create(port, 'c');
  try {
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL'));
    server.setPlayers('W', 'B');
    await waitFor(() => c.received.includes('BPLAYER: B'));
    const last = Math.max(...c.ids);
    c.logon();
    await waitFor(() => c.ids.length > 2 && Math.max(...c.ids) > last);
    assert(c.ids.every((id, i) => i === 0 || id > c.ids[i - 1]), `ids ${c.ids}`);
  } finally {
    c.close();
    server.close();
  }
});

test('server: re-LOGON with pending moves and a pending result replays both games, result once', async () => {
  const { server, port } = await startServer();
  const c = await TestClient.create(port, 'c');
  try {
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL'));
    await sleep(30);
    c.paused = true;
    server.setPlayers('W1', 'B1');
    server.emitInitialPosition(FEN_START, 0);
    mv(server, 1);
    mv(server, 2);
    server.emitResult('1-0 {done}');
    server.setPlayers('W2', 'B2');
    server.emitInitialPosition(FEN_START, 0);
    mv(server, 3);
    await sleep(50);
    c.paused = false;
    c.logon();
    await waitFor(() => c.received.includes('FEN: ' + FEN_E4 + '-3'), 3000);
    await sleep(50);
    const r = bodiesFrom(c, 'WPLAYER: W1');
    assert.equal(r.filter((m) => m.startsWith('result:')).length, 1, JSON.stringify(r));
    assert(r.indexOf('result: 1-0 {done}') < r.indexOf('WPLAYER: W2'));
    // the in-flight WPLAYER (sent before the pause) may legitimately precede its own replay
    assert(r.filter((m) => m === 'WPLAYER: W1').length <= 2);
    assert.equal(r.filter((m) => m === 'WPLAYER: W2').length, 1);
    assert.equal(r.filter((m) => /^[WB]MOVE/.test(m)).length, 3);
  } finally {
    c.close();
    server.close();
  }
});

test('server: re-LOGON of an up-to-date client gets a full replay before the next live move', async () => {
  const { server, port } = await startServer();
  const c = await TestClient.create(port, 'c');
  try {
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL'));
    server.setPlayers('W', 'B');
    server.emitInitialPosition(FEN_START, 0);
    mv(server, 1);
    await waitFor(() => c.received.includes('FMR: 1'));
    const n0 = c.received.length;
    c.logon();
    await waitFor(() => c.received.slice(n0).includes('FMR: 1'));
    const again = c.received.slice(n0);
    assert(again.indexOf('WPLAYER: W') < again.indexOf('WMOVE: 1. m1'));
    mv(server, 2);
    await waitFor(() => c.received.includes('BMOVE: 1... m2'));
    assert(c.received.lastIndexOf('WMOVE: 1. m1') < c.received.indexOf('BMOVE: 1... m2'));
  } finally {
    c.close();
    server.close();
  }
});

test('server: a fresh client after a finished game gets no stale WPLAYER/result', async () => {
  const { server, port } = await startServer();
  const c = await TestClient.create(port, 'late');
  try {
    server.setSite('Arena');
    server.setPlayers('W', 'B');
    server.emitInitialPosition(FEN_START, 0);
    mv(server, 1);
    server.emitResult('1/2-1/2');
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL') && c.received.includes('SITE: Arena'), 1000).catch(() => undefined);
    await sleep(80);
    assert(!c.received.some((m) => m.startsWith('WPLAYER') || m.startsWith('result:')));
    server.setPlayers('W2', 'B2');
    await waitFor(() => c.received.includes('BPLAYER: B2'));
  } finally {
    c.close();
    server.close();
  }
});

test('server: replay keeps the mover PV before each SAN (so node-tlcv does not label them Book)', async () => {
  const { server, port } = await startServer();
  const c = await TestClient.create(port, 'late');
  try {
    server.setPlayers('W', 'B');
    server.emitInitialPosition(FEN_START, 0);
    server.emitPv('w', 9, 20, 100, 5000, ['e2e4']);
    mv(server, 1);
    mv(server, 2); // black: book move, no PV
    server.emitPv('w', 11, 25, 100, 9000, ['g1f3']);
    mv(server, 3);
    c.logon();
    await waitFor(() => c.received.includes('FMR: 3'), 2000);
    const r = c.received;
    const i1 = r.indexOf('WMOVE: 1. m1');
    assert.equal(r[i1 - 1].startsWith('WPV: 9 20'), true, 'PV directly before the first SAN (verbatim prefix)');
    const i3 = r.indexOf('WMOVE: 2. m3');
    assert.equal(r[i3 - 1].startsWith('WPV: 11 25'), true, 'PV directly before a later SAN');
    const i2 = r.indexOf('BMOVE: 1... m2');
    assert(!r[i2 - 1].startsWith('BPV'), 'no PV invented for a book move');
  } finally {
    c.close();
    server.close();
  }
});

test('server: records are garbage-collected once every client has caught up', async () => {
  const { server, port } = await startServer({ minRtoMs: 10, initialRtoMs: 15, maxRtoMs: 40 });
  const c = await TestClient.create(port, 'slow');
  try {
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL'));
    c.dropEvery = 2;
    for (let g = 1; g <= 3; g++) {
      server.setPlayers(`W${g}`, `B${g}`);
      server.emitInitialPosition(FEN_START, 0);
      mv(server, 1);
      server.emitResult(`1-0 {g${g}}`);
    }
    assert(server.recordEpochs().length > 1, 'slow client keeps older epochs alive');
    await waitFor(() => c.received.filter((m) => m.startsWith('result:')).length === 3, 4000);
    server.setPlayers('W4', 'B4');
    assert.deepEqual(server.recordEpochs().length, 1);
    assert.deepEqual(c.received.filter((m) => m.startsWith('result:')), ['result: 1-0 {g1}', 'result: 1-0 {g2}', 'result: 1-0 {g3}']);
  } finally {
    c.close();
    server.close();
  }
});

// Not covered: a re-LOGON while an xMOVE is the in-flight item. That item is kept and reaches a
// fresh node-tlcv before the replay's FEN; it recovers (warn + resetFromFen). Here the client is
// paused from the start, so the in-flight item is always WPLAYER.
test('server: BMOVE never precedes a FEN after a re-LOGON on a backlogged client', async () => {
  const { server, port } = await startServer();
  const c = await TestClient.create(port, 'c');
  try {
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL'));
    await sleep(30);
    c.paused = true;
    server.setPlayers('W', 'B');
    server.emitInitialPosition(FEN_START, 0);
    for (let n = 1; n <= 6; n++) mv(server, n);
    c.paused = false;
    c.logon();
    await waitFor(() => c.received.includes('FMR: 6'), 3000);
    const afterLogon = c.received.slice(c.received.indexOf('LOGON SUCCESSFUL', 1) === -1 ? 0 : c.received.indexOf('LOGON SUCCESSFUL', 1));
    const firstFen = afterLogon.findIndex((m) => m.startsWith('FEN:'));
    const firstMove = afterLogon.findIndex((m) => /^[WB]MOVE/.test(m));
    assert(firstFen !== -1 && firstFen < firstMove, 'a FEN precedes the first move after re-LOGON');
  } finally {
    c.close();
    server.close();
  }
});

const NOT_CONNECTED = 'MSG: You are no longer connected to the server.  Please re-connect.';

test('session: logon burst order on the wire, fan-out to the others', async () => {
  const { server, port } = await startServer({ menus: ['MENU ID=1 WIDTH=1 HEIGHT=1 NAME="A" URL="u"'] });
  const alice = await TestClient.create(port, 'alice');
  const bob = await TestClient.create(port, 'bob');
  try {
    server.setSite('S');
    server.setPlayers('W', 'B');
    server.emitMove({ fenTruncated: FEN_E4, color: 'w', fullMoveNumber: 1, san: 'e4', fmr: 0 });
    alice.logon();
    await waitFor(() => alice.received.includes('MENU ID=1 WIDTH=1 HEIGHT=1 NAME="A" URL="u"'));
    bob.logon();
    await waitFor(() => bob.received.some((m) => m.startsWith('MENU ')));
    const i = (m: string) => bob.received.findIndex((x) => x === m || x.startsWith(m));
    assert.equal(bob.received[0], 'LOGON SUCCESSFUL');
    assert(bob.raw[0] === 'LOGON SUCCESSFUL', 'unnumbered');
    assert(i('LOGON SUCCESSFUL') < i('FEATURE: PING'));
    assert(i('FEATURE: PING') < i('WPLAYER'));
    assert(i('WPLAYER') < i('WMOVE'));
    assert(i('WMOVE') < i('ADDUSER: bob'));
    assert(i('ADDUSER: bob') < i('ADDUSER: alice'));
    assert(i('ADDUSER: alice') < i('MENU ID=1'));
    await waitFor(() => alice.received.includes('CHAT: [Server] bob has arrived!'));
    assert(alice.received.includes('ADDUSER: bob'));
  } finally {
    alice.close();
    bob.close();
    server.close();
  }
});

test('session: PING answers (numbered PONG, notice, numbered rate limit) and chat relay', async () => {
  const { server, port } = await startServer();
  const a = await TestClient.create(port, 'alice');
  try {
    a.send('< 4>PING');
    await waitFor(() => a.raw.includes(NOT_CONNECTED));
    assert(a.raw.includes('ACK: 4'));
    a.send('< 5>PING');
    await waitFor(() => a.raw.includes('ACK: 5'));
    await sleep(60);
    assert.equal(a.raw.filter((m) => m === NOT_CONNECTED).length, 1, 'numbered PING notice rate-limited');
    a.send('PING');
    a.send('PING');
    await waitFor(() => a.raw.filter((m) => m === NOT_CONNECTED).length === 3);
    assert(!a.raw.some((m) => m.includes('PONG')));

    a.logon();
    await waitFor(() => a.received.includes('LOGON SUCCESSFUL'));
    a.send('< 3>PING');
    await waitFor(() => a.raw.some((m) => /^<\d+>PONG$/.test(m)));
    a.send('CHAT: hi');
    await waitFor(() => a.raw.some((m) => /^<\d+>CHAT: \[alice\] - hi$/.test(m)));
    a.send('CHAT: <who>');
    await waitFor(() => a.raw.includes('CHAT: [SERVER] Users=1'));
  } finally {
    a.close();
    server.close();
  }
});

// ---------------------------------------------------------------- T08 admin & abuse

test('admin: config-banned source gets nothing, not even an ACK', async () => {
  const { server, port } = await startServer({ bannedIps: [HOST] });
  const c = await TestClient.create(port, 'banned');
  try {
    c.logon();
    c.send('< 1>PING');
    await sleep(300);
    assert.deepEqual(c.raw, []);
  } finally {
    c.close();
    server.close();
  }
});

test('admin: per-IP rate limit drops plain datagrams; ACKs are free', async () => {
  const { server, port } = await startServer({ rateLimit: { burst: 3, perSec: 0.001 } });
  const a = await TestClient.create(port, 'alice');
  try {
    for (let i = 0; i < 10; i++) a.send('PING');
    await waitFor(() => a.raw.length >= 3);
    await sleep(200);
    assert.equal(a.raw.filter((m) => m === NOT_CONNECTED).length, 3);
    a.send('ACK: 1');
    a.send('ACK: 2');
    await sleep(100); // no reply and no crash; the bucket is not charged for ACKs
    assert.equal(a.raw.length, 3);
  } finally {
    a.close();
    server.close();
  }
});

test('admin: ADMIN, SECURITY, BOOT flow over UDP', async () => {
  const { server, port } = await startServer({ adminPass: 'pw' });
  const alice = await TestClient.create(port, 'alice');
  const bob = await TestClient.create(port, 'bob');
  try {
    alice.logon();
    await waitFor(() => alice.received.includes('LOGON SUCCESSFUL'));
    bob.logon();
    await waitFor(() => bob.received.includes('LOGON SUCCESSFUL'));
    alice.send('ADMIN:pw');
    await waitFor(() => alice.raw.includes('CHAT: [SERVER] Admin access granted'));
    alice.send('SECURITY');
    await waitFor(() => alice.raw.filter((m) => m.startsWith('SECUSER:')).length === 2);
    assert(alice.raw.includes('SECUSER: bob:127.0.0.1'));
    alice.send('BOOT:bob');
    await waitFor(() => bob.raw.includes('MSG: You have been booted!'));
    await waitFor(() => alice.received.includes('DELUSER: bob'));
    bob.send('PING');
    await waitFor(() => bob.raw.includes(NOT_CONNECTED));
  } finally {
    alice.close();
    bob.close();
    server.close();
  }
});

test('admin: numbered ADMIN is applied once, admin-like chat is not relayed, nothing leaks into logs', async () => {
  const lines: string[] = [];
  const ms = (['info', 'warn', 'debug'] as const).map((k) => mock.method(logger, k, (s: unknown) => void lines.push(String(s))));
  const { server, port } = await startServer({ adminPass: 'pw-leak-check' });
  const alice = await TestClient.create(port, 'alice');
  const bob = await TestClient.create(port, 'bob');
  try {
    alice.logon();
    await waitFor(() => alice.received.includes('LOGON SUCCESSFUL'));
    bob.logon();
    await waitFor(() => bob.received.includes('LOGON SUCCESSFUL'));
    alice.send('< 1>ADMIN:pw-leak-check');
    alice.send('< 1>ADMIN:pw-leak-check');
    await waitFor(() => alice.raw.filter((m) => m === 'ACK: 1').length === 2);
    await sleep(100);
    assert.equal(alice.raw.filter((m) => m === 'CHAT: [SERVER] Admin access granted').length, 1);
    alice.send('< 2>CHAT: (x) admin:leak-zz');
    await waitFor(() => alice.raw.includes('ACK: 2'));
    alice.send('< 3>CHAT: hi');
    await waitFor(() => bob.raw.some((m) => /^<\d+>CHAT: \[alice\] - hi$/.test(m)));
    assert(!bob.raw.some((m) => m.includes('leak-zz')));
    assert(lines.some((l) => l.includes('ADMIN:***')));
    for (const l of lines) assert(!/pw-leak-check|leak-zz/.test(l), l);
  } finally {
    for (const m of ms) m.mock.restore();
    alice.close();
    bob.close();
    server.close();
  }
});

test('admin: MAXCLIENTS refuses the second LOGON with a MSG', async () => {
  const { server, port } = await startServer({ maxClients: 1 });
  const a = await TestClient.create(port, 'alice');
  const b = await TestClient.create(port, 'bob');
  try {
    a.logon();
    await waitFor(() => a.received.includes('LOGON SUCCESSFUL'));
    b.logon();
    await waitFor(() => b.raw.includes('MSG: Connection refused.  The server is full.'));
    await sleep(100);
    assert(!b.received.includes('LOGON SUCCESSFUL'));
  } finally {
    a.close();
    b.close();
    server.close();
  }
});

test('admin: plain or numbered re-LOGON revokes the admin grant', async () => {
  const { server, port } = await startServer({ adminPass: 'pw' });
  const a = await TestClient.create(port, 'alice');
  try {
    a.logon();
    await waitFor(() => a.received.includes('LOGON SUCCESSFUL'));
    for (const relogon of ['LOGONv15:alice', '< 7>LOGONv15:alice']) {
      a.send('ADMIN:pw');
      await waitFor(() => a.raw.filter((m) => m === 'CHAT: [SERVER] Admin access granted').length >= 1);
      a.send('SECURITY');
      await waitFor(() => a.raw.some((m) => m.startsWith('SECUSER:')));
      a.raw.length = 0;
      a.send(relogon);
      await waitFor(() => a.raw.includes('LOGON SUCCESSFUL'));
      a.send('SECURITY');
      await waitFor(() => a.raw.includes('CHAT: [SERVER] Not authorized'));
      assert(!a.raw.some((m) => m.startsWith('SECUSER:')));
      a.raw.length = 0;
    }
  } finally {
    a.close();
    server.close();
  }
});

test('server: RESULTTABLE after LOGON gets a numbered CTRESET then CT lines in order; GAMELIST gets GL lines', async () => {
  const { server, port } = await startServer();
  const games = [
    { number: 1, white: 'A', black: 'B', result: '1-0' },
    { number: 2, white: 'B', black: 'A', result: '1/2-1/2' },
  ];
  server.setResultService(new ResultService(server, { games, refresh() {} } as unknown as GameRegistry));
  const c = await TestClient.create(port, 'c');
  try {
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL'));
    c.send('RESULTTABLE');
    await waitFor(() => c.received.some((m) => m.startsWith('CT:Total games')));
    const reset = c.received.indexOf('CTRESET');
    const first = c.received.findIndex((m) => m.startsWith('CT:RANK'));
    assert(reset !== -1 && first > reset, 'CTRESET precedes the first CT line');
    const ids = c.received.flatMap((m, i) => (i >= reset && (m === 'CTRESET' || m.startsWith('CT:')) ? [c.receivedIds[i]!] : []));
    assert(ids.every((id, k) => k === 0 || id > ids[k - 1]), 'strictly increasing ids');
    c.send('GAMELIST');
    await waitFor(() => c.received.filter((m) => m.startsWith('GL:')).length === 2);
    assert.match(c.received.filter((m) => m.startsWith('GL:'))[0], /^GL:\s+2B\s/);
  } finally {
    c.close();
    server.close();
  }
});

test('server: after emitResult(n) a client that asked for the table gets CTRESET+CT capped at n right behind the result', async () => {
  const { server, port } = await startServer();
  const games = [1, 2, 3].map((n) => ({ number: n, white: 'A', black: 'B', result: '1-0' }));
  server.setResultService(new ResultService(server, { games, refresh() {} } as unknown as GameRegistry, 0));
  const c = await TestClient.create(port, 'c');
  try {
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL'));
    c.send('RESULTTABLE');
    await waitFor(() => c.received.some((m) => m.startsWith('CT:Total games = 0')));
    server.setPlayers('A', 'B');
    server.emitResult('1-0 {x}', 2);
    server.setPlayers('B', 'A');
    await waitFor(() => c.received.includes('bplayer A') || c.received.some((m) => m.startsWith('BPLAYER')));
    const r = c.received.findIndex((m) => m.startsWith('RESULT') || m.startsWith('result'));
    const reset = c.received.lastIndexOf('CTRESET');
    const next = c.received.findIndex((m, i) => i > reset && /^WPLAYER/i.test(m));
    assert(r !== -1 && reset > r && next > reset, JSON.stringify(c.received.slice(-12)));
    const rows = c.received.slice(reset).filter((m) => m.startsWith('CT:') && /^CT:\d+\s{3,}/.test(m));
    assert.equal(rows.length, 2, 'game rows capped at 2');
    assert(c.received.some((m) => m.startsWith('CT:Total games = 2')));
    c.send('RESULTTABLE'); // the pull node-tlcv issues after the result is answered in full, capped at 2
    await waitFor(() => c.received.filter((m) => m === 'CTRESET').length === 3);
    assert(c.received.slice(c.received.lastIndexOf('CTRESET')).some((m) => m.startsWith('CT:Total games = 2')));
  } finally {
    c.close();
    server.close();
  }
});

test('server: a client that re-LOGONs on the same ip:port after a push gets a complete table on its first RESULTTABLE', async () => {
  const { server, port } = await startServer();
  const games = [1, 2].map((n) => ({ number: n, white: 'A', black: 'B', result: '1-0' }));
  server.setResultService(new ResultService(server, { games, refresh() {} } as unknown as GameRegistry, 0));
  const c = await TestClient.create(port, 'c');
  try {
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL'));
    c.send('RESULTTABLE');
    await waitFor(() => c.received.some((m) => m.startsWith('CT:Total games = 0')));
    server.setPlayers('A', 'B');
    server.emitResult('1-0 {x}', 2); // push to c
    await waitFor(() => c.received.some((m) => m.startsWith('CT:Total games = 2')));
    c.send('LOGOFF'); // restart on the same ip:port
    await sleep(100);
    c.received.length = 0;
    c.receivedIds.length = 0;
    c.logon();
    await waitFor(() => c.received.includes('LOGON SUCCESSFUL'));
    c.send('RESULTTABLE');
    await waitFor(() => c.received.some((m) => m.startsWith('CT:Total games = 2')));
    assert(c.received.includes('CTRESET'));
  } finally {
    c.close();
    server.close();
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';

import { TlcsServer, type ServerOptions } from '../src/tlcs/server.js';
import { Pipeline } from '../src/pipeline.js';
import type { NormalizedLine } from '../src/source/log-source.js';

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
    if (raw.startsWith('<')) {
      const close = raw.indexOf('>');
      this.send(`ACK: ${raw.slice(1, close)}`);
      this.received.push(raw.slice(close + 1));
    } else {
      this.received.push(raw);
    }
  }

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
  const { server, port } = await startServer();
  const client = await TestClient.create(port, 'tester');
  try {
    // The client bound an ephemeral port, NOT the broadcast port: a strict-TLCS
    // server (reply to broadcast port) would never reach it.
    assert.notEqual(client.port, port);
    client.logon();
    await waitFor(() => client.received.includes('LOGON SUCCESSFUL'));
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
  } finally {
    alice.close();
    bob.close();
    server.close();
  }
});

test('server: a client joining mid-game gets site, players, and the current FEN in order', async () => {
  const { server, port } = await startServer();
  const client = await TestClient.create(port, 'late');
  try {
    // The bridge started mid-game: a resync position (1 ply played, Black to move),
    // then both engines' identities arrive — the same order the pipeline would see.
    const pipeline = new Pipeline(server, { white: 'White', black: 'Black', site: 'TestSite' });
    const lines: NormalizedLine[] = [
      { uci: 'position startpos moves e2e4', engineId: 'EngB', direction: 'in' },
      { uci: 'go wtime 1000 btime 1000', engineId: 'EngB', direction: 'in' },
      { uci: 'bestmove e7e5', engineId: 'EngB', direction: 'out' },
      { uci: 'go wtime 1000 btime 1000', engineId: 'EngA', direction: 'in' },
    ];
    for (const n of lines) pipeline.handleLine(n);

    client.logon();
    const sawFen = () => client.received.some((m) => m.startsWith('FEN:'));
    await waitFor(() => client.received.includes('LOGON SUCCESSFUL') && sawFen());

    const order = (prefix: string) => client.received.findIndex((m) => m.startsWith(prefix));
    const logon = client.received.indexOf('LOGON SUCCESSFUL');
    const site = order('SITE:');
    const wp = order('WPLAYER:');
    const bp = order('BPLAYER:');
    const fen = order('FEN:');
    const fmr = order('FMR:');
    for (const [name, i] of Object.entries({ logon, site, wp, bp, fen, fmr })) {
      assert.ok(i >= 0, `${name} present in snapshot`);
    }
    assert.ok(logon < site && site < wp && wp < bp && bp < fen && fen < fmr, 'snapshot order: LOGON, SITE, WPLAYER, BPLAYER, FEN, FMR');
    assert.equal(client.received[wp], 'WPLAYER: EngA');
    assert.equal(client.received[bp], 'BPLAYER: EngB');
    assert.equal(
      client.received[fen],
      'FEN: rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq',
    );
  } finally {
    client.close();
    server.close();
  }
});

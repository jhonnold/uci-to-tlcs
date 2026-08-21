import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { logger } from '../util/logger.js';
import { ReliableSender } from './reliable-sender.js';
import * as P from './protocol.js';
import type { ColorCode } from './protocol.js';

export interface ServerOptions {
  port: number;
  bindAddr: string;
  /**
   * Drop a client that has sent nothing for this long. Defaults to 30s ≈ three
   * missed 10s PINGs (node-tlcv's keepalive). Exposed mainly so tests can use a
   * short timeout.
   */
  clientTimeoutMs?: number;
  /** How often to scan for silent clients. Defaults to {@link REAP_INTERVAL_MS}. */
  reapIntervalMs?: number;
}

/** How often the reaper scans for silent clients (matches node-tlcv's PING interval). */
const REAP_INTERVAL_MS = 10_000;
const DEFAULT_CLIENT_TIMEOUT_MS = 30_000;

interface ClientInfo {
  ip: string;
  port: number;
  user: string;
  /** epoch ms of the last datagram received from this client (for the reaper). */
  lastSeen: number;
}

/** Cached state replayed (unicast) to a client when it connects mid-game. */
interface Snapshot {
  site?: string;
  white?: string;
  black?: string;
  fenTruncated?: string;
  fmr?: number;
  whiteTimeCs?: number;
  blackTimeCs?: number;
  lastWpv?: string;
  lastBpv?: string;
}

/**
 * The UDP broadcast server node-tlcv connects to. Owns the socket, the client
 * registry, the reliable channel, and a snapshot of current game state for late
 * joiners. The pipeline in main.ts calls the `emit*` / `set*` methods.
 */
export class TlcsServer {
  private socket: Socket;
  /** Keyed by the client's `ip:port` "dest" token, so two clients on one host differ. */
  private clients = new Map<string, ClientInfo>();
  private sender: ReliableSender;
  private snap: Snapshot = {};
  private closed = false;
  private reaper: NodeJS.Timeout | null = null;
  private readonly clientTimeoutMs: number;

  constructor(private opts: ServerOptions) {
    this.clientTimeoutMs = opts.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    this.socket = createSocket('udp4');
    this.sender = new ReliableSender(
      (payload, dest) => this.rawSendTo(payload, dest),
      () => Array.from(this.clients.keys()),
    );

    this.socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
    this.socket.on('error', (err) => logger.error(`UDP socket error: ${err}`));
    this.socket.on('listening', () => {
      const a = this.socket.address();
      logger.info(`TLCS server listening on ${a.address}:${a.port}`);
    });
  }

  start(onReady?: () => void): void {
    if (onReady) this.socket.once('listening', onReady);
    this.socket.bind(this.opts.port, this.opts.bindAddr);
    this.reaper = setInterval(() => this.reapStale(), this.opts.reapIntervalMs ?? REAP_INTERVAL_MS);
    this.reaper.unref?.();
  }

  /** The actual bound socket address (useful when binding port 0 in tests). */
  address(): AddressInfo {
    return this.socket.address();
  }

  close(): void {
    this.closed = true;
    if (this.reaper) clearInterval(this.reaper);
    this.sender.close();
    this.socket.close();
  }

  // ---------------------------------------------------------------- outbound API

  setSite(site: string): void {
    this.snap.site = site;
    this.sender.enqueue(P.site(site));
  }

  setPlayers(white: string, black: string): void {
    this.snap.white = white;
    this.snap.black = black;
    this.sender.enqueue(P.wplayer(white));
    this.sender.enqueue(P.bplayer(black));
  }

  /** Initial board position (no move yet): FEN + FMR. */
  emitInitialPosition(fenTruncated: string, fmr: number): void {
    this.snap.fenTruncated = fenTruncated;
    this.snap.fmr = fmr;
    this.sender.enqueue(P.fen(fenTruncated));
    this.sender.enqueue(P.fmr(fmr));
  }

  /** A played move, in TLCS order: FEN (post-move), then MOVE, then FMR. */
  emitMove(args: {
    fenTruncated: string;
    color: ColorCode;
    fullMoveNumber: number;
    san: string;
    fmr: number;
  }): void {
    this.snap.fenTruncated = args.fenTruncated;
    this.snap.fmr = args.fmr;
    this.sender.enqueue(P.fen(args.fenTruncated));
    this.sender.enqueue(P.move(args.color, args.fullMoveNumber, args.san));
    this.sender.enqueue(P.fmr(args.fmr));
  }

  emitClocks(whiteCs: number, blackCs: number): void {
    this.snap.whiteTimeCs = whiteCs;
    this.snap.blackTimeCs = blackCs;
    this.broadcastUnwrapped(P.time('w', whiteCs, blackCs));
    this.broadcastUnwrapped(P.time('b', blackCs, whiteCs));
  }

  emitPv(color: ColorCode, depth: number, scoreCp: number, timeCs: number, nodes: number, sanPv: string[]): void {
    const msg = P.pv(color, depth, scoreCp, timeCs, nodes, sanPv);
    if (color === 'w') this.snap.lastWpv = msg;
    else this.snap.lastBpv = msg;
    this.broadcastUnwrapped(msg);
  }

  emitResult(result: string): void {
    this.sender.enqueue(P.result(result));
  }

  // ----------------------------------------------------------------- inbound

  private onMessage(buf: Buffer, rinfo: RemoteInfo): void {
    if (this.closed) return;
    const msg = buf.toString().trim();
    const ip = rinfo.address;
    const port = rinfo.port;
    const dest = destKey(ip, port);
    logger.debug(`<- ${dest}  ${msg}`);

    // Any datagram is proof of life for the reaper.
    const known = this.clients.get(dest);
    if (known) known.lastSeen = Date.now();

    if (msg.startsWith('LOGONv15')) {
      const user = msg.split(':')[1]?.trim() || 'unknown';
      this.onLogon(ip, port, user);
    } else if (msg === 'PING') {
      this.rawSend(P.PONG, ip, port);
    } else if (msg.startsWith('ACK')) {
      const id = parseInt(msg.replace(/^ACK[:\s]*/, '').trim(), 10);
      if (!Number.isNaN(id)) this.sender.ack(id, dest);
    } else if (msg === 'RESULTTABLE') {
      this.sendResultTable(ip, port);
    } else if (msg.startsWith('CHAT')) {
      this.onChat(dest, msg.replace(/^CHAT[:\s]*/, '').trim());
    } else if (msg === 'LOGOFF') {
      this.onLogoff(dest);
    } else {
      logger.debug(`Unhandled client message from ${dest}: ${msg}`);
    }
  }

  private onLogon(ip: string, port: number, user: string): void {
    const dest = destKey(ip, port);
    const isNew = !this.clients.has(dest);
    this.clients.set(dest, { ip, port, user, lastSeen: Date.now() });
    logger.info(`LOGON ${user}@${dest} (${this.clients.size} client(s))`);

    this.rawSend(P.LOGON_SUCCESSFUL, ip, port);

    // Notify existing spectators of the new arrival.
    if (isNew) {
      for (const other of this.clients.keys()) {
        if (other !== dest) this.sender.enqueue(P.adduser(user), other);
      }
    }

    this.sendSnapshot(dest);
  }

  private onLogoff(dest: string): void {
    const c = this.clients.get(dest);
    this.clients.delete(dest);
    if (c) {
      logger.info(`LOGOFF ${c.user}@${dest}`);
      this.sender.enqueue(P.deluser(c.user));
    }
  }

  private onChat(dest: string, text: string): void {
    if (!text) return;
    const name = this.clients.get(dest)?.user ?? 'unknown';
    this.sender.enqueue(P.chat(`${name}: ${text}`));
  }

  /** Minimal crosstable so node-tlcv's results parser terminates cleanly. */
  private sendResultTable(ip: string, port: number): void {
    this.rawSend(P.CTRESET, ip, port);
    this.rawSend(P.ct('total games = 0'), ip, port);
  }

  /** Unicast current game state to a freshly-connected client. */
  private sendSnapshot(dest: string): void {
    const s = this.snap;
    if (s.site) this.sender.enqueue(P.site(s.site), dest);
    if (s.white) this.sender.enqueue(P.wplayer(s.white), dest);
    if (s.black) this.sender.enqueue(P.bplayer(s.black), dest);
    if (s.fenTruncated) this.sender.enqueue(P.fen(s.fenTruncated), dest);
    if (s.fmr !== undefined) this.sender.enqueue(P.fmr(s.fmr), dest);

    // Clocks/PV also go through the reliable queue (after FMR) so the position
    // always precedes them for a fresh client; live broadcasts of these stay
    // unwrapped (high frequency).
    if (s.whiteTimeCs !== undefined && s.blackTimeCs !== undefined) {
      this.sender.enqueue(P.time('w', s.whiteTimeCs, s.blackTimeCs), dest);
      this.sender.enqueue(P.time('b', s.blackTimeCs, s.whiteTimeCs), dest);
    }
    if (s.lastWpv) this.sender.enqueue(s.lastWpv, dest);
    if (s.lastBpv) this.sender.enqueue(s.lastBpv, dest);
  }

  /** Drop clients that have gone silent past the timeout (e.g. a crashed viewer). */
  private reapStale(): void {
    const cutoff = Date.now() - this.clientTimeoutMs;
    for (const [dest, c] of this.clients) {
      if (c.lastSeen < cutoff) {
        this.clients.delete(dest);
        logger.info(`Reaped silent client ${c.user}@${dest} (${this.clients.size} client(s))`);
        this.sender.enqueue(P.deluser(c.user));
      }
    }
  }

  // ----------------------------------------------------------------- transport

  private rawSend(payload: string, ip: string, port: number): void {
    if (this.closed) return;
    // Reply to the client's *source* ip:port. Strict TLCS streams to the broadcast
    // port and ignores the source port, but compliant clients (node-tlcv, desktop
    // TLCV) send from the broadcast port anyway, so this is identical for them — and
    // it additionally lets clients on ephemeral ports receive the broadcast.
    this.socket.send(payload, port, ip, (err) => {
      if (err) logger.warn(`send to ${ip}:${port} failed: ${err}`);
    });
    logger.debug(`-> ${ip}:${port}  ${payload}`);
  }

  /** Send to a client identified by its `ip:port` dest token. */
  private rawSendTo(payload: string, dest: string): void {
    const sep = dest.lastIndexOf(':');
    const ip = dest.slice(0, sep);
    const port = Number(dest.slice(sep + 1));
    this.rawSend(payload, ip, port);
  }

  private broadcastUnwrapped(msg: string): void {
    for (const dest of this.clients.keys()) this.rawSendTo(msg, dest);
  }
}

/** The registry/addressing token for a client. udp4 ⇒ IPv4, so ':' splits cleanly. */
function destKey(ip: string, port: number): string {
  return `${ip}:${port}`;
}

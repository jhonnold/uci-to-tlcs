import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import { logger } from '../util/logger.js';
import { ReliableSender } from './reliable-sender.js';
import * as P from './protocol.js';
import type { ColorCode } from './protocol.js';

export interface ServerOptions {
  port: number;
  bindAddr: string;
}

interface ClientInfo {
  ip: string;
  user: string;
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
  private clients = new Map<string, ClientInfo>();
  private sender: ReliableSender;
  private snap: Snapshot = {};
  private closed = false;

  constructor(private opts: ServerOptions) {
    this.socket = createSocket('udp4');
    this.sender = new ReliableSender(
      (payload, ip) => this.rawSend(payload, ip),
      () => Array.from(this.clients.keys()),
    );

    this.socket.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
    this.socket.on('error', (err) => logger.error(`UDP socket error: ${err}`));
    this.socket.on('listening', () => {
      const a = this.socket.address();
      logger.info(`TLCS server listening on ${a.address}:${a.port}`);
    });
  }

  start(): void {
    this.socket.bind(this.opts.port, this.opts.bindAddr);
  }

  close(): void {
    this.closed = true;
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
    logger.debug(`<- ${ip}:${rinfo.port}  ${msg}`);

    if (msg.startsWith('LOGONv15')) {
      const user = msg.split(':')[1]?.trim() || 'unknown';
      this.onLogon(ip, user);
    } else if (msg === 'PING') {
      this.rawSend(P.PONG, ip);
    } else if (msg.startsWith('ACK')) {
      const id = parseInt(msg.replace(/^ACK[:\s]*/, '').trim(), 10);
      if (!Number.isNaN(id)) this.sender.ack(id, ip);
    } else if (msg === 'RESULTTABLE') {
      this.sendResultTable(ip);
    } else if (msg.startsWith('CHAT')) {
      this.onChat(ip, msg.replace(/^CHAT[:\s]*/, '').trim());
    } else if (msg === 'LOGOFF') {
      this.onLogoff(ip);
    } else {
      logger.debug(`Unhandled client message from ${ip}: ${msg}`);
    }
  }

  private onLogon(ip: string, user: string): void {
    const isNew = !this.clients.has(ip);
    this.clients.set(ip, { ip, user });
    logger.info(`LOGON ${user}@${ip} (${this.clients.size} client(s))`);

    this.rawSend(P.LOGON_SUCCESSFUL, ip);

    // Notify existing spectators of the new arrival.
    if (isNew) {
      for (const otherIp of this.clients.keys()) {
        if (otherIp !== ip) this.sender.enqueue(P.adduser(user), otherIp);
      }
    }

    this.sendSnapshot(ip);
  }

  private onLogoff(ip: string): void {
    const c = this.clients.get(ip);
    this.clients.delete(ip);
    if (c) {
      logger.info(`LOGOFF ${c.user}@${ip}`);
      this.sender.enqueue(P.deluser(c.user));
    }
  }

  private onChat(ip: string, text: string): void {
    if (!text) return;
    const name = this.clients.get(ip)?.user ?? 'unknown';
    this.sender.enqueue(P.chat(`${name}: ${text}`));
  }

  /** Minimal crosstable so node-tlcv's results parser terminates cleanly. */
  private sendResultTable(ip: string): void {
    this.rawSend(P.CTRESET, ip);
    this.rawSend(P.ct('total games = 0'), ip);
  }

  /** Unicast current game state to a freshly-connected client. */
  private sendSnapshot(ip: string): void {
    const s = this.snap;
    if (s.site) this.sender.enqueue(P.site(s.site), ip);
    if (s.white) this.sender.enqueue(P.wplayer(s.white), ip);
    if (s.black) this.sender.enqueue(P.bplayer(s.black), ip);
    if (s.fenTruncated) this.sender.enqueue(P.fen(s.fenTruncated), ip);
    if (s.fmr !== undefined) this.sender.enqueue(P.fmr(s.fmr), ip);

    if (s.whiteTimeCs !== undefined && s.blackTimeCs !== undefined) {
      this.rawSend(P.time('w', s.whiteTimeCs, s.blackTimeCs), ip);
      this.rawSend(P.time('b', s.blackTimeCs, s.whiteTimeCs), ip);
    }
    if (s.lastWpv) this.rawSend(s.lastWpv, ip);
    if (s.lastBpv) this.rawSend(s.lastBpv, ip);
  }

  // ----------------------------------------------------------------- transport

  private rawSend(payload: string, ip: string): void {
    if (this.closed) return;
    // Always stream to clientIP:<broadcastPort> — TLCS ignores the client's
    // source port (see node-tlcv udp-transport.ts and tlcv-udp-broadcast-protocol).
    this.socket.send(payload, this.opts.port, ip, (err) => {
      if (err) logger.warn(`send to ${ip}:${this.opts.port} failed: ${err}`);
    });
    logger.debug(`-> ${ip}:${this.opts.port}  ${payload}`);
  }

  private broadcastUnwrapped(msg: string): void {
    for (const ip of this.clients.keys()) this.rawSend(msg, ip);
  }
}

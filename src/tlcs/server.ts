import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { logger } from '../util/logger.js';
import { metrics, sentType, receivedType } from '../metrics.js';
import { ReliableSender, type Outbound, type SenderOptions } from './reliable-sender.js';
import { InboundDeduper, parseAck, parseNumbered } from './inbound.js';
import { SessionCommands, redactSecrets } from './commands.js';
import { AdminCommands, RATE_DEFAULT, type RateLimit } from './admin.js';
import * as P from './protocol.js';
import type { ColorCode } from './protocol.js';
import type { UciInfo } from '../uci/info.js';

export interface ServerOptions extends Partial<SenderOptions> {
  port: number;
  bindAddr: string;
  /**
   * Drop a client that has sent nothing for this long. Defaults to 70s: covers the
   * desktop's 20s PING with margin (spec §5.3). Exposed so tests can use a short timeout.
   */
  clientTimeoutMs?: number;
  /** MENU lines (verbatim) sent in every logon burst. */
  menus?: string[];
  /** How often to scan for silent clients. Defaults to {@link REAP_INTERVAL_MS}. */
  reapIntervalMs?: number;
  /** Called once per stall episode (a busy client with no ACK progress for stallMs). */
  onStalled?: (dest: string) => void;
  /** ADMINPASS: admin commands (SECURITY/BOOT/SRBOOT) are disabled unless non-empty. */
  adminPass?: string;
  /** MAXCLIENTS: refuse new LOGONs beyond this many clients (0 = unlimited). */
  maxClients?: number;
  /** BANNED=: source IPs whose datagrams are dropped silently. */
  bannedIps?: string[];
  /** Per-source-IP datagram budget (ACKs are free). */
  rateLimit?: RateLimit;
  /** A game item (`epoch`) was ACKed by `dest`; `critical` marks the game's `result`. */
  onAcked?: (dest: string, epoch: number, critical: boolean) => void;
  /** Every accepted LOGON, right before the resync replay. */
  onLogon?: (dest: string) => void;
  /** The client table changed (addClient / removeClient). */
  onClientsChanged?: () => void;
}

/** How often the reaper scans for silent clients (matches node-tlcv's PING interval). */
const REAP_INTERVAL_MS = 10_000;
const DEFAULT_CLIENT_TIMEOUT_MS = 70_000;

export interface ClientInfo {
  ip: string;
  port: number;
  user: string;
  /** epoch ms of the last datagram received from this client (for the reaper). */
  lastSeen: number;
}

/** Latest-value fields that feed a resync's clocks/PV (not part of the game stream). */
interface Snapshot {
  site?: string;
  whiteTimeCs?: number;
  blackTimeCs?: number;
  lastWpv?: string;
  lastBpv?: string;
  lastWinfo?: string;
  lastBinfo?: string;
}

/** A game-stream item; xMOVE items carry the mover's PV so a replay keeps node-tlcv's move comments. */
interface StreamItem extends Outbound {
  pv?: string;
}

/** Every game-channel message of one game (epoch), kept while any client still references it. */
interface GameRecord {
  epoch: number;
  stream: StreamItem[];
  finished: boolean;
  /** Replay cache, valid once finished (the stream is immutable then). */
  cache?: { site: string | undefined; withResult: boolean; out: Outbound[] };
}

const isMoveBody = (b: string): boolean => b.startsWith('WMOVE:') || b.startsWith('BMOVE:');

/**
 * The UDP broadcast server node-tlcv connects to. Owns the socket, the client
 * registry, the per-client reliable channel, and a record of every game still owed to
 * some client (so a late joiner, a lossy client or a coalesce can be replayed). The
 * pipeline in main.ts calls the `emit*` / `set*` methods.
 */
export class TlcsServer {
  private socket: Socket;
  /** Keyed by the client's `ip:port` "dest" token, so two clients on one host differ. */
  private clients = new Map<string, ClientInfo>();
  private sender: ReliableSender;
  private results?: { onResultTable(dest: string): void; onGameList(dest: string): void; onResultEmitted?(n: number): void };
  private snap: Snapshot = {};
  private records = new Map<number, GameRecord>();
  private cur: GameRecord = { epoch: 0, stream: [], finished: false };
  /** Mover's PV emitted since that colour's last move (consumed by emitMove). */
  private pvSinceMove: { w?: string; b?: string } = {};
  private dedupe = new InboundDeduper();
  private closed = false;
  private reaper: NodeJS.Timeout | null = null;
  private readonly clientTimeoutMs: number;
  private readonly commands: SessionCommands;
  private readonly admin: AdminCommands;

  constructor(private opts: ServerOptions) {
    this.clientTimeoutMs = opts.clientTimeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS;
    this.admin = new AdminCommands(this, {
      adminPass: opts.adminPass,
      maxClients: opts.maxClients ?? 0,
      bannedIps: opts.bannedIps ?? [],
      rateLimit: opts.rateLimit ?? RATE_DEFAULT,
    });
    this.commands = new SessionCommands(this, {
      menus: opts.menus ?? [],
      clientTimeoutMs: this.clientTimeoutMs,
      admit: (dest, isNew) => this.admin.admitLogon(dest, isNew),
      beforeResync: (dest) => this.opts.onLogon?.(dest),
    });
    this.records.set(0, this.cur);
    this.socket = createSocket('udp4');
    this.sender = new ReliableSender(
      {
        rawSend: (payload, dest) => this.sendRaw(dest, payload),
        replay: (e, withResult) => this.replay(e, withResult),
        // Never reap on ACK timeout alone (spec §5.3): the idle reaper owns removal.
        onStalled: opts.onStalled,
        onAcked: (d, it) => {
          if (it.epoch !== undefined) this.opts.onAcked?.(d, it.epoch, !!it.critical);
        },
      },
      opts,
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
    this.reaper = setInterval(() => {
      this.commands.reap();
      this.admin.prune();
    }, this.opts.reapIntervalMs ?? REAP_INTERVAL_MS);
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

  // ------------------------------------------------------- transport API (T06/T07/T09/T10)

  /** Handler for RESULTTABLE / GAMELIST requests (see results/result-commands.ts). */
  setResultService(h: { onResultTable(dest: string): void; onGameList(dest: string): void; onResultEmitted?(n: number): void }): void {
    this.results = h;
  }

  /** Numbered control item to one client, or to every registered client when `dest` is null. */
  enqueue(dest: string | null, body: string, opts: { onGiveUp?: (dest: string) => void; holdMs?: number } = {}): void {
    this.sender.enqueue(dest, { body, onGiveUp: opts.onGiveUp, holdMs: opts.holdMs });
  }

  /** Unnumbered, immediate send (LOGON SUCCESSFUL, MSG to unknown clients, PONG). */
  sendRaw(dest: string, body: string): void {
    const sep = dest.lastIndexOf(':');
    this.rawSend(body, dest.slice(0, sep), Number(dest.slice(sep + 1)));
  }

  /** Register (or refresh) a client; true when it is new. Keeps its id counter and RTT state. */
  addClient(ip: string, port: number, user: string): boolean {
    const dest = destKey(ip, port);
    const isNew = !this.clients.has(dest);
    this.clients.set(dest, { ip, port, user, lastSeen: Date.now() });
    this.sender.addClient(dest);
    this.opts.onClientsChanged?.();
    return isNew;
  }

  removeClient(dest: string): ClientInfo | undefined {
    const c = this.clients.get(dest);
    this.clients.delete(dest);
    this.admin.forget(dest);
    this.sender.removeClient(dest);
    this.gcRecords();
    this.opts.onClientsChanged?.();
    return c;
  }

  getClient(dest: string): Readonly<ClientInfo> | undefined {
    return this.clients.get(dest);
  }

  clientList(): Array<{ dest: string } & Readonly<ClientInfo>> {
    return Array.from(this.clients, ([dest, c]) => ({ dest, ...c }));
  }

  /**
   * Full replay of the current game for one client, then clocks and last PV as latest
   * items. The only LOGON payload (a board snapshot cannot repair a client whose board is
   * already loaded). Never clears control items or the in-flight item.
   */
  resync(dest: string): void {
    this.sender.resync(dest, this.cur.epoch, this.cur.finished);
    if (this.cur.stream.length === 0 && this.snap.site) this.enqueue(dest, P.site(this.snap.site));
    const s = this.snap;
    const latest = (body: string, key: string) => this.sender.enqueue(dest, { body, latest: key });
    if (s.whiteTimeCs !== undefined && s.blackTimeCs !== undefined) {
      latest(P.time('w', s.whiteTimeCs, s.blackTimeCs), 'WTIME');
      latest(P.time('b', s.blackTimeCs, s.whiteTimeCs), 'BTIME');
    }
    if (s.lastWpv) latest(s.lastWpv, 'WPV');
    if (s.lastBpv) latest(s.lastBpv, 'BPV');
    if (s.lastWinfo) latest(s.lastWinfo, 'WINFO');
    if (s.lastBinfo) latest(s.lastBinfo, 'BINFO');
  }

  queueDepth(dest: string): number {
    return this.sender.depth(dest);
  }

  rttStats(dest: string): { srtt: number; rttvar: number; rto: number } | null {
    return this.sender.rttStats(dest);
  }

  /** Epoch of the current (most recent) game; increments per setPlayers. */
  currentEpoch(): number {
    return this.cur.epoch;
  }

  recordEpochs(): number[] {
    return Array.from(this.records.keys()).sort((a, b) => a - b);
  }

  // ---------------------------------------------------------------- outbound API

  setSite(site: string): void {
    this.snap.site = site;
    this.sender.enqueue(null, { body: P.site(site) });
  }

  setPlayers(white: string, black: string): void {
    this.cur = { epoch: this.cur.epoch + 1, stream: [], finished: false };
    this.records.set(this.cur.epoch, this.cur);
    this.pvSinceMove = {};
    this.gcRecords();
    this.game(P.wplayer(white));
    this.game(P.bplayer(black));
  }

  /** Initial board position (no move yet): FEN + FMR. */
  emitInitialPosition(fenTruncated: string, fmr: number): void {
    this.game(P.fen(fenTruncated));
    this.game(P.fmr(fmr));
  }

  /** A played move, in TLCS order: FEN (post-move), then MOVE, then FMR. */
  emitMove(args: {
    fenTruncated: string;
    color: ColorCode;
    fullMoveNumber: number;
    san: string;
    fmr: number;
  }): void {
    const pv = this.pvSinceMove[args.color];
    delete this.pvSinceMove[args.color];
    this.game(P.fen(args.fenTruncated));
    this.game(P.move(args.color, args.fullMoveNumber, args.san), false, pv);
    this.game(P.fmr(args.fmr));
  }

  /** `level <text>` game-channel line (T05's time-control/level announcement). */
  emitLevel(text: string): void {
    this.game(P.level(text));
  }

  emitClocks(whiteCs: number, blackCs: number): void {
    this.snap.whiteTimeCs = whiteCs;
    this.snap.blackTimeCs = blackCs;
    this.sender.enqueue(null, { body: P.time('w', whiteCs, blackCs), latest: 'WTIME' });
    this.sender.enqueue(null, { body: P.time('b', blackCs, whiteCs), latest: 'BTIME' });
  }

  /** With `info`, also a latest-only WINFO/BINFO; not attached to xMOVE, so a game replay carries none. */
  emitPv(color: ColorCode, depth: number, scoreCp: number, timeCs: number, nodes: number, pv: string[], info?: UciInfo): void {
    const msg = P.pv(color, depth, scoreCp, timeCs, nodes, pv);
    if (color === 'w') this.snap.lastWpv = msg;
    else this.snap.lastBpv = msg;
    this.pvSinceMove[color] = msg;
    this.sender.enqueue(null, { body: msg, latest: color === 'w' ? 'WPV' : 'BPV' });
    if (!info) return;
    const infoMsg = P.info(color, info, pv);
    if (color === 'w') this.snap.lastWinfo = infoMsg;
    else this.snap.lastBinfo = infoMsg;
    this.sender.enqueue(null, { body: infoMsg, latest: color === 'w' ? 'WINFO' : 'BINFO' });
  }

  /** `gameNumber` (PGN authority only): after the result, queue a table capped at it per client. */
  emitResult(result: string, gameNumber?: number): void {
    this.game(P.result(result), true);
    this.cur.finished = true;
    if (gameNumber !== undefined) this.results?.onResultEmitted?.(gameNumber);
  }

  /** Single path for every game-channel message: record it, then queue it for all clients. */
  private game(body: string, critical = false, pv?: string): void {
    const item: StreamItem = { body, epoch: this.cur.epoch, critical: critical || undefined, pv };
    this.cur.stream.push(item);
    this.sender.enqueue(null, item);
  }

  /** Keep `cur` and every epoch some client's queue or in-flight slot still references. */
  private gcRecords(): void {
    const live = this.sender.referencedEpochs();
    for (const e of this.records.keys()) if (e !== this.cur.epoch && !live.has(e)) this.records.delete(e);
  }

  /**
   * Replay of game `epoch`: SITE, then the stream verbatim through the first move's FMR
   * (players, setup sequence, level), then only the SANs (each preceded by the mover's
   * PV so node-tlcv does not label them "(Book)"), then the last FEN/FMR, then the result
   * iff `withResult`. Items are tagged with the epoch so the next splice replaces them.
   */
  private replay(epoch: number, withResult: boolean): Outbound[] | null {
    const rec = this.records.get(epoch);
    if (!rec || rec.stream.length === 0) return null;
    const site = this.snap.site;
    if (rec.finished && rec.cache && rec.cache.site === site && rec.cache.withResult === withResult) {
      return rec.cache.out;
    }
    const st = rec.stream;
    const out: Outbound[] = [];
    if (site) out.push({ body: P.site(site), epoch });
    const copied = new Set<StreamItem>();
    const copy = (it: StreamItem): void => {
      copied.add(it);
      if (it.pv) out.push({ body: it.pv, epoch });
      out.push({ body: it.body, epoch, critical: it.critical });
    };

    const firstMove = st.findIndex((it) => isMoveBody(it.body));
    let end = st.length - 1;
    if (firstMove >= 0) {
      end = firstMove;
      for (let i = firstMove + 1; i < st.length; i++) {
        if (st[i].body.startsWith('FMR:')) {
          end = i;
          break;
        }
      }
    }
    for (let i = 0; i <= end; i++) if (!st[i].critical) copy(st[i]);
    for (let i = end + 1; i < st.length; i++) {
      if (isMoveBody(st[i].body) || st[i].body.startsWith('level ')) copy(st[i]);
    }
    let lastFen: StreamItem | undefined;
    let lastFmr: StreamItem | undefined;
    for (const it of st) {
      if (it.body.startsWith('FEN:')) lastFen = it;
      else if (it.body.startsWith('FMR:')) lastFmr = it;
    }
    if (lastFen && !copied.has(lastFen)) copy(lastFen);
    if (lastFmr && !copied.has(lastFmr)) copy(lastFmr);
    if (withResult) {
      const res = st.find((it) => it.critical);
      if (res) out.push({ body: res.body, epoch, critical: true });
    }
    if (rec.finished) rec.cache = { site, withResult, out };
    return out;
  }

  // ----------------------------------------------------------------- inbound

  private onMessage(buf: Buffer, rinfo: RemoteInfo): void {
    if (this.closed) return;
    let msg = buf.toString().trim();
    if (!msg) return;
    metrics.inc('tlcs_messages_received_total', { type: receivedType(msg) });
    const ip = rinfo.address;
    const port = rinfo.port;
    const dest = destKey(ip, port);
    // Banned sources are dropped before the ACK (as in the reference); ACKs are not charged
    // to the rate limiter (no amplification, and legitimate clients ACK every numbered item).
    if (this.admin.isBanned(ip)) return;
    if (parseAck(msg) === null && !this.admin.allowDatagram(ip)) return;
    logger.debug(`<- ${dest}  ${redactSecrets(msg)}`);

    // Any datagram is proof of life for the reaper.
    const known = this.clients.get(dest);
    if (known) known.lastSeen = Date.now();

    const numbered = msg.startsWith('<');
    if (numbered) {
      const n = parseNumbered(msg);
      if (!n) {
        logger.debug(`Malformed numbered message from ${dest}: ${redactSecrets(msg)}`);
        return;
      }
      this.rawSend(P.ack(n.id), ip, port); // ACK every copy, even duplicates
      msg = n.body.trim();
      const dup = msg.startsWith('LOGONv15')
        ? this.dedupe.isDuplicateLogon(dest, n.id)
        : this.dedupe.isDuplicate(dest, n.id);
      if (dup) return;
    }

    const ackId = parseAck(msg);
    if (ackId !== null) {
      this.sender.ack(dest, ackId);
      return;
    }
    if (!numbered && msg.startsWith('LOGONv15')) this.dedupe.reset(dest);
    this.dispatch(msg, ip, port, numbered);
  }

  private dispatch(msg: string, ip: string, port: number, numbered: boolean): void {
    if (msg.startsWith('LOGONv15')) this.admin.forget(destKey(ip, port)); // any re-logon revokes admin
    if (this.admin.handle(msg, ip, port)) return;
    if (this.commands.handle(msg, ip, port, numbered)) return;
    const dest = destKey(ip, port);
    if (msg === 'RESULTTABLE') {
      if (this.results) this.results.onResultTable(dest);
      else logger.debug(`RESULTTABLE from ${dest}: no result service`);
    } else if (msg === 'GAMELIST') {
      if (this.results) this.results.onGameList(dest);
      else logger.debug(`GAMELIST from ${dest}: no result service`);
    } else {
      logger.debug(`Unhandled client message from ${destKey(ip, port)}: ${redactSecrets(msg)}`);
    }
  }

  // ----------------------------------------------------------------- transport

  private rawSend(payload: string, ip: string, port: number): void {
    if (this.closed) return;
    // Reply to the client's *source* ip:port. Strict TLCS streams to the broadcast
    // port and ignores the source port, but compliant clients (node-tlcv, desktop
    // TLCV) send from the broadcast port anyway, so this is identical for them — and
    // it additionally lets clients on ephemeral ports receive the broadcast.
    metrics.inc('tlcs_messages_sent_total', { type: sentType(payload) });
    this.socket.send(payload, port, ip, (err) => {
      if (err) logger.warn(`send to ${ip}:${port} failed: ${err}`);
    });
    logger.debug(`-> ${ip}:${port}  ${payload}`);
  }
}

/** The registry/addressing token for a client. udp4 ⇒ IPv4, so ':' splits cleanly. */
function destKey(ip: string, port: number): string {
  return `${ip}:${port}`;
}

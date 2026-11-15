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
import type { BroadcastSink } from '../pipeline.js';

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

/** Latest-value fields of one board that feed a resync's clocks/PV (not part of the game stream). */
interface Snapshot {
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
  board: number;
  stream: StreamItem[];
  finished: boolean;
  /** PGN game number of the result (TLCS-MG `GAMENO`, sent with the result to wrapped clients only). */
  gameNo?: number;
  /** Replay caches, valid once finished (the stream is immutable then), per site/result/wrapping. */
  cache?: Map<string, Outbound[]>;
}

/** One board: a slot showing one game after another (TLCS-MG). Board 1 is the single-game stream. */
interface Board {
  id: number;
  cur: GameRecord;
  snap: Snapshot;
  /** Mover's PV emitted since that colour's last move (consumed by emitMove). */
  pvSinceMove: { w?: string; b?: string };
  /** The board's BroadcastSink (board 1: the server itself). */
  sink: BroadcastSink;
}

const MULTIGAME_RE = /^MULTIGAME:\s*(\d+)\s*$/;

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
  private site?: string;
  private records = new Map<number, GameRecord>();
  /** boards[i] is board i+1; board 1 always exists. */
  private boards: Board[] = [];
  /** Last epoch handed out (epochs are unique across boards). */
  private epochSeq = 0;
  /** Dests that opted in to TLCS-MG (MULTIGAME: 1) since their last LOGON. */
  private multi = new Set<string>();
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
    this.boards.push(this.newBoard(1));
    this.socket = createSocket('udp4');
    this.sender = new ReliableSender(
      {
        rawSend: (payload, dest) => this.sendRaw(dest, payload),
        replay: (e, withResult, dest) => this.replay(e, withResult, dest),
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
  enqueue(dest: string | null, body: string, opts: { onGiveUp?: (dest: string) => void; holdMs?: number; pinned?: boolean } = {}): void {
    this.sender.enqueue(dest, { body, onGiveUp: opts.onGiveUp, holdMs: opts.holdMs, pinned: opts.pinned });
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
    this.multi.delete(dest);
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
   * already loaded). Never clears control items or the in-flight item. A TLCS-MG client gets
   * every board's current game, wrapped.
   */
  resync(dest: string): void {
    const boards = this.multi.has(dest) ? this.boards : [this.boards[0]];
    this.sender.resyncAll(
      dest,
      boards.map((b) => ({ epoch: b.cur.epoch, finished: b.cur.finished })),
    );
    if (boards.every((b) => b.cur.stream.length === 0) && this.site) this.enqueue(dest, P.site(this.site));
    for (const b of boards) {
      const s = b.snap;
      const wrap = this.multi.has(dest);
      const latest = (body: string, key: string) => this.sender.enqueue(dest, this.present(wrap, b.cur, { body, latest: key })[0]);
      if (s.whiteTimeCs !== undefined && s.blackTimeCs !== undefined) {
        latest(P.time('w', s.whiteTimeCs, s.blackTimeCs), 'WTIME');
        latest(P.time('b', s.blackTimeCs, s.whiteTimeCs), 'BTIME');
      }
      if (s.lastWpv) latest(s.lastWpv, 'WPV');
      if (s.lastBpv) latest(s.lastBpv, 'BPV');
      if (s.lastWinfo) latest(s.lastWinfo, 'WINFO');
      if (s.lastBinfo) latest(s.lastBinfo, 'BINFO');
    }
  }

  queueDepth(dest: string): number {
    return this.sender.depth(dest);
  }

  rttStats(dest: string): { srtt: number; rttvar: number; rto: number } | null {
    return this.sender.rttStats(dest);
  }

  /** Epoch of board 1's current (most recent) game; a new epoch per setPlayers on any board. */
  currentEpoch(): number {
    return this.boards[0].cur.epoch;
  }

  recordEpochs(): number[] {
    return Array.from(this.records.keys()).sort((a, b) => a - b);
  }

  // ------------------------------------------------------------------ TLCS-MG

  /** Board ids so far (1..n). */
  boardCount(): number {
    return this.boards.length;
  }

  /**
   * The BroadcastSink of board `id`, created (with every board below it) on first use and
   * announced to TLCS-MG clients with a fresh `BOARDS:` list. Board 1 is this server's own
   * sink. SITE is broadcast-wide: only board 1 sets it.
   */
  board(id: number): BroadcastSink {
    if (!Number.isInteger(id) || id < 1) throw new Error(`bad board id ${id}`);
    if (id > this.boards.length) {
      while (this.boards.length < id) this.boards.push(this.newBoard(this.boards.length + 1));
      for (const d of this.multi) this.sendBoards(d);
    }
    return this.boards[id - 1].sink;
  }

  /** Does `dest` receive TLCS-MG (wrapped) game lines? */
  isMulti(dest: string): boolean {
    return this.multi.has(dest);
  }

  /** Restore a client's opt-in without a handshake (state-file restore). */
  setMulti(dest: string): void {
    if (this.clients.has(dest)) this.multi.add(dest);
  }

  /** `MULTIGAME: <v>` from a registered client: switch it to wrapped boards and resync it. */
  private onMultigame(dest: string, version: number): void {
    if (!this.clients.has(dest)) {
      logger.debug(`MULTIGAME from unknown ${dest}: ignored`);
      return;
    }
    if (version < P.MULTIGAME_VERSION) {
      logger.debug(`MULTIGAME ${version} from ${dest}: unsupported version, ignored`);
      return;
    }
    // Queued games were encoded for the previous mode: take them out, answer, then queue their
    // replays again (wrapped) so the reply precedes every wrapped line and no owed result is lost.
    const owed = this.sender.takeGameItems(dest);
    this.multi.add(dest);
    logger.info(`MULTIGAME ${dest}: ${this.boards.length} board(s) (re-queued ${owed.length} owed game(s))`);
    this.enqueue(dest, P.multigame(P.MULTIGAME_VERSION));
    this.sendBoards(dest);
    for (const o of owed) this.sender.enqueueAll(dest, this.replay(o.epoch, o.withResult, dest) ?? []);
    this.resync(dest);
    this.opts.onClientsChanged?.();
  }

  private newBoard(id: number): Board {
    const cur: GameRecord = { epoch: id === 1 ? 0 : ++this.epochSeq, board: id, stream: [], finished: false };
    this.records.set(cur.epoch, cur);
    const b: Board = { id, cur, snap: {}, pvSinceMove: {}, sink: this };
    if (id > 1) {
      b.sink = {
        setSite: () => {}, // broadcast-wide: board 1 only
        setPlayers: (w, bl) => this.setPlayersOn(b, w, bl),
        emitInitialPosition: (f, fmr) => this.initialPositionOn(b, f, fmr),
        emitMove: (a) => this.moveOn(b, a),
        emitLevel: (t) => this.game(b, P.level(t)),
        emitClocks: (w, bl) => this.clocksOn(b, w, bl),
        emitPv: (c, d, sc, t, n, pv, info) => this.pvOn(b, c, d, sc, t, n, pv, info),
        emitResult: (r, n, pgn) => this.resultOn(b, r, n, pgn),
      };
    }
    return b;
  }

  // ---------------------------------------------------------------- outbound API

  setSite(site: string): void {
    this.site = site;
    this.sender.enqueue(null, { body: P.site(site) });
  }

  setPlayers(white: string, black: string): void {
    this.setPlayersOn(this.boards[0], white, black);
  }

  /** Initial board position (no move yet): FEN + FMR. */
  emitInitialPosition(fenTruncated: string, fmr: number): void {
    this.initialPositionOn(this.boards[0], fenTruncated, fmr);
  }

  /** A played move, in TLCS order: FEN (post-move), then MOVE, then FMR. */
  emitMove(args: { fenTruncated: string; color: ColorCode; fullMoveNumber: number; san: string; fmr: number }): void {
    this.moveOn(this.boards[0], args);
  }

  /** `level <text>` game-channel line (T05's time-control/level announcement). */
  emitLevel(text: string): void {
    this.game(this.boards[0], P.level(text));
  }

  emitClocks(whiteCs: number, blackCs: number): void {
    this.clocksOn(this.boards[0], whiteCs, blackCs);
  }

  /** Also a latest-only WINFO/BINFO from `info`; not attached to xMOVE, so a game replay carries none. */
  emitPv(color: ColorCode, depth: number, scoreCp: number, timeCs: number, nodes: number, pv: string[], info: UciInfo): void {
    this.pvOn(this.boards[0], color, depth, scoreCp, timeCs, nodes, pv, info);
  }

  /**
   * `gameNumber` (PGN authority only): after the result, queue a table capped at it per client.
   * `fromPgn`: it is the matched PGN entry's number, announced to TLCS-MG clients as `GAMENO`.
   */
  emitResult(result: string, gameNumber?: number, fromPgn?: boolean): void {
    this.resultOn(this.boards[0], result, gameNumber, fromPgn);
  }

  private setPlayersOn(b: Board, white: string, black: string): void {
    b.cur = { epoch: ++this.epochSeq, board: b.id, stream: [], finished: false };
    this.records.set(b.cur.epoch, b.cur);
    b.pvSinceMove = {};
    this.gcRecords();
    this.game(b, P.wplayer(white));
    this.game(b, P.bplayer(black));
  }

  private initialPositionOn(b: Board, fenTruncated: string, fmr: number): void {
    this.game(b, P.fen(fenTruncated));
    this.game(b, P.fmr(fmr));
  }

  private moveOn(b: Board, args: { fenTruncated: string; color: ColorCode; fullMoveNumber: number; san: string; fmr: number }): void {
    const pv = b.pvSinceMove[args.color];
    delete b.pvSinceMove[args.color];
    this.game(b, P.fen(args.fenTruncated));
    this.game(b, P.move(args.color, args.fullMoveNumber, args.san), false, pv);
    this.game(b, P.fmr(args.fmr));
  }

  private clocksOn(b: Board, whiteCs: number, blackCs: number): void {
    b.snap.whiteTimeCs = whiteCs;
    b.snap.blackTimeCs = blackCs;
    this.latest(b, P.time('w', whiteCs, blackCs), 'WTIME');
    this.latest(b, P.time('b', blackCs, whiteCs), 'BTIME');
  }

  private pvOn(b: Board, color: ColorCode, depth: number, scoreCp: number, timeCs: number, nodes: number, pv: string[], info: UciInfo): void {
    const msg = P.pv(color, depth, scoreCp, timeCs, nodes, pv);
    if (color === 'w') b.snap.lastWpv = msg;
    else b.snap.lastBpv = msg;
    b.pvSinceMove[color] = msg;
    this.latest(b, msg, color === 'w' ? 'WPV' : 'BPV');
    const infoMsg = P.info(color, info, pv);
    if (color === 'w') b.snap.lastWinfo = infoMsg;
    else b.snap.lastBinfo = infoMsg;
    this.latest(b, infoMsg, color === 'w' ? 'WINFO' : 'BINFO');
  }

  private resultOn(b: Board, result: string, gameNumber?: number, fromPgn?: boolean): void {
    if (fromPgn && gameNumber !== undefined) b.cur.gameNo = gameNumber;
    this.game(b, P.result(result), true);
    b.cur.finished = true;
    if (gameNumber !== undefined) this.results?.onResultEmitted?.(gameNumber);
  }

  /**
   * The one rule for who sees a game-channel item of `rec`'s board, and how: a TLCS-MG client
   * (`wrap`) gets it wrapped (latest keys per board, `GAMENO` ahead of a numbered result); a
   * single-game client gets board 1 bare and nothing else.
   */
  private present(wrap: boolean, rec: GameRecord, it: Outbound): Outbound[] {
    const epoch = it.latest ? undefined : rec.epoch;
    if (!wrap) return rec.board === 1 ? [{ body: it.body, epoch, board: rec.board, critical: it.critical, latest: it.latest }] : [];
    const out: Outbound = {
      body: P.board(rec.board, it.body),
      epoch,
      board: rec.board,
      critical: it.critical,
      latest: it.latest && `${it.latest}@${rec.board}`,
    };
    return it.critical && rec.gameNo !== undefined ? [{ body: P.board(rec.board, P.gameno(rec.gameNo)), epoch, board: rec.board }, out] : [out];
  }

  private latest(b: Board, body: string, key: string): void {
    for (const d of this.sender.clients()) {
      const [it] = this.present(this.multi.has(d), b.cur, { body, latest: key });
      if (it) this.sender.enqueue(d, it);
    }
  }

  /** Single path for every game-channel message: record it, then queue it for every client that sees the board. */
  private game(b: Board, body: string, critical = false, pv?: string): void {
    const item: StreamItem = { body, epoch: b.cur.epoch, board: b.id, critical: critical || undefined, pv };
    b.cur.stream.push(item);
    // GAMENO + result are queued as one unit, so a coalescing replay can never split them.
    for (const d of this.sender.clients()) this.sender.enqueueAll(d, this.present(this.multi.has(d), b.cur, item));
  }

  /** `BOARDS:` to one TLCS-MG client: never evicted, re-sent (current list) if given up. */
  private sendBoards(dest: string): void {
    this.enqueue(dest, P.boards(this.boards.map((b) => b.id)), {
      pinned: true,
      onGiveUp: (d) => setImmediate(() => this.multi.has(d) && this.sendBoards(d)),
    });
  }

  /** Keep every board's current game and every epoch some client's queue or in-flight slot still references. */
  private gcRecords(): void {
    const live = this.sender.referencedEpochs();
    for (const b of this.boards) live.add(b.cur.epoch);
    for (const e of this.records.keys()) if (!live.has(e)) this.records.delete(e);
  }

  /**
   * Replay of game `epoch`: SITE, then the stream verbatim through the first move's FMR
   * (players, setup sequence, level), then only the SANs (each preceded by the mover's
   * PV so node-tlcv does not label them "(Book)"), then the last FEN/FMR, then the result
   * iff `withResult`. Items are tagged with the epoch so the next splice replaces them.
   * For a TLCS-MG `dest` every game line is wrapped (SITE is not) and `GAMENO` precedes the result.
   */
  private replay(epoch: number, withResult: boolean, dest?: string): Outbound[] | null {
    const rec = this.records.get(epoch);
    if (!rec || rec.stream.length === 0) return null;
    const site = this.site;
    const wrap = dest !== undefined && this.multi.has(dest);
    if (!wrap && rec.board !== 1) return [];
    const key = `${site ?? ''}|${withResult}|${wrap}`;
    const cached = rec.finished ? rec.cache?.get(key) : undefined;
    if (cached) return cached;
    const st = rec.stream;
    const out: Outbound[] = [];
    if (site) out.push({ body: P.site(site), epoch, board: rec.board });
    const copied = new Set<StreamItem>();
    const copy = (it: StreamItem): void => {
      copied.add(it);
      if (it.pv) out.push(...this.present(wrap, rec, { body: it.pv }));
      out.push(...this.present(wrap, rec, it));
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
      if (res) copy(res);
    }
    if (rec.finished) (rec.cache ??= new Map()).set(key, out);
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
    if (msg.startsWith('LOGONv15')) {
      this.admin.forget(destKey(ip, port)); // any re-logon revokes admin
      // ...and the TLCS-MG opt-in (the client re-sends it). Queued wrapped game items are
      // re-encoded by the LOGON resync splice; wrapped latest items are simply dropped.
      if (this.multi.delete(destKey(ip, port))) this.sender.dropLatest(destKey(ip, port));
    }
    if (this.admin.handle(msg, ip, port)) return;
    if (this.commands.handle(msg, ip, port, numbered)) return;
    const dest = destKey(ip, port);
    if (msg === 'RESULTTABLE') {
      if (this.results) this.results.onResultTable(dest);
      else logger.debug(`RESULTTABLE from ${dest}: no result service`);
    } else if (msg === 'GAMELIST') {
      if (this.results) this.results.onGameList(dest);
      else logger.debug(`GAMELIST from ${dest}: no result service`);
    } else if (MULTIGAME_RE.test(msg)) {
      this.onMultigame(dest, Number(MULTIGAME_RE.exec(msg)![1]));
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

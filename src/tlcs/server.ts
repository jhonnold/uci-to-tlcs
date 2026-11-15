import { createSocket, type Socket, type RemoteInfo } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { logger } from '../util/logger.js';
import { metrics, sentType, receivedType } from '../metrics.js';
import { ReliableSender, type Outbound, type SenderOptions } from './reliable-sender.js';
import { InboundDeduper, parseAck, parseNumbered } from './inbound.js';
import { SessionCommands, redactSecrets } from './commands.js';
import { AdminCommands, RATE_DEFAULT, type RateLimit } from './admin.js';
import * as P from './protocol.js';
import type { ColorCode, Position } from './protocol.js';
import { STARTPOS_TRUNC } from '../game/game-state.js';
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
  /** FENSETUPMOVE: position steps end with the `(setup)` move that makes a loaded node-tlcv reload (default true). */
  fenSetupMove?: boolean;
  /** ADMINPASS: admin commands (SECURITY/BOOT/SRBOOT) are disabled unless non-empty. */
  adminPass?: string;
  /** MAXCLIENTS: refuse new LOGONs beyond this many clients (0 = unlimited). */
  maxClients?: number;
  /** BANNED=: source IPs whose datagrams are dropped silently. */
  bannedIps?: string[];
  /** Per-source-IP datagram budget (ACKs are free). */
  rateLimit?: RateLimit;
  /** Every accepted LOGON, right before the resync snapshot. */
  onLogon?: (dest: string) => void;
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

/** Latest-value fields of one board that feed a resync's clocks/PV. */
interface Snapshot {
  whiteTimeCs?: number;
  blackTimeCs?: number;
  lastWpv?: string;
  lastBpv?: string;
  lastWinfo?: string;
  lastBinfo?: string;
}

/** What a join snapshot needs of a board's current game (no history is kept). */
interface CurrentGame {
  white?: string;
  black?: string;
  level?: string;
  /** Where the move steps sent so far leave the board. */
  pos?: Position;
  finished: boolean;
  /** PGN game number of the result (TLCS-MG `GAMENO`, sent with the result to wrapped clients only). */
  gameNo?: number;
}

/** One board: a slot showing one game after another (TLCS-MG). Board 1 is the single-game stream. */
interface Board {
  id: number;
  cur: CurrentGame;
  snap: Snapshot;
  /** The board's BroadcastSink (board 1: the server itself). */
  sink: BroadcastSink;
}

/** A game-channel line before it is presented to a client. */
interface GameLine {
  body: string;
  step?: Position;
  latest?: string;
  result?: boolean;
}

const MULTIGAME_RE = /^MULTIGAME:\s*(\d+)\s*$/;

/**
 * The UDP broadcast server node-tlcv connects to. Owns the socket, the client
 * registry, the per-client delivery channel and, per board, just enough of the current
 * game for a join snapshot (players, level, position, clocks, PV). The pipeline calls the
 * `emit*` / `set*` methods.
 */
export class TlcsServer {
  private socket: Socket;
  /** Keyed by the client's `ip:port` "dest" token, so two clients on one host differ. */
  private clients = new Map<string, ClientInfo>();
  private sender: ReliableSender;
  private results?: { onResultTable(dest: string): void; onGameList(dest: string): void; onResultEmitted?(n: number): void };
  private site?: string;
  /** boards[i] is board i+1; board 1 always exists. */
  private boards: Board[] = [];
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
        positionSteps: (d, id, pos) => this.positionSteps(this.multi.has(d), this.boards[id - 1], pos),
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
    return isNew;
  }

  removeClient(dest: string): ClientInfo | undefined {
    const c = this.clients.get(dest);
    this.clients.delete(dest);
    this.multi.delete(dest);
    this.admin.forget(dest);
    this.sender.removeClient(dest);
    return c;
  }

  getClient(dest: string): Readonly<ClientInfo> | undefined {
    return this.clients.get(dest);
  }

  clientList(): Array<{ dest: string } & Readonly<ClientInfo>> {
    return Array.from(this.clients, ([dest, c]) => ({ dest, ...c }));
  }

  /**
   * Replace `dest`'s queued game lines by a snapshot of every board it sees: SITE, then per
   * board with an unfinished game its players, position steps and level, then clocks and
   * last PV as latest items. No move history: a client that joins mid-game starts there.
   * Never clears control items or the in-flight item.
   */
  resync(dest: string): void {
    const wrap = this.multi.has(dest);
    const out: Outbound[] = [];
    if (this.site) out.push({ body: P.site(this.site) });
    for (const b of wrap ? this.boards : [this.boards[0]]) {
      const show = (l: GameLine) => out.push(...this.present(wrap, b, l));
      const g = b.cur;
      if (g.finished) continue;
      if (g.white !== undefined) show({ body: P.wplayer(g.white) });
      if (g.black !== undefined) show({ body: P.bplayer(g.black) });
      if (g.pos) out.push(...this.positionSteps(wrap, b, g.pos));
      if (g.level !== undefined) show({ body: P.level(g.level) });
      const s = b.snap;
      if (s.whiteTimeCs !== undefined && s.blackTimeCs !== undefined) {
        show({ body: P.time('w', s.whiteTimeCs, s.blackTimeCs), latest: 'WTIME' });
        show({ body: P.time('b', s.blackTimeCs, s.whiteTimeCs), latest: 'BTIME' });
      }
      if (s.lastWpv) show({ body: s.lastWpv, latest: 'WPV' });
      if (s.lastBpv) show({ body: s.lastBpv, latest: 'BPV' });
      if (s.lastWinfo) show({ body: s.lastWinfo, latest: 'WINFO' });
      if (s.lastBinfo) show({ body: s.lastBinfo, latest: 'BINFO' });
    }
    this.sender.resync(dest, out);
  }

  /**
   * The lines that put a client's view of board `b` straight onto `pos`: the non-startpos
   * new-game sequence of the pipeline (startpos `FEN` resets a loaded node-tlcv, the
   * `(setup)` move fails in chess.js so its catch loads the `FEN` just sent with the right
   * `FMR` and move number). The start position, or FENSETUPMOVE off, is just `FEN`/`FMR`
   * (then a loaded node-tlcv keeps its old board until a later move fails to apply).
   */
  private positionSteps(wrap: boolean, b: Board, pos: Position): Outbound[] {
    const bodies =
      pos.fen === STARTPOS_TRUNC || this.opts.fenSetupMove === false
        ? [P.fen(pos.fen), P.fmr(pos.fmr)]
        : [
            P.fen(STARTPOS_TRUNC),
            P.fmr(0),
            P.fen(pos.fen),
            P.fmr(pos.fmr),
            P.fen(pos.fen),
            P.move(pos.fen.split(' ')[1] === 'b' ? 'b' : 'w', pos.fullmove, P.SETUP_SAN),
            P.fmr(pos.fmr),
          ];
    return bodies.flatMap((body) => this.present(wrap, b, { body, step: pos }));
  }

  queueDepth(dest: string): number {
    return this.sender.depth(dest);
  }

  rttStats(dest: string): { srtt: number; rttvar: number; rto: number } | null {
    return this.sender.rttStats(dest);
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
    // Queued game lines are bare (the previous mode): the resync replaces them by wrapped
    // snapshots queued after the reply, so the reply precedes every wrapped line.
    this.multi.add(dest);
    logger.info(`MULTIGAME ${dest}: ${this.boards.length} board(s)`);
    this.enqueue(dest, P.multigame(P.MULTIGAME_VERSION));
    this.sendBoards(dest);
    this.resync(dest);
  }

  private newBoard(id: number): Board {
    const b: Board = { id, cur: { finished: false }, snap: {}, sink: this };
    if (id > 1) {
      b.sink = {
        setSite: () => {}, // broadcast-wide: board 1 only
        setPlayers: (w, bl) => this.setPlayersOn(b, w, bl),
        emitInitialPosition: (f, fmr) => this.initialPositionOn(b, f, fmr),
        emitMove: (a) => this.moveOn(b, a),
        emitLevel: (t) => this.levelOn(b, t),
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
    this.levelOn(this.boards[0], text);
  }

  emitClocks(whiteCs: number, blackCs: number): void {
    this.clocksOn(this.boards[0], whiteCs, blackCs);
  }

  /** Also a latest-only WINFO/BINFO from `info`. */
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
    b.cur = { white, black, finished: false };
    this.game(b, { body: P.wplayer(white) });
    this.game(b, { body: P.bplayer(black) });
  }

  private initialPositionOn(b: Board, fenTruncated: string, fmr: number): void {
    const pos: Position = { fen: fenTruncated, fmr, fullmove: 1 };
    b.cur.pos = pos;
    this.game(b, { body: P.fen(fenTruncated), step: pos });
    this.game(b, { body: P.fmr(fmr), step: pos });
  }

  private moveOn(b: Board, args: { fenTruncated: string; color: ColorCode; fullMoveNumber: number; san: string; fmr: number }): void {
    // The setup move carries the side to move and the current fullmove number; a real move its mover's.
    const fullmove = args.san === P.SETUP_SAN || args.color === 'w' ? args.fullMoveNumber : args.fullMoveNumber + 1;
    const pos: Position = { fen: args.fenTruncated, fmr: args.fmr, fullmove };
    b.cur.pos = pos;
    this.game(b, { body: P.fen(args.fenTruncated), step: pos });
    this.game(b, { body: P.move(args.color, args.fullMoveNumber, args.san), step: pos });
    this.game(b, { body: P.fmr(args.fmr), step: pos });
  }

  private levelOn(b: Board, text: string): void {
    b.cur.level = text;
    this.game(b, { body: P.level(text) });
  }

  private clocksOn(b: Board, whiteCs: number, blackCs: number): void {
    b.snap.whiteTimeCs = whiteCs;
    b.snap.blackTimeCs = blackCs;
    this.game(b, { body: P.time('w', whiteCs, blackCs), latest: 'WTIME' });
    this.game(b, { body: P.time('b', blackCs, whiteCs), latest: 'BTIME' });
  }

  private pvOn(b: Board, color: ColorCode, depth: number, scoreCp: number, timeCs: number, nodes: number, pv: string[], info: UciInfo): void {
    const msg = P.pv(color, depth, scoreCp, timeCs, nodes, pv);
    if (color === 'w') b.snap.lastWpv = msg;
    else b.snap.lastBpv = msg;
    this.game(b, { body: msg, latest: color === 'w' ? 'WPV' : 'BPV' });
    const infoMsg = P.info(color, info, pv);
    if (color === 'w') b.snap.lastWinfo = infoMsg;
    else b.snap.lastBinfo = infoMsg;
    this.game(b, { body: infoMsg, latest: color === 'w' ? 'WINFO' : 'BINFO' });
  }

  private resultOn(b: Board, result: string, gameNumber?: number, fromPgn?: boolean): void {
    if (fromPgn && gameNumber !== undefined) b.cur.gameNo = gameNumber;
    this.game(b, { body: P.result(result), result: true });
    b.cur.finished = true;
    if (gameNumber !== undefined) this.results?.onResultEmitted?.(gameNumber);
  }

  /**
   * The one rule for who sees a game-channel line of board `b`, and how: a TLCS-MG client
   * (`wrap`) gets it wrapped (latest keys per board, `GAMENO` ahead of the result); a
   * single-game client gets board 1 bare and nothing else.
   */
  private present(wrap: boolean, b: Board, l: GameLine): Outbound[] {
    if (!wrap) return b.id === 1 ? [{ body: l.body, board: 1, step: l.step, latest: l.latest }] : [];
    const out: Outbound = { body: P.board(b.id, l.body), board: b.id, step: l.step, latest: l.latest && `${l.latest}@${b.id}` };
    return l.result && b.cur.gameNo !== undefined ? [{ body: P.board(b.id, P.gameno(b.cur.gameNo)), board: b.id }, out] : [out];
  }

  /** Single path for every game-channel line: queue it for every client that sees the board. */
  private game(b: Board, l: GameLine): void {
    for (const d of this.sender.clients()) for (const it of this.present(this.multi.has(d), b, l)) this.sender.enqueue(d, it);
  }

  /** `BOARDS:` to one TLCS-MG client: never evicted, re-sent (current list) if given up. */
  private sendBoards(dest: string): void {
    this.enqueue(dest, P.boards(this.boards.map((b) => b.id)), {
      pinned: true,
      onGiveUp: (d) => setImmediate(() => this.multi.has(d) && this.sendBoards(d)),
    });
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
      // ...and the TLCS-MG opt-in (the client re-sends it). Its queued wrapped lines are
      // replaced by the LOGON resync's bare snapshot.
      this.multi.delete(destKey(ip, port));
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

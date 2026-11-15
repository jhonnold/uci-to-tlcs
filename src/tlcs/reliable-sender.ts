import { logger } from '../util/logger.js';
import { metrics } from '../metrics.js';
import { frame, type Position } from './protocol.js';

/** One message for a client. */
export interface Outbound {
  body: string;
  /** Set => game item of this board (a resync replaces it); unset => control item. */
  board?: number;
  /** Game items: a move step (`FEN`/`xMOVE`/`FMR`) that leaves the board at this position (droppable when stale). */
  step?: Position;
  /** 'WPV'|'BPV'|'WINFO'|'BINFO'|'WTIME'|'BTIME': unnumbered, latest-only per key, never retransmitted. */
  latest?: string;
  /** Control items only: called when the item is given up or evicted. */
  onGiveUp?: (dest: string) => void;
  /** Control items only: after this item's ACK, send nothing numbered to this client for holdMs. */
  holdMs?: number;
  /** Control items only: never evicted by the hard cap (TLCS-MG `BOARDS:` must precede its boards' lines). */
  pinned?: boolean;
}

export interface SenderHooks {
  rawSend(payload: string, dest: string): void;
  /**
   * The lines that put `dest`'s view of `board` straight onto `pos` (forcing a reload on a client
   * whose board is already loaded); they replace a stale run of move steps.
   */
  positionSteps?(dest: string, board: number, pos: Position): Outbound[];
}

export interface SenderOptions {
  initialRtoMs: number;
  minRtoMs: number;
  maxRtoMs: number;
  backoffFactor: number;
  giveUpMs: number;
  maxQueue: number;
  hardCap: number;
}

export const DEFAULT_SENDER_OPTIONS: SenderOptions = {
  initialRtoMs: 500,
  minRtoMs: 50,
  maxRtoMs: 2000,
  backoffFactor: 2,
  giveUpMs: 5_000,
  maxQueue: 256,
  hardCap: 1024,
};

interface InFlight {
  id: number;
  item: Outbound;
  sends: number;
  firstSentAt: number;
  lastSentAt: number;
  timerMs: number;
}

interface ClientState {
  queue: Outbound[];
  inFlight: InFlight | null;
  timer: NodeJS.Timeout | null;
  /** Post-ACK quiet period (Outbound.holdMs): nothing numbered or raw-`latest` is sent while set. */
  hold: NodeJS.Timeout | null;
  srtt?: number;
  rttvar?: number;
  rto: number;
  samples: number;
}

const now = (): number => performance.now();

/**
 * Per-client ordered delivery for the `<N>body` channel, best effort.
 *
 * node-tlcv drops any id <= its high-water mark, so each client is strict
 * stop-and-wait: one numbered message in flight, the next id assigned only after
 * the ACK (a window could land a resend behind a newer id). Ids are per client,
 * strictly increasing and never reset while the process lives. A slow client never
 * stalls another. The RTO is adaptive (RFC 6298 / Karn). A line still unACKed after
 * giveUpMs is dropped, whatever it is (a client's board recovers from the next move's
 * FEN); a client that falls behind loses its stale move steps (see dropStale).
 */
export class ReliableSender {
  private clientsMap = new Map<string, ClientState>();
  private lastId = new Map<string, number>();
  private readonly opts: SenderOptions;

  constructor(
    private readonly hooks: SenderHooks,
    opts: Partial<SenderOptions> = {},
  ) {
    this.opts = { ...DEFAULT_SENDER_OPTIONS, ...opts };
  }

  addClient(dest: string): void {
    if (this.clientsMap.has(dest)) return;
    this.clientsMap.set(dest, {
      queue: [],
      inFlight: null,
      timer: null,
      hold: null,
      rto: this.opts.initialRtoMs,
      samples: 0,
    });
  }

  /** Frees the client's queue; its id counter survives so a re-LOGON continues. */
  removeClient(dest: string): void {
    const c = this.clientsMap.get(dest);
    if (!c) return;
    this.logRtt(dest, c);
    if (c.timer) clearTimeout(c.timer);
    if (c.hold) clearTimeout(c.hold);
    this.clientsMap.delete(dest);
  }

  has(dest: string): boolean {
    return this.clientsMap.has(dest);
  }

  clients(): string[] {
    return Array.from(this.clientsMap.keys());
  }

  /** Queued items plus one when a numbered item is in flight. */
  depth(dest: string): number {
    const c = this.clientsMap.get(dest);
    return c ? c.queue.length + (c.inFlight ? 1 : 0) : 0;
  }

  rttStats(dest: string): { srtt: number; rttvar: number; rto: number } | null {
    const c = this.clientsMap.get(dest);
    if (!c || c.srtt === undefined) return null;
    return { srtt: c.srtt, rttvar: c.rttvar!, rto: c.rto };
  }

  /** Queue `item` for `dest`, or for every registered client when `dest` is null. */
  enqueue(dest: string | null, item: Outbound): void {
    const targets = dest === null ? this.clients() : [dest];
    for (const d of targets) {
      const c = this.clientsMap.get(d);
      if (!c) {
        logger.debug(`enqueue for unknown client ${d} dropped: ${item.body}`);
        continue;
      }
      if (item.latest) {
        if (!c.inFlight && !c.hold && c.queue.length === 0) {
          this.hooks.rawSend(item.body, d);
          continue;
        }
        // Replace a queued same-key item only inside the trailing run of latest items: an
        // older PV/clock queued before a numbered item belongs before it, so moving it
        // behind that item would mislabel the move (node-tlcv "(Book)", no eval).
        for (let i = c.queue.length - 1; i >= 0 && c.queue[i].latest; i--) {
          if (c.queue[i].latest === item.latest) {
            c.queue.splice(i, 1);
            break;
          }
        }
        c.queue.push(item);
        this.maybeDropStale(d, c);
        continue;
      }
      this.pushNumbered(d, c, [item]);
    }
  }

  private pushNumbered(dest: string, c: ClientState, items: Outbound[]): void {
    c.queue.push(...items);
    this.maybeDropStale(dest, c);
    this.enforceHardCap(dest, c);
    this.pump(dest, c);
  }

  ack(dest: string, id: number): void {
    const c = this.clientsMap.get(dest);
    const f = c?.inFlight;
    if (!c || !f || f.id !== id) return;
    const t = now();
    if (f.sends === 1) {
      this.sample(c, t - f.lastSentAt);
    } else {
      // Karn: the sample is ambiguous, so srtt is untouched. But if the RTT has stepped
      // above the RTO every item would retransmit forever and the estimator would never
      // learn; lift the RTO towards what this item actually took. At most x2 per ambiguous
      // ACK: under random loss the elapsed time includes the backoff waits, and adopting it
      // outright feeds back (a long RTO makes the next item's loss cost even longer). The
      // next clean sample recomputes the RTO from srtt.
      const base = c.srtt !== undefined ? this.rtoFromEstimate(c) : c.rto;
      c.rto = this.clampRto(Math.min(Math.max(base, t - f.firstSentAt), 2 * c.rto));
    }
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.inFlight = null;
    if (f.item.holdMs) {
      c.hold = setTimeout(() => {
        c.hold = null;
        this.pump(dest, c);
      }, f.item.holdMs);
      return;
    }
    this.pump(dest, c);
  }

  /**
   * Replace `dest`'s queued game lines and latest items (the in-flight item and control
   * items stay) by `items`, a fresh snapshot of what it should see (LOGON, opt-in).
   */
  resync(dest: string, items: Outbound[]): void {
    const c = this.clientsMap.get(dest);
    if (!c) return;
    const before = c.queue.length;
    c.queue = c.queue.filter((it) => it.board === undefined && !it.latest);
    metrics.inc('tlcs_resyncs_total', { kind: 'full' });
    logger.info(`resync ${dest}: dropped ${before - c.queue.length} queued game line(s), queued ${items.length}`);
    for (const it of items) this.enqueue(dest, it);
    this.pump(dest, c);
  }

  close(): void {
    for (const c of this.clientsMap.values()) {
      if (c.timer) clearTimeout(c.timer);
      if (c.hold) clearTimeout(c.hold);
    }
    this.clientsMap.clear();
  }

  // ------------------------------------------------------------------ internals

  private clampRto(v: number): number {
    return Math.min(this.opts.maxRtoMs, Math.max(this.opts.minRtoMs, v));
  }

  private rtoFromEstimate(c: ClientState): number {
    return this.clampRto(c.srtt! + Math.max(1, 4 * c.rttvar!));
  }

  private sample(c: ClientState, r: number): void {
    if (c.srtt === undefined) {
      c.srtt = r;
      c.rttvar = r / 2;
    } else {
      c.rttvar = 0.75 * c.rttvar! + 0.25 * Math.abs(c.srtt - r);
      c.srtt = 0.875 * c.srtt + 0.125 * r;
    }
    c.rto = this.rtoFromEstimate(c);
    c.samples++;
  }

  private logRtt(dest: string, c: ClientState): void {
    if (c.srtt === undefined) return;
    logger.debug(
      `rtt ${dest} srtt=${c.srtt.toFixed(2)} rttvar=${c.rttvar!.toFixed(2)} rto=${c.rto.toFixed(2)} samples=${c.samples}`,
    );
  }

  private pump(dest: string, c: ClientState): void {
    if (c.hold) return;
    while (!c.inFlight && c.queue.length > 0) {
      const item = c.queue.shift()!;
      if (item.latest) {
        this.hooks.rawSend(item.body, dest);
        continue;
      }
      const id = (this.lastId.get(dest) ?? 0) + 1;
      this.lastId.set(dest, id);
      const t = now();
      c.inFlight = { id, item, sends: 1, firstSentAt: t, lastSentAt: t, timerMs: c.rto };
      this.hooks.rawSend(frame(id, item.body), dest);
      this.arm(dest, c);
      return;
    }
  }

  private arm(dest: string, c: ClientState): void {
    if (c.timer) clearTimeout(c.timer);
    c.timer = setTimeout(() => this.onTimeout(dest), c.inFlight!.timerMs);
  }

  private onTimeout(dest: string): void {
    const c = this.clientsMap.get(dest);
    const s = c?.inFlight;
    if (!c || !s) return;
    const t = now();
    if (t - s.firstSentAt >= this.opts.giveUpMs) {
      this.giveUp(dest, c);
      return;
    }

    s.timerMs = Math.min(s.timerMs * this.opts.backoffFactor, this.opts.maxRtoMs);
    s.sends++;
    s.lastSentAt = t;
    this.hooks.rawSend(frame(s.id, s.item.body), dest);
    this.arm(dest, c);
    metrics.inc('tlcs_retransmits_total');
    logger.debug(`retransmit ${s.id} -> ${dest} (send ${s.sends}, rto ${s.timerMs})`);
  }

  /** Drop the in-flight item, whatever it is, and move on. */
  private giveUp(dest: string, c: ClientState): void {
    const s = c.inFlight!;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.inFlight = null;
    const secs = ((now() - s.firstSentAt) / 1000).toFixed(1);
    const kind = s.item.board === undefined ? 'control' : 'game';
    metrics.inc('tlcs_giveups_total', { kind });
    metrics.inc('tlcs_dropped_total', { reason: 'giveup' });
    logger.warn(`give-up ${s.id} -> ${dest} after ${secs}s (${kind}, dropped): ${s.item.body}`);
    s.item.onGiveUp?.(dest);
    this.pump(dest, c);
  }

  /** Only queued game lines (moves, players, PV/clock) measure how far behind a client is; a crosstable dump does not. */
  private maybeDropStale(dest: string, c: ClientState): void {
    if (c.queue.length <= this.opts.maxQueue) return;
    if (c.queue.filter((it) => it.board !== undefined).length > this.opts.maxQueue) this.dropStale(dest, c);
  }

  /**
   * A client that fell behind (more than maxQueue game lines queued): per board and game (a run
   * of the board's move steps and PV/clock lines between its other game lines, such as
   * `result`/`WPLAYER`), the move steps and the PV/clock lines before the newest step are stale.
   * They go, and the position steps of that newest step take its place, when they are fewer than
   * what they replace. Each game thus ends on its real final position ahead of its result.
   * Players, level, GAMENO, result, later PV/clock and control lines are kept, in order.
   */
  private dropStale(dest: string, c: ClientState): void {
    if (!this.hooks.positionSteps) return;
    interface Seg { board: number; members: number[]; newest: number }
    const open = new Map<number, Seg>();
    const segs: Seg[] = [];
    const close = (board: number) => {
      const g = open.get(board);
      if (g && g.newest >= 0) segs.push(g);
      open.delete(board);
    };
    c.queue.forEach((it, i) => {
      if (it.board === undefined) return;
      if (!it.step && !it.latest) return close(it.board);
      const g = open.get(it.board) ?? { board: it.board, members: [], newest: -1 };
      open.set(it.board, g);
      g.members.push(i);
      if (it.step) g.newest = i;
    });
    for (const b of [...open.keys()]) close(b);
    const drop = new Set<number>();
    const insert = new Map<number, Outbound[]>();
    const boards = new Set<number>();
    for (const g of segs) {
      const stale = g.members.filter((i) => i <= g.newest);
      const r = this.hooks.positionSteps(dest, g.board, c.queue[g.newest].step!);
      if (r.length >= stale.length) continue;
      for (const i of stale) drop.add(i);
      insert.set(g.newest, r);
      boards.add(g.board);
    }
    if (drop.size === 0) return;
    const out: Outbound[] = [];
    c.queue.forEach((it, i) => {
      if (!drop.has(i)) out.push(it);
      else if (insert.has(i)) out.push(...insert.get(i)!);
    });
    c.queue = out;
    metrics.inc('tlcs_dropped_total', { reason: 'stale' }, drop.size);
    logger.info(`stale: ${dest} dropped ${drop.size} queued game line(s) on board(s) ${[...boards].join(',')}`);
  }

  private enforceHardCap(dest: string, c: ClientState): void {
    while (c.queue.length > this.opts.hardCap) {
      const i = c.queue.findIndex((it) => !it.latest && it.board === undefined && !it.pinned);
      if (i < 0) return;
      const [it] = c.queue.splice(i, 1);
      logger.warn(`hard cap: evicted control item for ${dest}: ${it.body}`);
      it.onGiveUp?.(dest);
    }
  }
}

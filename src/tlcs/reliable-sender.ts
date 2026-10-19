import { logger } from '../util/logger.js';
import { frame } from './protocol.js';

/** One message for a client. */
export interface Outbound {
  body: string;
  /** Set => game item (replayable / coalescable); unset => control item. */
  epoch?: number;
  /** A `result`: retried until stallMs, never replayed on its own. */
  critical?: boolean;
  /** 'WPV'|'BPV'|'WTIME'|'BTIME': unnumbered, latest-only per key, never retransmitted. */
  latest?: string;
  /** Control items only: called when the item is given up or evicted. */
  onGiveUp?: (dest: string) => void;
}

export interface SenderHooks {
  rawSend(payload: string, dest: string): void;
  /** Full replay of game `epoch` (result included iff withResult), or null if no record. */
  replay(epoch: number, withResult: boolean): Outbound[] | null;
  /** Called once per stall episode (no ACK progress for stallMs while busy). */
  onStalled?(dest: string): void;
}

export interface SenderOptions {
  initialRtoMs: number;
  minRtoMs: number;
  maxRtoMs: number;
  backoffFactor: number;
  giveUpMs: number;
  stallMs: number;
  maxQueue: number;
  hardCap: number;
}

export const DEFAULT_SENDER_OPTIONS: SenderOptions = {
  initialRtoMs: 500,
  minRtoMs: 50,
  maxRtoMs: 2000,
  backoffFactor: 2,
  giveUpMs: 30_000,
  stallMs: 60_000,
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
  srtt?: number;
  rttvar?: number;
  rto: number;
  samples: number;
  lastProgressAt: number;
  /** When the client last went from idle to busy (stall is measured from here at the earliest). */
  busySince: number;
  stalled: boolean;
  coalesceLogged: Set<number>;
}

const now = (): number => performance.now();

/**
 * Per-client ordered reliable delivery for the `<N>body` channel.
 *
 * node-tlcv drops any id <= its high-water mark, so each client is strict
 * stop-and-wait: one numbered message in flight, the next id assigned only after
 * the ACK (a window could land a resend behind a newer id). Ids are per client,
 * strictly increasing and never reset while the process lives. A slow client never
 * stalls another. The RTO is adaptive (RFC 6298 / Karn) so a lossy-but-alive client
 * keeps up; nothing is dropped for a client that is merely behind (see dropStalled).
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
    const t = now();
    this.clientsMap.set(dest, {
      queue: [],
      inFlight: null,
      timer: null,
      rto: this.opts.initialRtoMs,
      samples: 0,
      lastProgressAt: t,
      busySince: t,
      stalled: false,
      coalesceLogged: new Set(),
    });
  }

  /** Frees the client's queue; its id counter survives so a re-LOGON continues. */
  removeClient(dest: string): void {
    const c = this.clientsMap.get(dest);
    if (!c) return;
    this.logRtt(dest, c);
    if (c.timer) clearTimeout(c.timer);
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

  /** Epochs of all queued and in-flight game items across all clients. */
  referencedEpochs(): Set<number> {
    const out = new Set<number>();
    for (const c of this.clientsMap.values()) {
      if (c.inFlight?.item.epoch !== undefined) out.add(c.inFlight.item.epoch);
      for (const it of c.queue) if (it.epoch !== undefined) out.add(it.epoch);
    }
    return out;
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
        if (!c.inFlight && c.queue.length === 0) {
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
        continue;
      }
      if (!c.inFlight && c.queue.length === 0) c.busySince = now();
      c.queue.push(item);
      if (item.epoch !== undefined) {
        if (c.stalled) this.dropStalled(d, c);
        this.maybeCoalesce(d, c);
      }
      this.enforceHardCap(d, c);
      this.pump(d, c);
    }
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
    c.lastProgressAt = t;
    if (c.stalled) {
      c.stalled = false;
      logger.info(`unstalled ${dest}`);
    }
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.inFlight = null;
    this.pump(dest, c);
  }

  /**
   * Re-send the current game from scratch to `dest`: every queued epoch is replaced by
   * its replay (so nothing is duplicated), plus the current game's replay when nothing of
   * it is queued and it is unfinished. The in-flight item is untouched (a result in flight
   * keeps its id).
   */
  resync(dest: string, curEpoch: number, curFinished: boolean): void {
    const c = this.clientsMap.get(dest);
    if (!c) return;
    const epochs = this.queuedEpochs(c);
    for (const e of epochs) this.splice(dest, c, e);
    let note = `epochs [${epochs.join(',')}]`;
    if (!epochs.includes(curEpoch)) {
      if (curFinished) {
        note += ' (cur finished, skipped)';
      } else {
        const r = this.hooks.replay(curEpoch, false);
        if (r) {
          if (!c.inFlight && c.queue.length === 0) c.busySince = now();
          c.queue.push(...r);
          note += ' (+cur)';
        }
      }
    }
    logger.info(`resync ${dest}: ${note}`);
    this.pump(dest, c);
  }

  close(): void {
    for (const c of this.clientsMap.values()) if (c.timer) clearTimeout(c.timer);
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

    // Stall: no ACK progress for stallMs. Measured from when the client became busy at
    // the earliest, so a client that was merely idle is not "stalled" by one lost copy.
    if (!c.stalled && t - Math.max(c.lastProgressAt, c.busySince) >= this.opts.stallMs) {
      c.stalled = true;
      this.dropStalled(dest, c, true);
      this.hooks.onStalled?.(dest);
    }

    const limit = s.item.critical ? this.opts.stallMs : this.opts.giveUpMs;
    if (t - s.firstSentAt >= limit) {
      this.giveUp(dest, c);
      return;
    }

    s.timerMs = Math.min(s.timerMs * this.opts.backoffFactor, this.opts.maxRtoMs);
    s.sends++;
    s.lastSentAt = t;
    this.hooks.rawSend(frame(s.id, s.item.body), dest);
    this.arm(dest, c);
    logger.debug(`retransmit ${s.id} -> ${dest} (send ${s.sends}, rto ${s.timerMs})`);
  }

  private giveUp(dest: string, c: ClientState): void {
    const s = c.inFlight!;
    if (c.timer) clearTimeout(c.timer);
    c.timer = null;
    c.inFlight = null;
    const secs = ((now() - s.firstSentAt) / 1000).toFixed(1);
    if (s.item.critical) {
      // No replay: delivery is ambiguous and a second save in node-tlcv is possible.
      logger.error(`give-up critical ${s.id} -> ${dest} after ${secs}s (dropped): ${s.item.body}`);
    } else if (s.item.epoch === undefined) {
      logger.warn(`give-up ${s.id} -> ${dest} (control, dropped): ${s.item.body}`);
      s.item.onGiveUp?.(dest);
    } else {
      const n = this.splice(dest, c, s.item.epoch);
      logger.warn(`give-up ${s.id} -> ${dest} after ${secs}s; resync game ${s.item.epoch} (${n} msgs)`);
    }
    this.pump(dest, c);
  }

  private queuedEpochs(c: ClientState): number[] {
    const set = new Set<number>();
    for (const it of c.queue) if (!it.latest && it.epoch !== undefined) set.add(it.epoch);
    return Array.from(set).sort((a, b) => a - b);
  }

  /** Replace epoch `e`'s queued items by its replay (at the first removed index, else the head). */
  private splice(dest: string, c: ClientState, e: number, replayed?: Outbound[] | null): number {
    let at = -1;
    let kept = 0;
    let withResult = false;
    c.queue = c.queue.filter((it) => {
      if (it.latest || it.epoch !== e) {
        kept++;
        return true;
      }
      if (at < 0) at = kept;
      if (it.critical) withResult = true;
      return false;
    });
    const r = replayed ?? this.hooks.replay(e, withResult);
    if (!r) {
      logger.error(`give-up/coalesce ${dest}: no record for game ${e}`);
      return 0;
    }
    c.queue.splice(at < 0 ? 0 : at, 0, ...r);
    return r.length;
  }

  // Cost note (T10/T12): once over maxQueue, every game enqueue re-measures each queued
  // epoch's replay; an unfinished `cur` is not cached, so that is O(stream) per enqueue.
  private maybeCoalesce(dest: string, c: ClientState): void {
    if (c.queue.length <= this.opts.maxQueue) return;
    for (const e of this.queuedEpochs(c)) {
      let n = 0;
      let hasCritical = false;
      for (const it of c.queue) {
        if (it.latest || it.epoch !== e) continue;
        n++;
        if (it.critical) hasCritical = true;
      }
      const r = this.hooks.replay(e, hasCritical);
      if (!r || r.length >= n) continue;
      this.splice(dest, c, e, r); // same withResult as hasCritical, so r is reusable
      const msg = `coalesced ${dest} game ${e}: ${n} -> ${r.length}`;
      if (c.coalesceLogged.has(e)) logger.debug(msg);
      else {
        c.coalesceLogged.add(e);
        logger.info(msg);
      }
    }
  }

  private enforceHardCap(dest: string, c: ClientState): void {
    while (c.queue.length > this.opts.hardCap) {
      const i = c.queue.findIndex((it) => !it.latest && it.epoch === undefined);
      if (i < 0) return;
      const [it] = c.queue.splice(i, 1);
      logger.warn(`hard cap: evicted control item for ${dest}: ${it.body}`);
      it.onGiveUp?.(dest);
    }
  }

  /**
   * The ONLY path that discards game data: keep just the newest queued epoch. Runs when a
   * stall episode starts (`announce`) and again for each new epoch queued while stalled.
   */
  // Note: a give-up of an in-flight item from an epoch dropped here re-inserts that epoch's
  // replay at the head; the next new-epoch enqueue drops it again (harmless, bounded churn).
  private dropStalled(dest: string, c: ClientState, announce = false): void {
    const epochs = this.queuedEpochs(c);
    let dropped = 0;
    let lostResults = 0;
    if (epochs.length > 1) {
      const newest = epochs[epochs.length - 1];
      c.queue = c.queue.filter((it) => {
        if (it.latest || it.epoch === undefined || it.epoch >= newest) return true;
        dropped++;
        if (it.critical) lostResults++;
        return false;
      });
    }
    if (announce || dropped > 0) {
      logger.error(
        `stalled ${dest}: no ACK progress for ${(this.opts.stallMs / 1000).toFixed(0)}s; ` +
          `dropped ${dropped} msgs of games [${epochs.slice(0, -1).join(',')}] (${lostResults} results lost)`,
      );
    }
    this.maybeCoalesce(dest, c);
  }
}

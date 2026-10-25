import type { BroadcastSink } from './pipeline.js';
import type { ColorCode } from './tlcs/protocol.js';
import type { UciInfo } from './uci/info.js';
import { logger } from './util/logger.js';

export interface PacingOptions {
  delayAfterMoveMs: number;
  delayAfterGameMs: number;
}

const BACKLOG_WARN = 1000;

interface Job {
  fn: () => void;
  holdMs: number;
}

/**
 * Reference-style DELAYAFTERMOVE / DELAYAFTERGAME pacing: after a move (or result) is sent,
 * everything behind it waits. Applies to every `emitMove`, including the synthetic setup
 * move and replayed book moves. Pacing starts only once the tailer has caught up to EOF
 * ({@link setLive}), so replaying an existing log is not slowed. With both delays 0 it is a
 * synchronous pass-through. The queue is unbounded (like the reference's pause-after-move);
 * a latched warning fires when it exceeds 1000 sends.
 *
 * Forwards every BroadcastSink method: any new sink method added by sibling tasks must be
 * forwarded here too. app.ts calls `setLive()` after the synchronous catch-up.
 */
export class PacedSink implements BroadcastSink {
  private live = false;
  private queue: Job[] = [];
  private holding = false;
  private warned = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private inner: BroadcastSink,
    private opts: PacingOptions,
  ) {}

  /** `setLive(false)` (a session reset) also drops queued sends and the hold: they belong to the replaced log. */
  setLive(live = true): void {
    this.live = live;
    if (live) return;
    if (this.queue.length > 0) logger.debug(`pacing: dropped ${this.queue.length} queued sends on reset`);
    this.queue = [];
    this.holding = false;
    this.warned = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  setSite(site: string): void {
    this.run(() => this.inner.setSite(site));
  }
  setPlayers(white: string, black: string): void {
    this.run(() => this.inner.setPlayers(white, black));
  }
  emitInitialPosition(fenTruncated: string, fmr: number): void {
    this.run(() => this.inner.emitInitialPosition(fenTruncated, fmr));
  }
  emitMove(args: { fenTruncated: string; color: ColorCode; fullMoveNumber: number; san: string; fmr: number }): void {
    this.run(() => this.inner.emitMove(args), this.opts.delayAfterMoveMs);
  }
  emitClocks(whiteCs: number, blackCs: number): void {
    this.run(() => this.inner.emitClocks(whiteCs, blackCs));
  }
  emitPv(color: ColorCode, depth: number, scoreCp: number, timeCs: number, nodes: number, pv: string[], info?: UciInfo): void {
    this.run(() => this.inner.emitPv(color, depth, scoreCp, timeCs, nodes, pv, info));
  }
  emitResult(result: string, gameNumber?: number): void {
    this.run(() => this.inner.emitResult(result, gameNumber), this.opts.delayAfterGameMs);
  }
  emitLevel(text: string): void {
    if (!this.inner.emitLevel) return;
    this.run(() => this.inner.emitLevel?.(text));
  }

  private run(fn: () => void, holdMs = 0): void {
    const idle = !this.live || (this.opts.delayAfterMoveMs === 0 && this.opts.delayAfterGameMs === 0);
    if (idle && this.queue.length === 0 && !this.holding) {
      fn();
      return;
    }
    this.queue.push({ fn, holdMs });
    if (this.queue.length > BACKLOG_WARN && !this.warned) {
      this.warned = true;
      logger.warn('pacing backlog >1000 sends: DELAYAFTERMOVE exceeds the move rate; broadcast is lagging');
    }
    this.pump();
  }

  private pump(): void {
    if (this.holding) return;
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      job.fn();
      if (job.holdMs > 0) {
        this.holding = true;
        this.timer = setTimeout(() => {
          this.timer = undefined;
          this.holding = false;
          this.pump();
        }, job.holdMs);
        this.timer.unref();
        return;
      }
    }
    this.warned = false;
  }
}

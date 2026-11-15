import type { Pipeline } from './pipeline.js';
import type { NormalizedLine } from './source/log-source.js';
import { logger } from './util/logger.js';

export interface DemuxOpts {
  /** A board beyond board 1 was created (before its first line is fed). */
  onBoardAdded?(id: number): void;
}

interface Board {
  id: number;
  pipeline: Pipeline;
  /** Channel whose game this board shows (the last one to open a game here). */
  channel?: string;
  /** A teardown `quit` arrived since this board's last game opened: idle even without a result. */
  ended: boolean;
}

/** The trimmed GUI->engine command of a line, '' otherwise (one trim per line on the hot path). */
const inCmd = (n: NormalizedLine): string => (n.direction === 'in' && n.uci ? n.uci.trim() : '');

/**
 * Splits a log with concurrent games (one channel per game, e.g. a fastchess worker thread)
 * into boards, each driven by its own Pipeline. A board is a slot: a channel opening a game
 * (`ucinewgame`) keeps the board it used last if that board is idle, else takes the lowest
 * idle board, else gets a new one. So sequential play — one worker, or several runs appended
 * to one log with new thread ids — stays on board 1 exactly as a single Pipeline would show it.
 * Lines without a channel (untagged producers) all go to board 1.
 */
export class Demux {
  private boards: Board[] = [];
  /** While set (restart catch-up): channel -> board it must get; any other channel is ignored. */
  private reserved?: Map<string, number>;

  constructor(
    private readonly make: (board: number) => Pipeline,
    private readonly opts: DemuxOpts = {},
  ) {
    this.boards.push({ id: 1, pipeline: make(1), ended: false });
  }

  handleLine(n: NormalizedLine): void {
    const ch = n.channel;
    if (ch === undefined) {
      this.boards[0].pipeline.handleLine(n);
      return;
    }
    const cmd = inCmd(n);
    // A channel is on at most one board: allocate only runs for a channel without one.
    let b = this.boards.find((x) => x.channel === ch);
    if (cmd === 'ucinewgame' && !b) b = this.allocate(ch);
    if (b) {
      if (cmd === 'ucinewgame') b.ended = false;
      else if (cmd === 'quit') b.ended = true; // the engine is gone: its game is over
      b.pipeline.handleLine(n);
      return;
    }
    if (cmd === 'quit') {
      // fastchess quits every engine from its main thread when the tournament ends.
      for (const x of this.boards) {
        x.ended = true;
        x.pipeline.handleLine(n);
      }
    }
  }

  /**
   * Restart catch-up: create boards 1..count and pin each listed channel to its board (the
   * allocation the previous process made, from scanBoards). Until endReservation, games of
   * other channels are not shown.
   */
  reserve(channels: Map<string, number>, count: number): void {
    this.grow(count);
    this.reserved = channels;
  }

  endReservation(): void {
    this.reserved = undefined;
  }

  /** The board channel `ch` currently shows a game on, if any. */
  boardOf(ch: string): number | undefined {
    return this.boards.find((b) => b.channel === ch)?.id;
  }

  /** Board count so far (ids are 1..count). */
  count(): number {
    return this.boards.length;
  }

  pipeline(id: number): Pipeline | undefined {
    return this.boards[id - 1]?.pipeline;
  }

  onAuthorityTick(): void {
    for (const b of this.boards) b.pipeline.onAuthorityTick();
  }

  close(): void {
    for (const b of this.boards) b.pipeline.close();
  }

  private grow(count: number): void {
    while (this.boards.length < count) {
      const b: Board = { id: this.boards.length + 1, pipeline: this.make(this.boards.length + 1), ended: false };
      this.boards.push(b);
      this.opts.onBoardAdded?.(b.id);
    }
  }

  private allocate(ch: string): Board | undefined {
    let b: Board | undefined;
    if (this.reserved) {
      const id = this.reserved.get(ch);
      if (id === undefined) return undefined;
      b = this.boards[id - 1];
    } else {
      const idle = (x: Board) => x.ended || !x.pipeline.busy();
      b = this.boards.find(idle);
      if (!b) {
        this.grow(this.boards.length + 1);
        b = this.boards[this.boards.length - 1];
        logger.info(`board ${b.id}: opened for channel ${ch}`);
      }
    }
    b.channel = ch;
    b.ended = false;
    return b;
  }
}

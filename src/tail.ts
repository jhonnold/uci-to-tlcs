import { createReadStream, watch, statSync, type FSWatcher } from 'node:fs';
import { logger } from './util/logger.js';

export type LineHandler = (line: string) => void;

const POLL_INTERVAL_MS = 200;

export interface TailOptions {
  /** Byte offset to start reading at, or `'end'` (the file size at start; a file created later is read from 0). */
  start: number | 'end';
  /**
   * Called when the file was truncated, rotated (inode change) or vanished and came back.
   * Returns the offset to continue from (the caller re-scans and catches up synchronously).
   * Without it the tailer simply restarts at 0.
   */
  onReset?: () => number;
}

/**
 * Tail a growing text file line by line. Handles: file not existing yet (polls
 * until created), appends (read new bytes on change), truncation / rotation / replacement
 * (size shrank, inode changed or the file vanished and reappeared: see {@link TailOptions.onReset}),
 * and partial trailing lines (buffered until completed).
 *
 * Real-time pacing is inherent: lines are emitted as the writer appends them.
 */
export class FileTailer {
  private offset = 0;
  private ino: number | undefined;
  private leftover = '';
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private reading = false;
  private closed = false;
  private vanished = false;

  constructor(
    private path: string,
    private onLine: LineHandler,
    private opts: TailOptions = { start: 0 },
  ) {}

  start(): void {
    try {
      const st = statSync(this.path);
      this.ino = st.ino;
      this.offset = this.opts.start === 'end' ? st.size : this.opts.start;
      this.attachWatcher();
      void this.readNew();
    } catch {
      logger.info(`Waiting for ${this.path} to appear…`);
    }
    // Polling backstop (also covers initial file creation and editors that
    // replace files in a way fs.watch misses).
    this.poll = setInterval(() => this.tick(), POLL_INTERVAL_MS);
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
  }

  private tick(): void {
    if (!this.watcher) {
      try {
        const st = statSync(this.path);
        if (this.vanished) {
          this.vanished = false;
          this.reset('vanished and reappeared');
        } else {
          this.offset = 0;
          this.ino = st.ino;
        }
        this.attachWatcher();
      } catch {
        return; // still not there
      }
    }
    void this.readNew();
  }

  private attachWatcher(): void {
    if (this.watcher || this.closed) return;
    try {
      this.watcher = watch(this.path, () => void this.readNew());
    } catch {
      // fall back to polling only
    }
  }

  private async readNew(): Promise<void> {
    if (this.reading || this.closed) return;
    this.reading = true;
    try {
      let st;
      try {
        st = statSync(this.path);
      } catch {
        // file disappeared: wait for it to come back (tick() then resets)
        this.vanished = true;
        this.watcher?.close();
        this.watcher = null;
        return;
      }
      if (this.ino !== undefined && st.ino !== this.ino) this.reset('rotated (inode changed)');
      else if (st.size < this.offset) this.reset('truncated');
      const size = statSync(this.path).size;
      if (size > this.offset) {
        const from = this.offset;
        this.offset = size; // the reset path may call back into app code; keep the offset authoritative
        await this.consume(from, size);
      }
    } finally {
      this.reading = false;
    }
  }

  private reset(why: string): void {
    logger.info(`tail: ${this.path} ${why}; re-scanning`);
    this.leftover = '';
    this.offset = this.opts.onReset ? this.opts.onReset() : 0;
    this.watcher?.close();
    this.watcher = null;
    try {
      this.ino = statSync(this.path).ino;
    } catch {
      this.ino = undefined;
    }
    this.attachWatcher();
  }

  private consume(start: number, end: number): Promise<void> {
    return new Promise((resolve) => {
      const stream = createReadStream(this.path, { start, end: end - 1, encoding: 'utf8' });
      stream.on('data', (chunk: string | Buffer) => {
        this.leftover += chunk.toString();
        const lines = this.leftover.split('\n');
        this.leftover = lines.pop() ?? '';
        for (const line of lines) this.onLine(line.replace(/\r$/, ''));
      });
      stream.on('end', () => resolve());
      stream.on('error', (err) => {
        logger.warn(`Tail read error: ${err}`);
        resolve();
      });
    });
  }
}

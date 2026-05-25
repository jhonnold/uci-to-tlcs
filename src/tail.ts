import { createReadStream, watch, statSync, type FSWatcher } from 'node:fs';
import { logger } from './util/logger.js';

export type LineHandler = (line: string) => void;

const POLL_INTERVAL_MS = 200;

/**
 * Tail a growing text file line by line. Handles: file not existing yet (polls
 * until created), appends (read new bytes on change), truncation/rotation (size
 * shrank → restart from 0), and partial trailing lines (buffered until completed).
 *
 * Real-time pacing is inherent: lines are emitted as the writer appends them.
 */
export class FileTailer {
  private offset = 0;
  private leftover = '';
  private watcher: FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private reading = false;
  private closed = false;

  constructor(
    private path: string,
    private onLine: LineHandler,
    private fromStart: boolean,
  ) {}

  start(): void {
    try {
      const size = statSync(this.path).size;
      this.offset = this.fromStart ? 0 : size;
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
        statSync(this.path);
        this.offset = this.fromStart ? 0 : statSync(this.path).size;
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
      let size: number;
      try {
        size = statSync(this.path).size;
      } catch {
        // file disappeared (rotation): reset and wait for it to come back
        this.resetForRotation();
        return;
      }

      if (size < this.offset) {
        // truncated / rotated in place
        this.resetForRotation();
      }
      if (size <= this.offset) return;

      await this.consume(this.offset, size);
      this.offset = size;
    } finally {
      this.reading = false;
    }
  }

  private resetForRotation(): void {
    logger.info(`${this.path} shrank/rotated; restarting from beginning.`);
    this.offset = 0;
    this.leftover = '';
    this.watcher?.close();
    this.watcher = null;
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

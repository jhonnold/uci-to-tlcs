import { ByteLineReader } from './line-reader.js';
import { PgnStreamParser, type PgnGame } from './pgn-parser.js';
import { logger } from '../util/logger.js';

/** Incremental, synchronous reader of a growing PGN file. */
export class PgnFileReader {
  private readonly lines: ByteLineReader;
  private readonly parser = new PgnStreamParser();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    path: string,
    chunkSize?: number,
  ) {
    this.lines = new ByteLineReader(path, chunkSize);
  }

  refresh(): { added: PgnGame[]; reset: boolean } {
    const added: PgnGame[] = [];
    let reset = false;
    const onLine = (line: string): void => {
      const g = this.parser.push(line);
      if (g) added.push(g);
    };
    if (this.lines.readAvailable(onLine) === 'truncated') {
      logger.warn('PGN file shrank; re-reading from the start');
      this.parser.reset();
      reset = true;
      this.lines.readAvailable(onLine);
    }
    return { added, reset };
  }

  /** Calls `onTick` after every poll (the pipeline's hold counter counts ticks). */
  startPolling(onTick: () => void, ms = 200, refresh: () => void = () => void this.refresh()): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      refresh();
      onTick();
    }, ms);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

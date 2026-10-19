import { ByteLineReader } from '../results/line-reader.js';
import { logger } from '../util/logger.js';

/**
 * Synchronously feed every complete line from byte offset `from` to the current EOF to
 * `onLine`. Returns the offset just past the last complete line (a partial last line is left
 * for the tailer).
 */
export function catchUpSync(path: string, from: number, onLine: (line: string) => void): number {
  const r = new ByteLineReader(path, undefined, from);
  if (r.readAvailable((l) => onLine(l)) === 'truncated') {
    logger.warn(`catch-up: ${path} is shorter than offset ${from}; the tailer will reset`);
    return 0;
  }
  return r.lineEnd;
}

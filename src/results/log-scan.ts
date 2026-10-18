import { ByteLineReader } from './line-reader.js';
import { GameSegmenter } from './segmenter.js';
import { makeSource, type Format } from '../source/index.js';
import { parseLine } from '../uci/parser.js';

/**
 * Catch-up API (for T09's restart): byte offsets of each game's first `ucinewgame`
 * line in a log, plus `end` (just past the last complete line). To skip N finished
 * games, tail from `starts[N]` (or `end` if that entry is missing).
 */
export function scanGameStarts(
  logPath: string,
  format: Format,
  chunkSize?: number,
): { starts: number[]; end: number } {
  const reader = new ByteLineReader(logPath, chunkSize);
  const source = makeSource(format);
  const seg = new GameSegmenter();
  const starts: number[] = [];
  // Cheap byte-level superset of the lines the segmenter cares about.
  const prefilter = (raw: Buffer): boolean => raw.includes('ucinewgame') || raw.includes('go');
  reader.readAvailable((line, off) => {
    const n = source.normalize(line);
    if (!n || n.direction !== 'in' || !n.uci) return;
    if (n.uci.trim() === 'ucinewgame') {
      if (seg.onUciNewGame(n.engineId)) starts.push(off);
      return;
    }
    if (parseLine(n.uci)?.type === 'go') seg.onGo(n.engineId);
  }, prefilter);
  return { starts, end: reader.lineEnd };
}

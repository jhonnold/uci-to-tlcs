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

/** One board's current (last) game in a log, as the live Demux would allocate it. */
export interface BoardStart {
  id: number;
  channel: string;
  /** Byte offset of the game's first `ucinewgame`. */
  start: number;
}

/**
 * Restart scan for logs with concurrent games (see Demux): per channel game starts, then the
 * Demux slot allocation replayed with "a game is over once its channel's last line of it
 * has passed". Returns every board's current game and
 * the board count; count 1 means a sequential log (the caller keeps the single-board path).
 */
export function scanBoards(
  logPath: string,
  format: Format,
  chunkSize?: number,
): { boards: BoardStart[]; count: number; end: number } {
  const reader = new ByteLineReader(logPath, chunkSize);
  const source = makeSource(format);
  const segs = new Map<string, GameSegmenter>();
  const games: Array<{ channel: string; start: number; end: number }> = [];
  const open = new Map<string, { channel: string; start: number; end: number }>();
  const prefilter = (raw: Buffer): boolean =>
    raw.includes('ucinewgame') || raw.includes('go') || raw.includes('bestmove');
  reader.readAvailable((line, off) => {
    const n = source.normalize(line);
    if (!n || !n.uci || n.channel === undefined) return;
    const ch = n.channel;
    const uci = n.uci.trim();
    let seg = segs.get(ch);
    if (n.direction === 'in' && uci === 'ucinewgame') {
      if (!seg) segs.set(ch, (seg = new GameSegmenter()));
      if (seg.onUciNewGame(n.engineId)) {
        const g = { channel: ch, start: off, end: off };
        games.push(g);
        open.set(ch, g);
      }
      return;
    }
    const g = open.get(ch);
    if (!g) return;
    g.end = off;
    if (n.direction === 'in' && parseLine(uci)?.type === 'go') seg!.onGo(n.engineId);
  }, prefilter);

  // Replay the allocation in start order.
  const cur: Array<{ channel: string; start: number; end: number } | undefined> = [];
  const owner = new Map<string, number>(); // channel -> board index it holds
  // A game is over at `at` once its channel wrote its last line of that game before `at`.
  const over = (g: { end: number }, at: number) => g.end < at;
  for (const g of games) {
    let i = owner.get(g.channel);
    if (i === undefined || cur[i]?.channel !== g.channel) {
      i = cur.findIndex((x) => !x || over(x, g.start));
      if (i < 0) i = cur.length;
      const prev = cur[i];
      if (prev && owner.get(prev.channel) === i) owner.delete(prev.channel);
    }
    cur[i] = g;
    owner.set(g.channel, i);
  }
  const boards = cur.flatMap((g, i) => (g ? [{ id: i + 1, channel: g.channel, start: g.start }] : []));
  return { boards, count: Math.max(1, cur.length), end: reader.lineEnd };
}

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
): { boards: BoardStart[]; count: number; starts: number[]; end: number } {
  const reader = new ByteLineReader(logPath, chunkSize);
  const source = makeSource(format);
  const all = new GameSegmenter(); // the sequential view, as scanGameStarts (one pass for both)
  const starts: number[] = [];
  const segs = new Map<string, GameSegmenter>();
  const games: ScannedGame[] = [];
  const open = new Map<string, ScannedGame>();
  const prefilter = (raw: Buffer): boolean =>
    raw.includes('ucinewgame') || raw.includes('go') || raw.includes('bestmove');
  reader.readAvailable((line, off) => {
    const n = source.normalize(line);
    if (!n || !n.uci) return;
    const uci = n.uci.trim();
    const isGo = n.direction === 'in' && uci !== 'ucinewgame' && parseLine(uci)?.type === 'go';
    if (n.direction === 'in' && uci === 'ucinewgame' && all.onUciNewGame(n.engineId)) starts.push(off);
    else if (isGo) all.onGo(n.engineId);
    if (n.channel === undefined) return;
    const ch = n.channel;
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
    if (isGo) seg!.onGo(n.engineId);
  }, prefilter);

  // Replay the allocation in start order: the channel's own board, else the lowest board whose
  // game is over (its channel wrote its last line of it before this start), else a new one.
  const cur: ScannedGame[] = [];
  for (const g of games) {
    let i = cur.findIndex((x) => x.channel === g.channel);
    if (i < 0) i = cur.findIndex((x) => x.end < g.start);
    cur[i < 0 ? cur.length : i] = g;
  }
  const boards = cur.map((g, i) => ({ id: i + 1, channel: g.channel, start: g.start }));
  return { boards, count: Math.max(1, cur.length), starts, end: reader.lineEnd };
}

interface ScannedGame {
  channel: string;
  start: number;
  /** Offset of the channel's last scanned line of this game. */
  end: number;
}

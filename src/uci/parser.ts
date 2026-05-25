import { parseInfoLine, type UciInfo } from './info.js';

// A single line of a raw UCI transcript, parsed into one typed event.
// Lines we don't care about (uci, isready, readyok, option, ucinewgame, blank,
// engine chatter) parse to `null` and are dropped by the caller.

export interface IdNameEvent {
  type: 'idName';
  name: string;
}

export interface PositionEvent {
  type: 'position';
  /** true for `position startpos`, false for `position fen ...`. */
  startpos: boolean;
  /** Present only when `startpos` is false. */
  fen?: string;
  /** Moves in long-algebraic coordinate notation, in order. */
  moves: string[];
}

export interface GoEvent {
  type: 'go';
  wtimeMs?: number;
  btimeMs?: number;
  wincMs?: number;
  bincMs?: number;
  movetimeMs?: number;
  depth?: number;
  nodes?: number;
  infinite?: boolean;
}

export interface InfoEvent {
  type: 'info';
  info: UciInfo;
}

export interface BestMoveEvent {
  type: 'bestmove';
  /** Coordinate move, or null for `(none)` / `0000`. */
  move: string | null;
  ponder?: string;
}

export type UciEvent = IdNameEvent | PositionEvent | GoEvent | InfoEvent | BestMoveEvent;

function parsePosition(tokens: string[]): PositionEvent | null {
  // position startpos [moves ...]
  // position fen <6 fen fields> [moves ...]
  let startpos = false;
  let fen: string | undefined;
  let i = 1;

  if (tokens[i] === 'startpos') {
    startpos = true;
    i++;
  } else if (tokens[i] === 'fen') {
    i++;
    const fenParts: string[] = [];
    while (i < tokens.length && tokens[i] !== 'moves') fenParts.push(tokens[i++]);
    if (fenParts.length === 0) return null;
    fen = fenParts.join(' ');
  } else {
    return null;
  }

  let moves: string[] = [];
  if (tokens[i] === 'moves') moves = tokens.slice(i + 1);

  return { type: 'position', startpos, fen, moves };
}

function parseGo(tokens: string[]): GoEvent {
  const ev: GoEvent = { type: 'go' };
  for (let i = 1; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'wtime':
        ev.wtimeMs = parseInt(tokens[++i], 10);
        break;
      case 'btime':
        ev.btimeMs = parseInt(tokens[++i], 10);
        break;
      case 'winc':
        ev.wincMs = parseInt(tokens[++i], 10);
        break;
      case 'binc':
        ev.bincMs = parseInt(tokens[++i], 10);
        break;
      case 'movetime':
        ev.movetimeMs = parseInt(tokens[++i], 10);
        break;
      case 'depth':
        ev.depth = parseInt(tokens[++i], 10);
        break;
      case 'nodes':
        ev.nodes = parseInt(tokens[++i], 10);
        break;
      case 'infinite':
        ev.infinite = true;
        break;
      // movestogo / ponder / searchmoves / mate: not needed for the broadcast.
    }
  }
  return ev;
}

function parseBestMove(tokens: string[]): BestMoveEvent {
  const move = tokens[1];
  if (!move || move === '(none)' || move === '0000') return { type: 'bestmove', move: null };
  const ponderIdx = tokens.indexOf('ponder');
  const ponder = ponderIdx >= 0 ? tokens[ponderIdx + 1] : undefined;
  return { type: 'bestmove', move, ponder };
}

/** Parse one transcript line into a {@link UciEvent}, or `null` if irrelevant. */
export function parseLine(line: string): UciEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const tokens = trimmed.split(/\s+/);

  switch (tokens[0]) {
    case 'id':
      return tokens[1] === 'name' && tokens.length > 2
        ? { type: 'idName', name: tokens.slice(2).join(' ') }
        : null;
    case 'position':
      return parsePosition(tokens);
    case 'go':
      return parseGo(tokens);
    case 'info': {
      const info = parseInfoLine(trimmed);
      return info ? { type: 'info', info } : null;
    }
    case 'bestmove':
      return parseBestMove(tokens);
    default:
      return null;
  }
}

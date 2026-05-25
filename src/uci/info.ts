// Parses a UCI `info` line. Adapted from node-tlcv's src/kibitzer/uci-parser.ts.
//
// Per the UCI spec (DOBRO gist 2592c6dad754ba67e6dcaec8c90165bf):
//  - `depth` / `seldepth` are in plies
//  - `time` is in milliseconds
//  - `nodes` / `nps` are counts
//  - `score cp` is in centipawns, FROM THE ENGINE'S (side-to-move) POINT OF VIEW
//  - `score mate y` is mate in `y` MOVES (not plies), negative when being mated
//  - `multipv` is 1-based; line 1 is the primary line
//  - `pv` is a sequence of long-algebraic coordinate moves (e2e4, e7e8q, e1g1)
//
// We keep the score in the raw engine POV here; White-POV normalization happens
// in GameState, where the side-to-move is known.

export type ScoreKind = 'cp' | 'mate';

export interface UciInfo {
  depth: number;
  seldepth: number | null;
  multipv: number;
  scoreKind: ScoreKind;
  /** Raw value, engine (side-to-move) POV: centipawns for `cp`, moves for `mate`. */
  scoreValue: number;
  nodes: number;
  nps: number;
  timeMs: number;
  /** PV in long-algebraic coordinate notation. */
  pv: string[];
  lowerbound: boolean;
  upperbound: boolean;
}

/**
 * Parse a UCI `info` line into a {@link UciInfo}, or `null` if it lacks the
 * fields we need to render an analysis update (depth, score, and a non-empty pv).
 */
export function parseInfoLine(line: string): UciInfo | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== 'info') return null;

  let depth: number | null = null;
  let seldepth: number | null = null;
  let multipv = 1;
  let scoreKind: ScoreKind | null = null;
  let scoreValue: number | null = null;
  let nodes = 0;
  let nps = 0;
  let timeMs = 0;
  let pv: string[] | null = null;
  let lowerbound = false;
  let upperbound = false;

  for (let i = 1; i < tokens.length; i++) {
    switch (tokens[i]) {
      case 'depth':
        depth = parseInt(tokens[++i], 10);
        break;
      case 'seldepth':
        seldepth = parseInt(tokens[++i], 10);
        break;
      case 'multipv':
        multipv = parseInt(tokens[++i], 10);
        break;
      case 'nodes':
        nodes = parseInt(tokens[++i], 10);
        break;
      case 'nps':
        nps = parseInt(tokens[++i], 10);
        break;
      case 'time':
        timeMs = parseInt(tokens[++i], 10);
        break;
      case 'score':
        if (tokens[i + 1] === 'cp') {
          scoreKind = 'cp';
          scoreValue = parseInt(tokens[i + 2], 10);
          i += 2;
        } else if (tokens[i + 1] === 'mate') {
          scoreKind = 'mate';
          scoreValue = parseInt(tokens[i + 2], 10);
          i += 2;
        }
        break;
      case 'lowerbound':
        lowerbound = true;
        break;
      case 'upperbound':
        upperbound = true;
        break;
      case 'pv':
        pv = tokens.slice(i + 1);
        i = tokens.length; // pv is always last
        break;
      // Ignored: currmove, currmovenumber, hashfull, tbhits, cpuload, string,
      // refutation, currline — not needed for the broadcast.
    }
  }

  if (depth === null || scoreKind === null || scoreValue === null || pv === null || pv.length === 0) {
    return null;
  }

  return { depth, seldepth, multipv, scoreKind, scoreValue, nodes, nps, timeMs, pv, lowerbound, upperbound };
}

const MATE_BASE = 100000;

/**
 * Collapse a parsed score into an integer centipawn value, still in engine POV.
 * Mate is mapped to a large signed value (sign follows `mate y`, magnitude near
 * MATE_BASE) so node-tlcv — which has no special mate handling in `onPV` — renders
 * it as a decisive score. White-POV normalization is applied separately.
 */
export function scoreToCentipawns(info: UciInfo): number {
  if (info.scoreKind === 'cp') return info.scoreValue;
  const sign = info.scoreValue >= 0 ? 1 : -1;
  return sign * (MATE_BASE - Math.abs(info.scoreValue));
}

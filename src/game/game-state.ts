import { Chess, type Move } from 'chess.js';
import { logger } from '../util/logger.js';

export type ColorCode = 'w' | 'b';

export interface AppliedMove {
  /** The side that made the move. */
  color: ColorCode;
  /** Full move number to display (same integer for a white move and the reply). */
  fullMoveNumber: number;
  /** SAN of the move (single token: Nf3, O-O, exd5, e8=Q+). */
  san: string;
}

export const STARTPOS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
/** The first three FEN fields of the standard start (what TLCS sends). */
export const STARTPOS_TRUNC = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';

/**
 * Authoritative board state, reconstructed from the UCI transcript. The `position`
 * command resyncs it exactly; `bestmove` advances it and yields the move metadata
 * (SAN, move number, post-move FEN) the TLCS encoder needs.
 */
export class GameState {
  private chess = new Chess();
  /** Reused scratch board for PV playout (avoids a Chess construction per info line). */
  private probe = new Chess();
  /** The FEN the current game started from, or null for the standard start. */
  startFen: string | null = null;

  /** Clear the board back to the standard start, for a fresh game in a multi-game stream. */
  reset(): void {
    this.chess = new Chess();
    this.startFen = null;
  }

  /** Resync the board to a `position` command. Returns false if it can't be built. */
  setPosition(startpos: boolean, fen: string | undefined, moves: string[]): boolean {
    const base = startpos || !fen ? STARTPOS_FEN : fen;
    const chess = new Chess();
    try {
      chess.load(base);
    } catch (err) {
      logger.warn(`Bad FEN in position command: ${base} (${String(err)})`);
      return false;
    }

    for (const m of moves) {
      if (!tryCoordMove(chess, m)) {
        logger.warn(`Could not apply move ${m} from position command; aborting resync.`);
        return false;
      }
    }

    this.chess = chess;
    this.startFen = startpos || !fen ? null : fen;
    return true;
  }

  /** Apply the side-to-move's chosen coordinate move; returns metadata or null. */
  applyMove(coord: string): AppliedMove | null {
    const color = this.chess.turn();
    const fullMoveNumber = this.chess.moveNumber();
    const mv = tryCoordMove(this.chess, coord);
    if (!mv) {
      logger.warn(`Could not apply bestmove ${coord} at ${this.chess.fen()}`);
      return null;
    }
    return { color, fullMoveNumber, san: mv.san };
  }

  /** True if the game was built from the given `position` base (startpos, or this exact FEN). */
  sameBase(startpos: boolean, fen: string | undefined): boolean {
    return startpos || !fen ? this.startFen === null : fen === this.startFen;
  }

  turn(): ColorCode {
    return this.chess.turn();
  }

  /** First three FEN fields only (board, side-to-move, castling) — what TLCS sends. */
  fenTruncated(): string {
    return this.chess.fen().split(' ').slice(0, 3).join(' ');
  }

  /** Full move number of the side to move (FEN field 6). */
  fullMoveNumber(): number {
    return this.chess.moveNumber();
  }

  /** Fifty-move-rule halfmove clock (FEN field 5). */
  halfmoveClock(): number {
    return parseInt(this.chess.fen().split(' ')[4] ?? '0', 10);
  }

  /**
   * Play out a coordinate PV from the current position into SAN, stopping at the
   * first move that doesn't apply. Mirrors node-tlcv's playoutPV (inverted: we
   * take coords and emit SAN).
   */
  playoutPvToSan(pvCoords: string[]): string[] {
    const probe = this.probe;
    probe.load(this.chess.fen());
    const san: string[] = [];
    for (const m of pvCoords) {
      try {
        // Object form: a string goes through chess.js's SAN matcher, which generates SAN for every legal move.
        const result = probe.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4]?.toLowerCase() });
        san.push(result.san);
      } catch {
        break;
      }
    }
    return san;
  }

  isGameOver(): boolean {
    return this.chess.isGameOver();
  }

  /** Board-derived result string, or null if the game isn't over. */
  result(): string | null {
    if (this.chess.isCheckmate()) {
      // The side to move is checkmated; the other side won.
      return this.chess.turn() === 'w' ? '0-1' : '1-0';
    }
    if (
      this.chess.isStalemate() ||
      this.chess.isInsufficientMaterial() ||
      this.chess.isThreefoldRepetition() ||
      this.chess.isDraw()
    ) {
      return '1/2-1/2';
    }
    return null;
  }
}

/** Apply a long-algebraic coordinate move (e2e4, e7e8q). Returns success. */
function tryCoordMove(chess: Chess, coord: string): Move | null {
  const from = coord.slice(0, 2);
  const to = coord.slice(2, 4);
  const promotion = coord.length > 4 ? coord[4].toLowerCase() : undefined;
  try {
    return chess.move({ from, to, promotion });
  } catch {
    // Fall back to the sloppy parser (handles minor format quirks).
    try {
      return chess.move(coord, { strict: false });
    } catch {
      return null;
    }
  }
}

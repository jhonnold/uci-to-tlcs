import { Chess } from 'chess.js';
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

const STARTPOS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Authoritative board state, reconstructed from the UCI transcript. The `position`
 * command resyncs it exactly; `bestmove` advances it and yields the move metadata
 * (SAN, move number, post-move FEN) the TLCS encoder needs.
 */
export class GameState {
  private chess = new Chess();
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
    if (!tryCoordMove(this.chess, coord)) {
      logger.warn(`Could not apply bestmove ${coord} at ${this.chess.fen()}`);
      return null;
    }
    const history = this.chess.history();
    const san = history[history.length - 1];
    return { color, fullMoveNumber, san };
  }

  turn(): ColorCode {
    return this.chess.turn();
  }

  /** First three FEN fields only (board, side-to-move, castling) — what TLCS sends. */
  fenTruncated(): string {
    return this.chess.fen().split(' ').slice(0, 3).join(' ');
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
    const probe = new Chess(this.chess.fen());
    const san: string[] = [];
    for (const m of pvCoords) {
      try {
        const result = probe.move(m, { strict: false });
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
function tryCoordMove(chess: Chess, coord: string): boolean {
  const from = coord.slice(0, 2);
  const to = coord.slice(2, 4);
  const promotion = coord.length > 4 ? coord[4].toLowerCase() : undefined;
  try {
    chess.move({ from, to, promotion });
    return true;
  } catch {
    // Fall back to the sloppy parser (handles minor format quirks).
    try {
      chess.move(coord, { strict: false });
      return true;
    } catch {
      return false;
    }
  }
}

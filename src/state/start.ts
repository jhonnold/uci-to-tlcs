import { logger } from '../util/logger.js';

export interface StartPlan {
  /** Byte offset to start the catch-up at: the current game's start. */
  offset: number;
  /** Number of the game starting at `offset` (undefined = lazy, --from-end). */
  firstGame?: number;
}

/**
 * Where a (re)start catches up from: the start of the game in progress, so the boards are
 * live and nothing earlier is sent again. Game numbers are 1-based indices of game starts
 * in the log; `finished` is the PGN's finished-game count (undefined = no PGN: the last
 * started game is current). When the PGN already holds the last started game, the next game
 * (K + 1) is current and the catch-up starts at the log's end of the scan.
 */
export function planStart(a: { starts: number[]; end: number; finished?: number; fromEnd: boolean; size: number }): StartPlan {
  const K = a.starts.length;
  if (a.fromEnd) return { offset: a.size };
  // No detected game start (raw/untagged log): the legacy single full replay, as game 1.
  if (K === 0) return { offset: 0, firstGame: 1 };
  const N = a.finished ?? K - 1;
  if (a.finished !== undefined && a.finished > K) {
    logger.warn(`start: PGN has ${a.finished} finished games but the log only ${K} starts (misaligned PGN?)`);
  }
  const current = N >= K ? K + 1 : K;
  // Game 1 starts at offset 0 so any preamble before its first `ucinewgame` is read too.
  const offset = current === 1 ? 0 : current <= K ? a.starts[current - 1] : a.end;
  return { offset, firstGame: current };
}

import type { GameHint, ResultAuthority } from '../pipeline.js';
import type { FinishedGame } from './registry.js';

type Fit = 'no' | 'maybe' | 'exact';

/** The registry slice the authority reads. */
export interface ClaimSource {
  games: readonly FinishedGame[];
  lookup(n: number): FinishedGame | undefined;
  refresh(): unknown;
}

const STARTPOS4 = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';
const fen4 = (fen: string | null | undefined): string => (fen ? fen.trim().split(/\s+/).slice(0, 4).join(' ') : STARTPOS4);
const bareSan = (s: string): string => s.replace(/[+#!?]+$/, '');

/**
 * PGN result authority for logs with concurrent games. fastchess writes PGN entries in
 * finish order, so "game n of the log" is not entry n. Each entry is handed out to the
 * game it describes — same White/Black, same start position, same length (PlyCount) and,
 * when the PGN has SAN movetext, the same moves — and claimed once its result is emitted.
 *
 * Until a second board exists, entry n is preferred whenever it could still be the game
 * (today's sequential behaviour, misaligned PGNs included). With concurrent boards only an
 * exact match is returned.
 */
export class ClaimingAuthority implements ResultAuthority {
  private claimed = new Set<number>();
  private concurrent = false;

  constructor(private readonly reg: ClaimSource) {}

  /** A second board exists: stop handing out entry n on position alone. */
  setConcurrent(): void {
    this.concurrent = true;
  }

  refresh(): void {
    const before = this.reg.games.length;
    this.reg.refresh();
    if (this.reg.games.length < before) this.claimed.clear(); // PGN truncated/replaced: numbering restarts
  }

  claim(e: FinishedGame): void {
    this.claimed.add(e.number);
  }

  lookup(n: number, hint?: GameHint): FinishedGame | undefined {
    const e = this.reg.lookup(n);
    if (!hint) return e;
    const free = (g: FinishedGame | undefined): g is FinishedGame => !!g && !this.claimed.has(g.number);
    if (!this.concurrent && free(e) && fit(e, hint) !== 'no') return e;
    for (const g of this.reg.games) if (free(g) && fit(g, hint) === 'exact') return g;
    if (!this.concurrent && free(e)) return e;
    return undefined;
  }
}

function fit(e: FinishedGame, h: GameHint): Fit {
  if (e.white !== h.white || e.black !== h.black) return 'no';
  if (fen4(e.fen) !== fen4(h.startFen)) return 'no';
  if (e.plyCount === undefined) return 'maybe';
  const target = e.termination === 'illegal move' ? e.plyCount - 1 : e.plyCount;
  if (h.plies < target) return 'maybe';
  if (!e.moves || e.moves.length === 0) return 'exact';
  const sans = h.sans();
  const k = Math.min(e.moves.length, target);
  for (let i = 0; i < k; i++) if (bareSan(e.moves[i]) !== bareSan(sans[i] ?? '')) return 'no';
  return 'exact';
}

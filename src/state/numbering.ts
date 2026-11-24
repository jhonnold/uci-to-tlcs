import * as P from '../tlcs/protocol.js';
import { renderCrosstable } from '../results/crosstable.js';
import type { FinishedGame } from '../results/registry.js';
import { logger } from '../util/logger.js';

/**
 * Quiet period after a numbering dump's last line. node-tlcv sets `currentGameNumber` in a
 * 100 ms debounce timer after the last `CT:` line; 300 ms guarantees it fires before the
 * next game's first item (and long before its `result`).
 */
export const NUMBERING_HOLD_MS = 300;

/** `CTRESET` + a `recent = 1` crosstable of the games before `g`, or null when there are none. */
export function numberingDump(games: readonly FinishedGame[], g: number): string[] | null {
  const prior = games.filter((x) => x.number < g);
  if (prior.length === 0) return null;
  const newest = Math.max(...prior.map((x) => x.number));
  if (newest !== g - 1) logger.warn(`numbering: for game ${g} the newest finished is ${newest} (PGN behind log?)`);
  return [P.CTRESET, ...renderCrosstable(prior, 1).map(P.ct)];
}

/** Queue a numbering dump for one client; the last line holds NUMBERING_HOLD_MS. */
export function enqueueDump(server: { enqueue(dest: string, body: string, opts?: { holdMs?: number }): void }, dest: string, b: string[]): void {
  b.forEach((body, i) => server.enqueue(dest, body, i === b.length - 1 ? { holdMs: NUMBERING_HOLD_MS } : {}));
}

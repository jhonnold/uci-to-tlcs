import { existsSync, readFileSync } from 'node:fs';
import { logger } from './util/logger.js';

/** One finished game in the PGN game database (e.g. fastchess `-pgnout` output). */
export interface PgnGame {
  /** 1-based sequence number (file order for file games; assigned for live games). */
  number: number;
  white: string;
  black: string;
  /** `1-0`, `0-1`, `1/2-1/2`, or `*` when no Result header is present. */
  result: string;
}

/**
 * Parse games out of a PGN document. Games are blank-line-separated blocks; a
 * block counts as a game only if it carries [White] and [Black] headers (the
 * move-text blocks of each game are skipped). A missing or unrecognised
 * [Result] — e.g. a trailing game still in progress — becomes `*`.
 */
export function parsePgnGames(text: string): PgnGame[] {
  const games: PgnGame[] = [];
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const white = pgnTag(block, 'White');
    const black = pgnTag(block, 'Black');
    if (white === undefined || black === undefined) continue;
    games.push({
      number: games.length + 1,
      white,
      black,
      result: normalizeResult(pgnTag(block, 'Result')),
    });
  }
  return games;
}

/**
 * Read + parse a PGN file. A missing file warns and yields `[]`: fastchess
 * creates its `-pgnout` file lazily, at the first finished game.
 */
export function loadPgnGames(path: string): PgnGame[] {
  if (!existsSync(path)) {
    logger.warn(`PGN file not found: ${path} (0 finished games)`);
    return [];
  }
  try {
    return parsePgnGames(readFileSync(path, 'utf8'));
  } catch (err) {
    logger.warn(`Could not read PGN file ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Merge a run's live finished games into the file's games, keyed by number.
 * File entries win on a collision (the file is the database of record); live
 * games only fill in numbers the file doesn't have yet. Sorted by number.
 */
export function mergeGames(fileGames: PgnGame[], liveGames: PgnGame[]): PgnGame[] {
  const merged = new Map<number, PgnGame>();
  for (const g of fileGames) merged.set(g.number, g);
  for (const g of liveGames) if (!merged.has(g.number)) merged.set(g.number, g);
  return [...merged.values()].sort((a, b) => a.number - b.number);
}

function pgnTag(block: string, tag: string): string | undefined {
  return block.match(new RegExp(`\\[${tag}\\s+"([^"]*)"`))?.[1];
}

const KNOWN_RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

function normalizeResult(r: string | undefined): string {
  return r !== undefined && KNOWN_RESULTS.has(r) ? r : '*';
}

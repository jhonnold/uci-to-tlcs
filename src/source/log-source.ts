/**
 * A log-producer adapter. Different tools (fastchess, cutechess, a bare stripped
 * transcript, …) write UCI engine I/O in different envelopes; a {@link LogSource}
 * normalizes one producer line into the form the pipeline understands.
 *
 * The adapter does NOT parse UCI — it only strips the producer envelope and, when
 * the producer tags it, surfaces *which* engine the line belongs to and *which
 * direction* it flowed. All chess/game-segmentation logic stays in the Pipeline.
 */
export interface NormalizedLine {
  /**
   * The bare UCI payload to feed `parseLine` (e.g. `position startpos moves e2e4`),
   * or `null` when the line carries no UCI (a banner the producer emitted).
   */
  uci: string | null;
  /**
   * Stable per-process engine identity for the run, when the producer tags it
   * (e.g. the operator-configured engine name). `undefined` for untagged sources;
   * without it the pipeline cannot bind a name to a colour and falls back to the
   * positional / CLI behaviour.
   */
  engineId?: string;
  /**
   * Direction relative to the engine: `'in'` = GUI→engine (`position`, `go`,
   * `ucinewgame`), `'out'` = engine→GUI (`id`, `info`, `bestmove`). Only `'in'`
   * `position`/`go` participate in White/Black binding. `undefined` when unknown.
   */
  direction?: 'in' | 'out';
}

export interface LogSource {
  /** Stable name for logging / `--format` echo. */
  readonly name: string;
  /** Turn one raw producer line into zero (return `null`) or one normalized line. */
  normalize(line: string): NormalizedLine | null;
}

/**
 * UCI keywords a bare (untagged) transcript line can legitimately start with.
 * Used by the auto-sniffer to recognise a stripped/raw transcript.
 */
const RAW_UCI_KEYWORDS = new Set([
  'uci',
  'uciok',
  'id',
  'isready',
  'readyok',
  'ucinewgame',
  'option',
  'setoption',
  'position',
  'go',
  'info',
  'bestmove',
  'ponderhit',
  'register',
  'debug',
]);

/** Heuristic: does a trimmed line look like a bare UCI command (raw transcript)? */
export function looksLikeRawUci(trimmed: string): boolean {
  const first = trimmed.split(/\s+/, 1)[0];
  return RAW_UCI_KEYWORDS.has(first);
}

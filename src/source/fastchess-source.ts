import type { LogSource, NormalizedLine } from './log-source.js';

/**
 * fastchess `-log file=… engine=true` output. Each engine I/O line looks like:
 *
 *   [Engine] [15:14:19.224585] <     139834165294784>  EngA <--- go wtime 410 ...
 *   [Engine] [15:14:19.224961] <     139834165294784>  EngA ---> bestmove e2e3
 *
 * `<---` is GUI→engine (in), `--->` is engine→GUI (out). The token before the
 * marker is the operator-configured engine name — the stable per-process identity
 * for the run and the natural display name (the self-reported `id name` is identical
 * for identical binaries, so the configured name is the better label).
 *
 * Everything else — `[INFO ]`/`[WARN ]` banners, fastchess `Info;`/`Position;`/
 * `Moves;` diagnostic dumps, blank lines — has no `<threadid>` + direction marker
 * and is dropped (returns `null`).
 */
export class FastchessSource implements LogSource {
  readonly name = 'fastchess';

  // group1 = engine name (engineId), group2 = direction, group3 = UCI payload
  private static readonly RE =
    /^\[\s*\w+\s*\]\s+\[[\d:.]+\]\s+<\s*\d+>\s+(\S+)\s+(<---|--->)\s+(.*)$/;

  /** Does a trimmed line look like a fastchess engine-tagged line? (auto-sniff) */
  static matches(trimmed: string): boolean {
    return FastchessSource.RE.test(trimmed);
  }

  normalize(line: string): NormalizedLine | null {
    const m = FastchessSource.RE.exec(line.trim());
    if (!m) return null;
    const engineId = m[1];
    const direction = m[2] === '<---' ? 'in' : 'out';
    const uci = m[3].trim();
    return { uci: uci || null, engineId, direction };
  }
}

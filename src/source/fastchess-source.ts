import type { LogSource, NormalizedLine } from './log-source.js';

/**
 * fastchess `-log file=… engine=true` output. Every engine I/O line is written by
 * fastchess's `Logger::writeToEngine` / `Logger::readFromEngine`
 * (fastchess `app/src/core/logger/logger.cpp`) in one of these shapes:
 *
 *   <prefix>  <name> <--- <msg>           GUI→engine  (direction 'in':  uci/position/go/…)
 *   <prefix>  <name> ---> <msg>           engine→GUI  (direction 'out': id/info/bestmove/…)
 *   <prefix>  <stderr> <name> ---> <msg>  engine→GUI on stderr (e.g. "Process exited …")
 *
 * `<prefix>` is fastchess's `make_prefix` — `[label] [timestamp] <threadid> ` (label/time/
 * threadid are fixed-width fields) — and the two spaces before `<name>` are the prefix's
 * trailing space plus the format's leading space. `<name>` is the operator-configured
 * engine name: **free-form text that may contain spaces** (e.g. `Berserk A`,
 * `Berserk 14 v2-rc.1 a4994ff`). It is the stable per-process identity for the run and the
 * display name (the self-reported `id name` is identical for identical binaries, so the
 * configured name is the better label).
 *
 * **Delimiting (why not split on whitespace).** The name has no fixed width and can hold
 * any whitespace, so a whitespace split would chop it. Instead we anchor on the direction
 * marker, which fastchess writes verbatim and always single-space-pads: `<---` (in) or
 * `--->` (out). The name is everything between the end of the `<threadid>` prefix and that
 * marker; the UCI payload is everything after it. Both markers share the three-dash core
 * `---`, so a single `indexOf('---')` locates the marker and one neighbour check classifies
 * it — `<---` has a `<` to its left, `--->` has a `>` to its right. That is one scan of the
 * line (no backtracking, no hard-coded offsets), so it stays fast even if the logs arrive
 * in a burst, and it degrades gracefully if fastchess changes the prefix field widths.
 *
 * **Accepted limitation.** A name containing the literal `---` (three consecutive dashes)
 * would be mis-split at that point. Far rarer than a name containing a space, and the
 * current single-token names never do.
 *
 * Everything else — `[INFO ]`/`[WARN ]` banners, fastchess `Info;`/`Position;`/`Moves;`
 * diagnostic dumps, blank lines — has a bracketed prefix but no `<---`/`--->` marker (or no
 * bracketed prefix at all), and is dropped (returns `null`).
 */
export class FastchessSource implements LogSource {
  readonly name = 'fastchess';

  /** fastchess's stderr annotation, emitted before the name on stderr lines. */
  private static readonly STDERR = '<stderr> ';
  /** The three-dash core shared by both direction markers. */
  private static readonly DASHES = '---';
  /** Marker length (`<---`/`--->` is 4) plus the trailing space before the payload. */
  private static readonly MARKER_SKIP = 5;

  /** Does a trimmed line look like a fastchess engine-tagged line? (auto-sniff) */
  static matches(trimmed: string): boolean {
    // A tagged line is bracket-prefixed and carries one of the two direction markers. A
    // banner shares the bracketed prefix but its separator is space-padded ` --- `, so it
    // matches neither marker; a bare UCI line has no bracketed prefix at all.
    return trimmed.startsWith('[') && (trimmed.includes('<---') || trimmed.includes('--->'));
  }

  normalize(line: string): NormalizedLine | null {
    const s = line.trim();
    const d = s.indexOf(FastchessSource.DASHES);
    if (d === -1) return null;

    // Classify the marker and locate its start — the name ends just before it.
    let start: number;
    let direction: 'in' | 'out';
    if (s[d - 1] === '<') {
      start = d - 1; // `<---`: the `<` sits immediately left of the first dash
      direction = 'in';
    } else if (s[d + 3] === '>') {
      start = d; // `--->`: the `>` sits immediately right of the last dash
      direction = 'out';
    } else {
      return null; // a `---` that is neither marker (e.g. in the name or a banner)
    }

    // Left boundary: the first `>` is the close of the `<threadid>` prefix — the label and
    // timestamp fields contain no `>` — so the name begins right after it.
    const gt = s.indexOf('>');
    if (gt === -1 || gt >= start) return null;
    let name = s.slice(gt + 1, start).trim();
    if (name.startsWith(FastchessSource.STDERR)) name = name.slice(FastchessSource.STDERR.length);
    if (!name) return null;

    const uci = s.slice(start + FastchessSource.MARKER_SKIP).trim();
    return { uci: uci || null, engineId: name, direction };
  }
}

import { looksLikeRawUci, type LogSource, type NormalizedLine } from './log-source.js';
import { RawUciSource } from './raw-source.js';
import { FastchessSource } from './fastchess-source.js';

export type { LogSource, NormalizedLine } from './log-source.js';
export { RawUciSource } from './raw-source.js';
export { FastchessSource } from './fastchess-source.js';

export type Format = 'auto' | 'raw' | 'fastchess';

export const FORMATS: readonly Format[] = ['auto', 'raw', 'fastchess'];

export function isFormat(s: string): s is Format {
  return (FORMATS as readonly string[]).includes(s);
}

/**
 * Picks the concrete adapter on the first decisive content line, then delegates
 * forever after. A fastchess-tagged line selects {@link FastchessSource}; a bare
 * UCI command selects {@link RawUciSource}. Undecided lines (producer banners) are
 * skipped until one of those is seen, so a fastchess log that opens with `[INFO ]`
 * banners is still detected correctly.
 */
class AutoSource implements LogSource {
  readonly name = 'auto';
  private delegate: LogSource | null = null;

  normalize(line: string): NormalizedLine | null {
    if (!this.delegate) {
      const t = line.trim();
      if (!t) return null;
      if (FastchessSource.matches(t)) this.delegate = new FastchessSource();
      else if (looksLikeRawUci(t)) this.delegate = new RawUciSource();
      else return null; // banner / undecided — wait for a decisive line
    }
    return this.delegate.normalize(line);
  }
}

export function makeSource(format: Format): LogSource {
  switch (format) {
    case 'raw':
      return new RawUciSource();
    case 'fastchess':
      return new FastchessSource();
    case 'auto':
      return new AutoSource();
  }
}

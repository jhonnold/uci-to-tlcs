import type { LogSource, NormalizedLine } from './log-source.js';

/**
 * A bare, already-stripped UCI transcript: every non-blank line is the UCI payload
 * itself, with no engine identity or direction. This is the original behaviour and
 * the fallback for any pre-stripped feed. Without identity the pipeline keeps the
 * positional + CLI/`id name` naming it always used; game *segmentation* (board
 * reset between games) still works via position-list resets.
 */
export class RawUciSource implements LogSource {
  readonly name = 'raw';

  normalize(line: string): NormalizedLine | null {
    const uci = line.trim();
    if (!uci) return null;
    return { uci };
  }
}

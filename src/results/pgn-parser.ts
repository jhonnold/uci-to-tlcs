import { logger } from '../util/logger.js';

export interface PgnGame {
  headers: Record<string, string>;
  white: string;
  black: string;
  result: string;
  termination?: string;
  plyCount?: number;
  fen?: string;
  round?: string;
  /** Movetext SANs without move numbers, comments, NAGs or check/annotation marks. */
  moves?: string[];
}

const HEADER_RE = /^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$/;
const TERMINATIONS = new Set(['1-0', '0-1', '1/2-1/2', '*']);
const MOVE_NUMBER_RE = /^\d+\.+/;

/** A SAN without check/annotation marks, zero-castling spelled `O-O`: comparable across producers. */
export function normSan(s: string): string {
  return s.replace(/[+#!?]+$/, '').replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O');
}

/**
 * Line-fed PGN entry parser. Only headers matter; movetext is scanned just far
 * enough to find the termination token (outside `{}` comments and `;` comments),
 * which is what marks an entry as completely written.
 */
export class PgnStreamParser {
  private headers: Record<string, string> = {};
  private haveHeaders = false;
  private commentDepth = 0;
  private movetextTokens = 0;
  private moves: string[] = [];

  reset(): void {
    this.headers = {};
    this.haveHeaders = false;
    this.commentDepth = 0;
    this.movetextTokens = 0;
    this.moves = [];
  }

  push(line: string): PgnGame | undefined {
    let out: PgnGame | undefined;
    if (this.commentDepth === 0) {
      const m = HEADER_RE.exec(line.trim());
      if (m) {
        const [, tag, raw] = m;
        if (tag === 'Event' && this.haveHeaders) {
          if (this.movetextTokens > 0) {
            logger.warn('PGN: new entry started before the previous one was terminated; finalizing from its Result header');
            out = this.finish(undefined);
          } else {
            this.reset(); // headers only, never got movetext: drop the fragment
          }
        }
        this.headers[tag] = raw.replace(/\\(["\\])/g, '$1');
        this.haveHeaders = true;
        return out;
      }
    }
    if (!this.haveHeaders) return undefined;

    // Movetext: scan for the termination token outside comments.
    let i = 0;
    let token = '';
    const flush = (): string | undefined => {
      const t = token;
      token = '';
      if (t) {
        this.movetextTokens++;
        if (TERMINATIONS.has(t)) return t;
        const san = normSan(t.replace(MOVE_NUMBER_RE, ''));
        if (san && !san.startsWith('$')) this.moves.push(san);
      }
      return undefined;
    };
    while (i < line.length) {
      const c = line[i];
      if (this.commentDepth > 0) {
        if (c === '{') this.commentDepth++;
        else if (c === '}') this.commentDepth--;
        i++;
        continue;
      }
      if (c === '{') {
        const t = flush();
        if (t) return this.finish(t);
        this.commentDepth = 1;
      } else if (c === ';') {
        break;
      } else if (c === ' ' || c === '\t') {
        const t = flush();
        if (t) return this.finish(t);
      } else {
        token += c;
      }
      i++;
    }
    const t = flush();
    if (t) return this.finish(t);
    return undefined;
  }

  private finish(termToken: string | undefined): PgnGame {
    const h = this.headers;
    const ply = h['PlyCount'] !== undefined ? parseInt(h['PlyCount'], 10) : NaN;
    const game: PgnGame = {
      headers: h,
      white: h['White'] ?? '',
      black: h['Black'] ?? '',
      result: h['Result'] ?? termToken ?? '*',
      termination: h['Termination'],
      plyCount: Number.isFinite(ply) ? ply : undefined,
      fen: h['FEN'],
      round: h['Round'],
      moves: this.moves,
    };
    this.reset();
    return game;
  }
}

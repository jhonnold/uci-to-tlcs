// Tolerant multi-game PGN parsing (fastchess and chess.js styles).

export interface PgnGame {
  headers: Record<string, string>;
  sans: string[];
  file?: string;
  index: number;
}

const HEADER_RE = /^\[(\w+)\s+"(.*)"\]\s*$/;
const RESULT_TOKENS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

export function normSan(s: string): string {
  return s.replace(/[+#!?]+/g, '').replace(/^0-0-0$/, 'O-O-O').replace(/^0-0$/, 'O-O');
}

export function tokenizeMovetext(text: string): string[] {
  let t = text.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
  // strip nested variations
  let depth = 0;
  let out = '';
  for (const ch of t) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  t = out.replace(/\$\d+/g, ' ');
  const sans: string[] = [];
  for (let tok of t.split(/\s+/)) {
    tok = tok.replace(/^\d+\.+/, '');
    // `1. ... d6` (Black to move first, as node-tlcv writes it) leaves a bare `...`.
    if (!tok || /^\.+$/.test(tok) || RESULT_TOKENS.has(tok)) continue;
    sans.push(normSan(tok));
  }
  return sans;
}

export function parsePgn(text: string, file?: string): PgnGame[] {
  const games: PgnGame[] = [];
  let headers: Record<string, string> = {};
  let move: string[] = [];
  let have = false;
  const flush = () => {
    if (have) games.push({ headers, sans: tokenizeMovetext(move.join('\n')), file, index: games.length + 1 });
    headers = {};
    move = [];
    have = false;
  };
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('[')) {
      if (move.some((l) => l.trim())) flush();
      const m = HEADER_RE.exec(line);
      if (m) headers[m[1]] = m[2];
      have = true;
    } else if (line.trim()) {
      move.push(line);
      have = true;
    }
  }
  flush();
  return games;
}

import { Chess } from 'chess.js';
import type { PgnGame } from './pgn.js';
import type { TranscriptRecord } from './transcript.js';
import { BOARD_LINE, MG_TOKEN, MULTIGAME_LINE, isGameLine, parseResultBody, splitOnCommand } from './tlcs-frame.js';
import { isAccepted } from './mock-core.js';
import { normSan } from './pgn.js';

export type FindingKind = 'OK' | 'DIFF' | 'MISSING' | 'EXTRA' | 'COUNT' | 'STAR' | 'INFO' | 'TRANSCRIPT';

export interface Finding {
  kind: FindingKind;
  field?: 'result' | 'moves' | 'fen' | 'number';
  game?: string;
  msg: string;
}

export const isFailure = (f: Finding): boolean => f.kind !== 'OK' && f.kind !== 'INFO';

export interface CompareOpts {
  allowStar?: boolean;
  strictNumbers?: boolean;
}

const players = (g: PgnGame): string => `${(g.headers.White ?? '').trim()} vs ${(g.headers.Black ?? '').trim()}`;
const label = (g: PgnGame): string => `game ${g.index} (${players(g)})`;
const sameSans = (a: string[], b: string[]): boolean => a.length === b.length && a.every((s, i) => s === b[i]);

function lcp(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const fenHead = (f: string): string => f.trim().split(/\s+/).slice(0, 3).join(' ');

/** Compare fastchess games (expected) with node-tlcv games (actual), matched by content. */
export function compareGames(fc: PgnGame[], nt: PgnGame[], opts: CompareOpts = {}): Finding[] {
  const out: Finding[] = [];
  if (fc.length !== nt.length) out.push({ kind: 'COUNT', msg: `game count: expected ${fc.length} got ${nt.length}` });
  if (!opts.allowStar) {
    for (const g of nt) {
      if ((g.headers.Result ?? '').trim() === '*') {
        out.push({ kind: 'STAR', msg: `node-tlcv game has Result * (${players(g)})${g.file ? ` in ${g.file}` : ''}` });
      }
    }
  }

  const groups = new Map<string, { fc: PgnGame[]; nt: PgnGame[] }>();
  const grp = (k: string) => {
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { fc: [], nt: [] }));
    return g;
  };
  for (const g of fc) grp(players(g)).fc.push(g);
  for (const g of nt) grp(players(g)).nt.push(g);

  const pairs = new Map<PgnGame, PgnGame>();
  const extras: PgnGame[] = [];
  for (const g of groups.values()) {
    const fcLeft = [...g.fc];
    const ntLeft = [...g.nt];
    // pass 1: exact
    for (const f of [...fcLeft]) {
      const i = ntLeft.findIndex(
        (n) => (n.headers.Result ?? '') === (f.headers.Result ?? '') && sameSans(n.sans, f.sans),
      );
      if (i >= 0) {
        pairs.set(f, ntLeft[i]);
        ntLeft.splice(i, 1);
        fcLeft.splice(fcLeft.indexOf(f), 1);
      }
    }
    // pass 2: longest common prefix
    for (const f of fcLeft) {
      if (!ntLeft.length) break;
      let best = 0;
      let bestLcp = -1;
      ntLeft.forEach((n, i) => {
        const l = lcp(f.sans, n.sans);
        if (l > bestLcp) {
          bestLcp = l;
          best = i;
        }
      });
      pairs.set(f, ntLeft[best]);
      ntLeft.splice(best, 1);
    }
    extras.push(...ntLeft);
  }

  for (const f of fc) {
    const n = pairs.get(f);
    if (!n) {
      out.push({ kind: 'MISSING', game: label(f), msg: `${label(f)}: no node-tlcv game found` });
      continue;
    }
    let ok = true;
    const er = (f.headers.Result ?? '').trim();
    const gr = (n.headers.Result ?? '').trim();
    if (er !== gr) {
      ok = false;
      out.push({ kind: 'DIFF', field: 'result', game: label(f), msg: `${label(f)}: result: exp ${er} got ${gr}` });
    }
    if (!sameSans(f.sans, n.sans)) {
      ok = false;
      const k = lcp(f.sans, n.sans);
      const detail =
        k < f.sans.length && k < n.sans.length
          ? `first divergence at ply ${k + 1}: exp ${f.sans[k]} got ${n.sans[k]}`
          : `length exp ${f.sans.length} got ${n.sans.length}`;
      out.push({ kind: 'DIFF', field: 'moves', game: label(f), msg: `${label(f)}: moves: ${detail}` });
    }
    if (f.headers.FEN !== undefined) {
      if (n.headers.FEN === undefined) {
        out.push({ kind: 'INFO', field: 'fen', game: label(f), msg: `${label(f)}: fastchess has [FEN], node-tlcv does not` });
      } else if (fenHead(f.headers.FEN) !== fenHead(n.headers.FEN)) {
        ok = false;
        out.push({ kind: 'DIFF', field: 'fen', game: label(f), msg: `${label(f)}: FEN: exp ${f.headers.FEN} got ${n.headers.FEN}` });
      }
    }
    if (opts.strictNumbers && n.file) {
      const m = /(?:^|\/)(\d+)_[^/]*$/.exec(n.file);
      if (!m || parseInt(m[1], 10) !== f.index) {
        ok = false;
        out.push({ kind: 'DIFF', field: 'number', game: label(f), msg: `${label(f)}: file number ${m?.[1] ?? '?'} != ${f.index} (${n.file})` });
      }
    }
    if (ok) out.push({ kind: 'OK', game: label(f), msg: `${label(f)}: OK (${f.sans.length} plies, ${er})` });
  }
  for (const n of extras) {
    out.push({ kind: 'EXTRA', game: label(n), msg: `${label(n)}: extra node-tlcv game${n.file ? ` in ${n.file}` : ''}` });
  }
  return out;
}

export interface TranscriptOpts {
  fc?: PgnGame[];
  expectContiguous?: boolean;
  /** The client never opted in: any TLCS-MG token (BOARD/BOARDS/MULTIGAME/GAMENO) is a finding. */
  legacy?: boolean;
}

/** White, Black and Result headers of a fastchess game, trimmed. */
const hdr = (g: PgnGame): [string, string, string] => [
  (g.headers.White ?? '').trim(),
  (g.headers.Black ?? '').trim(),
  (g.headers.Result ?? '').trim(),
];

interface BoardView {
  armed: boolean; // expecting a FEN before any move
  wp?: string;
  bp?: string;
  sans: string[];
  gameno?: number;
  prevResult?: string;
  /** node-tlcv's board model (only once a valid FEN arrived): moves apply, a failed one reloads `fen`. */
  chess?: Chess;
  fen?: string;
  fmr: number;
  /** Position the recorded `sans` start from (3-field FEN head). */
  from?: string;
}

const STARTPOS_HEAD = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';

/** A 3-field TLCS FEN with node-tlcv's completion (castling `-` if missing, ep `-`), or null if chess.js rejects it. */
function loadFen(fen: string, fmr: number, moveNo: number): Chess | null {
  const t = fen.trim().split(/\s+/);
  if (t[1] === 'w' || t[1] === 'b') {
    if (t.length === 2) t.push('-');
  }
  try {
    return new Chess([...t.slice(0, 3), '-', fmr, Math.max(1, moveNo)].join(' '));
  } catch {
    return null;
  }
}

/** The final position of a fastchess game (3-field head), or null if its moves do not replay. */
function finalHead(g: PgnGame): string | null {
  try {
    const c = new Chess(g.headers.FEN?.trim() || undefined);
    for (const san of g.sans) c.move(san, { strict: false });
    return fenHead(c.fen());
  } catch {
    return null;
  }
}

/**
 * Invariants over one mock transcript. Game lines are tracked per board: bare lines are the
 * single-game stream, `BOARD <n> <line>` (after a `MULTIGAME:` reply) is board n. Each board is
 * modelled as node-tlcv does it: moves apply to a chess board, a move that does not apply
 * reloads the last `FEN:` and history restarts there (a lost line, a join snapshot's `(setup)`
 * move), a startpos `FEN:` resets a loaded board. A result with a preceding `GAMENO` must be that
 * fastchess game: names and result, and every SAN when the history starts at the game's start
 * position; otherwise (a client that joined late or lost lines) the received SANs must be the
 * game's tail and the final board its final position. Without `GAMENO` the result must match
 * some unused fastchess game by names and result.
 */
export function checkTranscript(records: TranscriptRecord[], opts: TranscriptOpts = {}): Finding[] {
  const out: Finding[] = [];
  const fail = (msg: string) => out.push({ kind: 'TRANSCRIPT', msg });
  const mode = records[0]?.mode ?? 'node-tlcv';
  const tag = `[${records[0]?.user ?? '?'}]`;

  let lastId: number | undefined;
  let accepted = new Set<number>();
  let mg = false;
  let mgSeen = false; // the client opted in at some point (lines in flight across a re-LOGON are fine)
  const boards = new Map<number, BoardView>();
  const view = (b: number): BoardView => {
    let v = boards.get(b);
    if (!v) boards.set(b, (v = { armed: true, sans: [], fmr: 0 }));
    return v;
  };
  const rearm = () => {
    for (const v of boards.values()) v.armed = true;
  };
  view(0);
  const unused = opts.fc ? [...opts.fc] : [];
  const claimed = new Map<number, number>(); // GAMENO -> board

  const game = (b: number, body: string, t: number) => {
    const v = view(b);
    const sp = splitOnCommand(body);
    if (!sp) {
      const no = /^GAMENO:\s*(\d+)$/.exec(body);
      if (no) v.gameno = Number(no[1]);
      return;
    }
    const [cmd, arg] = sp;
    const where = b ? ` board ${b}` : '';
    if (cmd === 'FEN') {
      v.armed = false;
      v.fen = arg;
      const head = fenHead(arg);
      if (!v.chess || head === STARTPOS_HEAD) {
        // not loaded yet: load it; loaded + startpos: node-tlcv reset()
        v.chess = loadFen(arg, 0, 1) ?? undefined;
        v.from = head;
        v.sans = [];
      }
    } else if (cmd === 'FMR') v.fmr = Number(arg) || 0;
    else if ((cmd === 'WMOVE' || cmd === 'BMOVE') && v.armed) {
      fail(`${tag} t=${t}ms:${where} ${cmd} before any FEN after (re)logon/restart`);
      v.armed = false;
    } else if (cmd === 'WPLAYER') {
      v.wp = arg;
      v.sans = [];
      v.from = v.chess ? fenHead(v.chess.fen()) : v.from;
    } else if (cmd === 'BPLAYER') v.bp = arg;
    if (cmd === 'WMOVE' || cmd === 'BMOVE') {
      const moveNo = parseInt(arg, 10) || 1;
      const san = arg.replace(/^\d+\.+\s*/, '').trim();
      if (!v.chess) {
        if (san !== '(setup)') v.sans.push(normSan(san));
      } else {
        let ok = false;
        try {
          v.chess.move(san, { strict: false });
          ok = true;
        } catch {
          /* node-tlcv: "Failed to parse ... Loading from FEN" */
        }
        if (ok) v.sans.push(normSan(san));
        else if (v.fen) {
          v.chess = loadFen(v.fen, v.fmr, moveNo) ?? v.chess;
          v.from = fenHead(v.fen);
          v.sans = [];
        }
      }
    }
    if (cmd !== 'result' || !opts.fc) return;
    const res = parseResultBody(body);
    const no = v.gameno;
    v.gameno = undefined;
    if (no !== undefined) {
      const key = `#${no}`;
      if (v.prevResult === key) return; // a replay of the same result
      v.prevResult = key;
      const g = opts.fc[no - 1];
      const label = `${tag} t=${t}ms:${where} GAMENO ${no}`;
      if (claimed.has(no)) return void fail(`${label} already reported on board ${claimed.get(no)}`);
      claimed.set(no, b);
      if (!g) return void fail(`${label}: no such fastchess game`);
      const i = unused.indexOf(g);
      if (i >= 0) unused.splice(i, 1);
      const [gw, gb, gr] = hdr(g);
      if (gw !== v.wp || gb !== v.bp || gr !== res) {
        return void fail(`${label}: ${v.wp} vs ${v.bp} ${res}, fastchess has ${gw} vs ${gb} ${gr}`);
      }
      const start = g.headers.FEN ? fenHead(g.headers.FEN) : STARTPOS_HEAD;
      if (!v.chess || v.from === start) {
        if (v.sans.length !== g.sans.length || v.sans.some((x, k) => x !== g.sans[k])) {
          const k = lcp(v.sans, g.sans);
          fail(`${label}: moves differ at ply ${k + 1} (got ${v.sans[k] ?? 'end'}, exp ${g.sans[k] ?? 'end'})`);
        }
        return;
      }
      // Joined late or lost lines: the history is the game's tail, the board its final position.
      const tail = g.sans.slice(g.sans.length - v.sans.length);
      if (v.sans.length > g.sans.length || v.sans.some((x, k) => x !== tail[k])) {
        fail(`${label}: moves after the reload are not the game's last ${v.sans.length} ply`);
      }
      const want = finalHead(g);
      const got = fenHead(v.chess.fen());
      if (want !== null && got !== want) fail(`${label}: final board ${got}, fastchess ends at ${want}`);
      return;
    }
    const match = (g: PgnGame) => {
      const [w, b, r] = hdr(g);
      return w === v.wp && b === v.bp && r === res;
    };
    const i = unused.findIndex(match);
    const key = `${v.wp}|${v.bp}|${res}`;
    if (i >= 0) unused.splice(i, 1);
    else if (key !== v.prevResult || !opts.fc.some(match)) {
      fail(`${tag} t=${t}ms:${where} result ${res} for ${v.wp} vs ${v.bp} matches no unused fastchess game`);
    }
    v.prevResult = key;
  };

  for (const r of records) {
    if (r.dir === 'event') {
      if (r.event === 'logon' || r.event === 'relogon') {
        rearm();
        mg = false;
      }
      continue;
    }
    if (r.dir !== 'in' || !r.verdict) continue;
    const v = r.verdict;
    const body = r.body ?? '';

    if (v === 'out-of-order') {
      if (r.id === undefined || !accepted.has(r.id)) {
        fail(`${tag} t=${r.t}ms: out-of-order id ${r.id} was never accepted (a unique message was lost)`);
      }
      continue;
    }
    if (!isAccepted(v)) continue; // gated, duplicate, injected-*

    if (r.id !== undefined) {
      const newEpoch =
        v === 'restart' ||
        (mode === 'desktop' && lastId !== undefined && (r.id === 1 || (lastId - r.id > 100 && r.id <= 100)));
      if (newEpoch) {
        accepted = new Set();
        lastId = undefined;
        rearm();
      }
      if (lastId !== undefined && r.id <= lastId) {
        fail(`${tag} t=${r.t}ms: accepted id ${r.id} not greater than previous ${lastId}`);
      }
      if (opts.expectContiguous && lastId !== undefined && r.id !== lastId + 1) {
        fail(`${tag} t=${r.t}ms: id gap ${lastId} -> ${r.id}`);
      }
      accepted.add(r.id);
      lastId = r.id;
    }

    if (MG_TOKEN.test(body)) {
      if (opts.legacy) {
        fail(`${tag} t=${r.t}ms: TLCS-MG line to a single-game client: ${body}`);
        continue;
      }
      if (MULTIGAME_LINE.exec(body)?.[1] === '1') {
        mg = true;
        mgSeen = true;
        rearm();
        continue;
      }
      const w = BOARD_LINE.exec(body);
      if (w && mg) game(Number(w[1]), w[2], r.t);
      else if (!mg && !mgSeen && !body.startsWith('MULTIGAME:')) fail(`${tag} t=${r.t}ms: TLCS-MG line before the MULTIGAME reply: ${body}`);
      continue;
    }
    if (mg && isGameLine(body)) {
      fail(`${tag} t=${r.t}ms: bare game line after the MULTIGAME reply: ${body}`);
      continue;
    }
    game(0, body, r.t);
  }
  return out;
}

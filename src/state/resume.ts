import type { BroadcastSink } from '../pipeline.js';
import type { ColorCode } from '../tlcs/protocol.js';
import type { UciInfo } from '../uci/info.js';
import * as P from '../tlcs/protocol.js';
import { renderCrosstable } from '../results/crosstable.js';
import type { FinishedGame } from '../results/registry.js';
import { logger } from '../util/logger.js';
import type { PersistedClient } from './state-file.js';

/**
 * Quiet period after a numbering dump's last line. node-tlcv sets `currentGameNumber` in a
 * 100 ms debounce timer after the last `CT:` line; 300 ms guarantees it fires before the
 * next game's first item (and long before its `result`).
 */
export let NUMBERING_HOLD_MS = 300;
/** Test hook: the negative control of the integration test sets this to 0. */
export function setNumberingHoldMs(ms: number): void {
  NUMBERING_HOLD_MS = ms;
}

/** A restored client replays at most this many missed games; older ones are lost, as without STATEFILE. */
export const MAX_REPLAY_GAMES = 3;

export interface ResumePlan {
  /** Byte offset to start the catch-up at. */
  offset: number;
  /** Number of the game starting at `offset` (undefined = lazy, --from-end). */
  firstGame?: number;
  /** Number of the game in progress (or the next to start); undefined = lazy. */
  current?: number;
  /** Resolved resume game per restored client (parallel to the input). */
  nexts: number[];
  /** Indices of restored clients whose `next` was clamped to the replay depth. */
  clamped: number[];
}

/**
 * Where to restart. Game numbers are 1-based indices of game starts in the log. `finished`
 * is the PGN's finished-game count (undefined = no PGN: the last started game is current).
 */
export function planResume(a: {
  starts: number[];
  end: number;
  finished?: number;
  restored: Array<number | undefined>;
  fromEnd: boolean;
  size: number;
}): ResumePlan {
  const K = a.starts.length;
  if (a.fromEnd) return { offset: a.size, nexts: a.restored.map(() => 0), clamped: [] };
  // No detected game start (raw/untagged log): the legacy single full replay, as game 1.
  if (K === 0) return { offset: 0, firstGame: 1, current: 1, nexts: a.restored.map(() => 1), clamped: [] };
  const N = a.finished ?? K - 1;
  if (a.finished !== undefined && a.finished > K) {
    logger.warn(`resume: PGN has ${a.finished} finished games but the log only ${K} starts (misaligned PGN?)`);
  }
  const current = N >= K ? K + 1 : K;
  const floor = Math.max(1, current - MAX_REPLAY_GAMES);
  const clamped: number[] = [];
  const nexts = a.restored.map((n, i) => {
    if (n === undefined || !Number.isInteger(n) || n < 1 || n > K + 1) return current;
    if (n < floor) {
      clamped.push(i);
      return floor;
    }
    return n;
  });
  const S = Math.min(current, ...nexts);
  // Game 1 starts at offset 0 so any preamble before its first `ucinewgame` is replayed too.
  const offset = S === 1 ? 0 : S <= K ? a.starts[S - 1] : a.end;
  return { offset, firstGame: S, current, nexts, clamped };
}

/** `CTRESET` + a `recent = 1` crosstable of the games before `g`, or null when there are none. */
export function numberingDump(games: readonly FinishedGame[], g: number): string[] | null {
  const prior = games.filter((x) => x.number < g);
  if (prior.length === 0) return null;
  const newest = Math.max(...prior.map((x) => x.number));
  if (newest !== g - 1) logger.warn(`resume: numbering for game ${g}: newest finished is ${newest} (PGN behind log?)`);
  return [P.CTRESET, ...renderCrosstable(prior, 1).map(P.ct)];
}

/** The slice of TlcsServer that ResumeSink drives. */
export interface ResumeServer extends BroadcastSink {
  addClient(ip: string, port: number, user: string): boolean;
  getClient(dest: string): unknown;
  enqueue(dest: string | null, body: string, opts?: { holdMs?: number }): void;
  currentEpoch(): number;
}

export interface ResumeStore {
  mapEpoch(epoch: number, game: number): void;
}

/** Queue a numbering dump for one client; the last line holds NUMBERING_HOLD_MS. */
export function enqueueDump(server: Pick<ResumeServer, 'enqueue'>, dest: string, b: string[]): void {
  b.forEach((body, i) => server.enqueue(dest, body, i === b.length - 1 && NUMBERING_HOLD_MS > 0 ? { holdMs: NUMBERING_HOLD_MS } : {}));
}

type Lazy = number | (() => number);
const resolve = (v: Lazy): number => (typeof v === 'function' ? v() : v);

/**
 * BroadcastSink between PacedSink and TlcsServer. Counts games (so each epoch maps to a game
 * number for the StateStore) and, during the synchronous startup catch-up, attaches each
 * restored client right before its resume game and queues a numbering dump ahead of every
 * replayed game, so node-tlcv saves each replayed result under the right number.
 */
export class ResumeSink implements BroadcastSink {
  private counter = 0;
  private first: Lazy = 1;
  private current: Lazy = 1;
  private pipelineGame: () => number = () => 0;
  private pending: Array<PersistedClient & { next: number }> = [];
  private attached: string[] = [];
  private catching = false;
  private warnedNoRegistry = false;

  constructor(
    private readonly server: ResumeServer,
    private readonly store?: ResumeStore,
    private readonly registry?: { games: readonly FinishedGame[]; refresh(): void },
  ) {}

  begin(first: Lazy, pending: Array<PersistedClient & { next: number }>, current: Lazy, pipelineGame: () => number): void {
    this.first = first;
    this.counter = 0;
    this.current = current;
    this.pending = pending;
    this.attached = [];
    this.pipelineGame = pipelineGame;
    this.catching = true;
  }

  setSite(site: string): void {
    this.server.setSite(site);
  }

  setPlayers(white: string, black: string): void {
    if (this.counter === 0) this.counter = resolve(this.first);
    const g = this.counter++;
    if (this.catching) {
      const p = this.pipelineGame();
      if (g !== p) logger.warn(`resume: game counter ${g} != pipeline ${p}; epoch->game map may be wrong`);
      const rest: typeof this.pending = [];
      for (const c of this.pending) {
        if (c.next <= g) this.attach(c, g);
        else rest.push(c);
      }
      this.pending = rest;
      for (const d of this.attached) this.sendNumbering(d, g);
    }
    this.server.setPlayers(white, black);
    this.store?.mapEpoch(this.server.currentEpoch(), g);
  }

  emitInitialPosition(fenTruncated: string, fmr: number): void {
    this.server.emitInitialPosition(fenTruncated, fmr);
  }
  emitMove(args: { fenTruncated: string; color: ColorCode; fullMoveNumber: number; san: string; fmr: number }): void {
    this.server.emitMove(args);
  }
  emitClocks(whiteCs: number, blackCs: number): void {
    this.server.emitClocks(whiteCs, blackCs);
  }
  emitPv(color: ColorCode, depth: number, scoreCp: number, timeCs: number, nodes: number, pv: string[], info: UciInfo): void {
    this.server.emitPv(color, depth, scoreCp, timeCs, nodes, pv, info);
  }
  emitResult(result: string, gameNumber?: number): void {
    this.server.emitResult(result, gameNumber);
  }
  emitLevel(text: string): void {
    this.server.emitLevel?.(text);
  }

  /** The catch-up read to EOF: attach every client not yet attached, with a dump for the current game. */
  finishCatchUp(): void {
    const cur = resolve(this.current);
    for (const c of this.pending) {
      this.attach(c, cur);
      this.sendNumbering(`${c.ip}:${c.port}`, cur);
    }
    this.pending = [];
    this.catching = false;
  }

  /** Games attached so far this catch-up (for the startup log line). */
  attachedCount(): number {
    return this.attached.length;
  }

  private attach(c: PersistedClient, g: number): void {
    const dest = `${c.ip}:${c.port}`;
    if (!this.server.getClient(dest)) this.server.addClient(c.ip, c.port, c.user);
    this.attached.push(dest);
    logger.info(`resume: attached ${c.user}@${dest} at game ${g}`);
  }

  private sendNumbering(dest: string, g: number): void {
    if (!this.registry) {
      if (!this.warnedNoRegistry) {
        this.warnedNoRegistry = true;
        logger.warn('resume: no registry; node-tlcv numbering not restored');
      }
      return;
    }
    const b = numberingDump(this.registry.games, g);
    if (!b) return;
    enqueueDump(this.server, dest, b);
    logger.info(`resume: numbering dump -> ${dest} before game ${g} (newest ${g - 1}, ${b.length} lines)`);
  }
}

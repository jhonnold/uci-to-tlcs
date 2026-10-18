import { parseLine, type GoEvent, type PositionEvent } from './uci/parser.js';
import { scoreToCentipawns, type UciInfo } from './uci/info.js';
import { GameState, STARTPOS_TRUNC } from './game/game-state.js';
import { msToCs, type ColorCode } from './tlcs/protocol.js';
import type { NormalizedLine } from './source/log-source.js';
import type { FinishedGame } from './results/registry.js';
import { logger } from './util/logger.js';

/**
 * Everything the pipeline emits. Implemented by TlcsServer for the real UDP
 * broadcast, and by a fake in tests so the conversion logic can be checked
 * without any sockets.
 */
export interface BroadcastSink {
  setSite(site: string): void;
  setPlayers(white: string, black: string): void;
  emitInitialPosition(fenTruncated: string, fmr: number): void;
  emitMove(args: {
    fenTruncated: string;
    color: ColorCode;
    fullMoveNumber: number;
    san: string;
    fmr: number;
  }): void;
  emitClocks(whiteCs: number, blackCs: number): void;
  emitPv(color: ColorCode, depth: number, scoreCp: number, timeCs: number, nodes: number, sanPv: string[]): void;
  emitResult(result: string): void;
  /** WinBoard-format `level <mps> <base> <inc>` text. Optional: absent until the server supports it. */
  emitLevel?(text: string): void;
}

/** Source of authoritative results (the tournament PGN), keyed by 1-based game number. */
export interface ResultAuthority {
  lookup(n: number): FinishedGame | undefined;
  refresh(): unknown;
}

export interface PipelineOpts {
  authority?: ResultAuthority;
  /** Number of the first game seen; a function is resolved lazily at the first game open. */
  firstGameNumber?: number | (() => number);
  /** Registry polls a board-terminal game waits for its PGN entry before using the board result. */
  holdTicks?: number;
  /** Min ms between PV conversions/emits per game (latest-wins coalescing). 0 = convert every info. Default 200. */
  pvIntervalMs?: number;
}

/** Latest raw PV info awaiting conversion; tagged so a stale one is never converted against a different board. */
interface PendingPv {
  info: UciInfo;
  color: ColorCode;
  seq: number;
  ply: number;
}

const DEFAULT_PV_INTERVAL_MS = 200;

export interface PipelineMeta {
  white: string;
  black: string;
  site: string;
  /** Non-startpos games: precede the base FEN with a synthetic `(setup)` move so node-tlcv loads it. Default true. */
  fenSetupMove?: boolean;
}

/**
 * Synthetic SAN for the setup move. node-tlcv's `onMove` fails to apply it in chess.js and
 * its catch runs `resetFromFen()`, which loads the preceding `FEN` header onto a board that
 * is already loaded (a bare non-startpos FEN is otherwise only stored as a backup). Desktop
 * TLCV appends move text unvalidated, so it shows `1. (setup)` once; its board is correct.
 */
const SETUP_SAN = '(setup)';

/** PGN result token for an unfinished/adjudicated game (no board-terminal result). */
const RESULT_UNKNOWN = '*';

/** Default side names (config.ts); `id name` fallback only overrides these. */
const DEFAULT_WHITE = 'White';
const DEFAULT_BLACK = 'Black';

/**
 * Drives a UCI transcript into TLCS broadcast calls. Owns the authoritative board
 * and segments the stream into successive games (a single log can hold many games
 * and many matchups, rendered sequentially on one node-tlcv board).
 *
 * Two input modes, distinguished by whether the {@link NormalizedLine} carries
 * engine identity + direction (a tagged producer like fastchess) or not (a bare
 * stripped transcript):
 *
 * - **Tagged**: the engine receiving the first `go` plays the side to move of its
 *   `position` (fastchess sends the first `go` to the side to move); the other
 *   `ucinewgame` participant plays the other colour. Both are known
 *   before move 1, which matters because node-tlcv wipes shown moves if WPLAYER/
 *   BPLAYER arrive after a move. Player + initial-FEN emission is deferred to the
 *   first `go` so both names land first.
 * - **Untagged**: no name binding — falls back to CLI names (`id name` fills the
 *   defaults for the first game only); the header is emitted at the first position.
 *
 * Per-game emit order: (synthesized `result: *` for the previous game if it ended
 * without a board result) → WPLAYER → BPLAYER → base position (startpos FEN+FMR; for a
 * non-startpos base also FEN X+FMR and the `(setup)` move) → opening/book moves → `level`
 * (first `go`) → moves.
 */
export class Pipeline {
  private readonly site: string;

  // Run-level state (persists across games).
  private tagged = false; // latched once any line carries a direction
  private siteEmitted = false;
  private firstHeaderEmitted = false;
  private idNames: string[] = []; // untagged-fallback naming only
  private fallbackWhite: string;
  private fallbackBlack: string;

  // Per-game board state (reset at every game boundary).
  private game = new GameState();
  private positionEmitted = false;
  private resultEmitted = false;
  private gameActive = false; // a game's header has been emitted and not yet closed
  private pendingHeader = true; // players + initial FEN still owed for the current game
  private currentMoves: string[] = []; // coordinate moves applied, for reset detection
  private openingMoves: string[] = []; // book / pre-join prefix, replayed after the base position
  private levelPending = false; // emit `level` at the next tagged `go`

  // Per-game colour binding (tagged path).
  private participants = new Set<string>(); // engineIds seen via `ucinewgame`
  private collectingParticipants = false;
  private awaitingFirstGo = false;
  private firstGoId?: string; // engine that got the first `go`
  private firstGoStm: ColorCode = 'w'; // side to move at that engine's `position`
  private positionStm?: ColorCode; // side to move after the latest game-start `position`
  private whiteId?: string;
  private blackId?: string;
  private readonly fenSetupMove: boolean;

  // PV coalescing: only the latest info is kept; converted at most every pvIntervalMs, and always before a move.
  private readonly pvIntervalMs: number;
  private pendingPv?: PendingPv;
  private lastPvAt = -Infinity;
  private pvTimer?: ReturnType<typeof setTimeout>;
  private gameSeq = 0;

  // PGN-authority state (inert without an authority).
  private gameNumber = 0;
  private numbered = false;
  private gameNumberBase?: number;
  private heldTicks = 0;
  private holdWarned = false;
  private emittedEntry?: FinishedGame;
  private boundNames?: [string, string]; // names sent in this game's header (tagged/bound only)
  private overrunWarned = false;

  constructor(
    private sink: BroadcastSink,
    meta: PipelineMeta,
    private opts: PipelineOpts = {},
  ) {
    this.site = meta.site;
    this.fallbackWhite = meta.white;
    this.fallbackBlack = meta.black;
    this.fenSetupMove = meta.fenSetupMove ?? true;
    this.pvIntervalMs = opts.pvIntervalMs ?? DEFAULT_PV_INTERVAL_MS;
  }

  /** Drop any pending PV and its timer. Call before discarding this Pipeline (e.g. a session swap). */
  close(): void {
    this.clearPendingPv();
  }

  private clearPendingPv(): void {
    this.pendingPv = undefined;
    if (this.pvTimer) clearTimeout(this.pvTimer);
    this.pvTimer = undefined;
  }

  handleLine(n: NormalizedLine): void {
    if (n.direction !== undefined) this.tagged = true;

    // `ucinewgame` parses to null, so handle it from the raw payload. Tagged only:
    // it marks a new game's setup and identifies a participant before any move.
    if (n.direction === 'in' && n.uci && n.uci.trim() === 'ucinewgame') {
      this.onUciNewGame(n.engineId);
      return;
    }
    if (n.direction === 'in' && n.uci?.trim() === 'quit') {
      this.onQuit();
      return;
    }

    const ev = n.uci ? parseLine(n.uci) : null;
    if (!ev) return;

    switch (ev.type) {
      case 'idName':
        this.onIdName(ev.name);
        break;
      case 'position':
        this.onPosition(ev);
        break;
      case 'go':
        this.onGo(ev, n);
        break;
      case 'info':
        this.onInfo(ev.info, n);
        break;
      case 'bestmove':
        this.onBestMove(ev.move);
        break;
    }
  }

  // --------------------------------------------------------------- segmentation

  private onUciNewGame(engineId: string | undefined): void {
    // The first `ucinewgame` of a pair opens a new game's setup; the rest just add
    // participants. Closing out the previous game (board reset + synthesized result)
    // happens here so it precedes the new game's players.
    if (!this.collectingParticipants) {
      this.collectingParticipants = true;
      this.participants.clear();
      this.whiteId = undefined;
      this.blackId = undefined;
      this.firstGoId = undefined;
      this.positionStm = undefined;
      this.awaitingFirstGo = true;
      this.beginNewGame();
      this.openGameNumber();
    }
    if (engineId) this.participants.add(engineId);
    this.maybeBindColours();
  }

  /**
   * Bind colours and emit the game header once the first-`go` engine and exactly one other
   * participant are known. The first-`go` engine takes the side to move recorded at its
   * `position`; the other participant takes the other colour. Called both after a
   * participant joins (`ucinewgame`) and after the first `go`, so it fires whichever comes
   * last: fastchess batches both
   * `ucinewgame`s before the first `go` (binds at `go`); myracle inits engines one at a
   * time, so the second participant's `ucinewgame` can arrive *after* the first `go`
   * (binds there). Deferring the header until both names are known upholds node-tlcv's
   * resetMoves invariant (a move shown before WPLAYER/BPLAYER is wiped); `onBestMove`
   * is the backstop if a producer never reveals the second participant.
   */
  private maybeBindColours(): void {
    if (!this.firstGoId || (this.whiteId && this.blackId)) return;
    const others = [...this.participants].filter((id) => id !== this.firstGoId);
    if (others.length !== 1) return;
    [this.whiteId, this.blackId] =
      this.firstGoStm === 'b' ? [others[0], this.firstGoId] : [this.firstGoId, others[0]];
    this.collectingParticipants = false;
    this.awaitingFirstGo = false;
    this.emitGameHeaderIfReady();
  }

  /** Close out the previous game and reset per-game state for a fresh one. */
  private beginNewGame(): void {
    // PGN entry if configured, else adjudication / unknown end: synthesize so
    // node-tlcv finalizes + re-arms.
    this.closeAtBoundary('boundary');
    this.numbered = false;
    this.heldTicks = 0;
    this.holdWarned = false;
    this.emittedEntry = undefined;
    this.overrunWarned = false;
    this.boundNames = undefined;
    this.gameSeq++;
    this.clearPendingPv();
    this.game.reset();
    this.positionEmitted = false;
    this.resultEmitted = false;
    this.gameActive = false;
    this.pendingHeader = true;
    this.currentMoves = [];
  }

  /** Is this `position` the start of a NEW game (not a continuation of the current)? */
  private isGameReset(ev: PositionEvent): boolean {
    return !isPrefixExtension(this.currentMoves, ev.moves);
  }

  private onPosition(ev: PositionEvent): void {
    // Untagged path detects boundaries here (tagged path already did at `ucinewgame`).
    if (this.gameActive && this.isGameReset(ev)) this.beginNewGame();

    // Same base and moves as the live game: the rebuild would reproduce the current board
    // (fastchess resends the full move list every ply), so skip the O(n) replay.
    if (this.gameActive && this.game.sameBase(ev.startpos, ev.fen) && sameMoves(this.currentMoves, ev.moves)) {
      this.positionStm = this.game.turn();
      return;
    }

    // Forward extension of the live game: a producer may reveal a move in the *next*
    // engine's `position` command before that engine logs its own `bestmove` (myracle
    // feeds the opponent its reply first). Apply & emit each newly-revealed move so it
    // isn't lost — its later `bestmove` is deduplicated in onBestMove. (The final move
    // of a game gets no following `position`, so `bestmove` stays its emit path.)
    if (
      this.gameActive &&
      ev.startpos &&
      ev.moves.length > this.currentMoves.length &&
      isPrefixExtension(this.currentMoves, ev.moves)
    ) {
      for (const m of ev.moves.slice(this.currentMoves.length)) this.applyAndEmit(m);
      return;
    }

    if (!this.game.setPosition(ev.startpos, ev.fen, ev.moves)) return; // validates the whole line
    this.clearPendingPv(); // board replaced: a pending PV no longer matches it
    this.positionStm = this.game.turn();
    if (!this.gameActive) {
      // Game start: rewind to the base; the prefix (book / pre-join moves) is replayed at
      // header time so clients see the moves, not just the post-book position.
      this.game.setPosition(ev.startpos, ev.fen, []);
      this.openingMoves = ev.moves.slice();
      this.currentMoves = [];
    } else {
      this.currentMoves = ev.moves.slice();
    }

    // Untagged: emit the header now (nothing to wait for). Tagged: defer to `go`.
    if (!this.tagged) this.emitGameHeaderIfReady();
  }

  private onGo(ev: GoEvent, n: NormalizedLine): void {
    // First `go` to an engine after a reset: that engine plays the side to move of its
    // `position`. Colours + the header are bound by maybeBindColours once the other
    // participant is known — which, for a sequential-init producer (myracle), can be after
    // this first `go`.
    if (this.awaitingFirstGo && n.direction === 'in' && n.engineId) {
      this.firstGoId = n.engineId;
      this.firstGoStm = this.positionStm ?? 'w';
      this.awaitingFirstGo = false;
      this.maybeBindColours();
    }

    if (this.levelPending && this.gameActive && this.tagged) {
      this.levelPending = false;
      const lvl = formatLevel(ev, this.game.turn());
      if (lvl) this.sink.emitLevel?.(lvl);
    }

    if (ev.wtimeMs !== undefined && ev.btimeMs !== undefined) {
      this.sink.emitClocks(msToCs(ev.wtimeMs), msToCs(ev.btimeMs));
    }
  }

  // --------------------------------------------------------------- naming

  private onIdName(name: string): void {
    // Untagged-fallback naming: only fills a side left at its CLI default, and only
    // before the first game's header is sent (engines handshake once per process).
    this.idNames.push(name);
    if (this.firstHeaderEmitted) return;
    if (this.idNames.length === 1 && this.fallbackWhite === DEFAULT_WHITE) this.fallbackWhite = name;
    else if (this.idNames.length === 2 && this.fallbackBlack === DEFAULT_BLACK) this.fallbackBlack = name;
  }

  private resolveNames(): [string, string] {
    if (this.whiteId && this.blackId) return [this.whiteId, this.blackId];
    return [this.fallbackWhite, this.fallbackBlack];
  }

  // --------------------------------------------------------------- emission

  private emitGameHeaderIfReady(): void {
    if (!this.pendingHeader) return;
    this.openGameNumber();

    if (!this.siteEmitted) {
      this.sink.setSite(this.site);
      this.siteEmitted = true;
    }

    const [white, black] = this.resolveNames();
    this.boundNames = this.whiteId && this.blackId ? [white, black] : undefined;
    this.sink.setPlayers(white, black);
    this.emitBasePosition();

    this.pendingHeader = false;
    this.positionEmitted = true;
    this.firstHeaderEmitted = true;
    this.gameActive = true;

    const opening = this.openingMoves;
    this.openingMoves = [];
    for (const m of opening) this.applyAndEmit(m); // no PV before → node-tlcv tags "(Book)"
    this.levelPending = true;
  }

  /** The game's base position: plain FEN, or startpos reset + FEN + setup move (see SETUP_SAN). */
  private emitBasePosition(): void {
    const fen = this.game.fenTruncated();
    const fmr = this.game.halfmoveClock();
    if (fen === STARTPOS_TRUNC || !this.fenSetupMove) {
      this.sink.emitInitialPosition(fen, fmr);
      return;
    }
    this.sink.emitInitialPosition(STARTPOS_TRUNC, 0); // node-tlcv reset()
    this.sink.emitInitialPosition(fen, fmr); // stored as the backup FEN + fmr
    this.sink.emitMove({
      fenTruncated: fen,
      color: this.game.turn(),
      fullMoveNumber: this.game.fullMoveNumber(),
      san: SETUP_SAN,
      fmr,
    }); // fails in chess.js → resetFromFen() loads the FEN
  }

  private onInfo(info: UciInfo, n: NormalizedLine): void {
    if (!this.gameActive) return;
    if (n.direction === 'in') return; // engine info is 'out'; an 'in' line would be a GUI echo
    // Stale-PV guard: drop info from the engine that is not on move.
    if (
      n.engineId &&
      this.whiteId &&
      this.blackId &&
      n.engineId !== (this.game.turn() === 'w' ? this.whiteId : this.blackId)
    ) {
      return;
    }
    if (info.multipv !== 1) return; // only the primary line is the broadcast eval

    // Latest-wins: only the newest info per move is ever converted (PVs are unnumbered, latest-only).
    this.pendingPv = { info, color: this.game.turn(), seq: this.gameSeq, ply: this.currentMoves.length };
    const wait = this.lastPvAt + this.pvIntervalMs - Date.now();
    if (wait <= 0) {
      this.flushPv();
    } else if (!this.pvTimer) {
      this.pvTimer = setTimeout(() => {
        this.pvTimer = undefined;
        try {
          this.flushPv();
        } catch (err) {
          logger.warn(`PV flush failed: ${String(err)}`);
        }
      }, wait);
      this.pvTimer.unref();
    }
  }

  /** Convert + emit the pending PV against the current board, unless the board has moved on. */
  private flushPv(): void {
    const p = this.pendingPv;
    if (!p) return;
    this.pendingPv = undefined;
    if (p.seq !== this.gameSeq || p.ply !== this.currentMoves.length || !this.gameActive) return;
    const info = p.info;
    const scoreCp = scoreToCentipawns(info); // side-to-move (engine) POV, matching TLCS
    const sanPv = this.game.playoutPvToSan(info.pv);
    if (sanPv.length === 0) return;
    this.lastPvAt = Date.now();
    this.sink.emitPv(p.color, info.depth, Math.round(scoreCp), msToCs(info.timeMs), info.nodes, sanPv);
  }

  /** Apply one coordinate move to the authoritative board and broadcast it (+ result). */
  private applyAndEmit(move: string): void {
    this.flushPv(); // the mover's final PV goes out before its move (§9.7), against the pre-move board
    const applied = this.game.applyMove(move);
    if (!applied) return;
    this.currentMoves.push(move);

    this.sink.emitMove({
      fenTruncated: this.game.fenTruncated(),
      color: applied.color,
      fullMoveNumber: applied.fullMoveNumber,
      san: applied.san,
      fmr: this.game.halfmoveClock(),
    });

    this.maybeEmitResult();
  }

  private onBestMove(move: string | null): void {
    // Defensive: guarantee the header (players) precedes the first move even if the
    // `go` that should have triggered it lacked a tagged engineId.
    this.emitGameHeaderIfReady();

    if (move === null) {
      this.maybeEmitResult();
      return;
    }

    // A `position` command may have already revealed (and emitted) this move — myracle
    // logs the opponent's `position` feed before the engine's own `bestmove`. Skip the
    // duplicate; consecutive plies can never share from/to coordinates, so this is safe.
    if (this.currentMoves[this.currentMoves.length - 1] === move) return;

    this.applyAndEmit(move);
  }

  private maybeEmitResult(): void {
    if (this.opts.authority) {
      this.pgnGate();
      return;
    }
    if (this.resultEmitted || !this.game.isGameOver()) return;
    const r = this.game.result();
    if (r) this.emitResultOnce(r);
  }

  // --------------------------------------------------------------- PGN authority

  /** The single `sink.emitResult` call site: a game can never get two results. */
  private emitResultOnce(r: string): void {
    if (this.resultEmitted) return;
    this.resultEmitted = true;
    this.sink.emitResult(r);
  }

  currentGameNumber(): number {
    return this.gameNumber;
  }

  private openGameNumber(): void {
    if (this.numbered) return;
    if (this.gameNumberBase === undefined) {
      const f = this.opts.firstGameNumber ?? 1;
      this.gameNumber = typeof f === 'function' ? f() : f;
      this.gameNumberBase = this.gameNumber;
    } else {
      this.gameNumber += 1;
    }
    this.numbered = true;
  }

  /** Plies the entry's PlyCount implies were played on the board (illegal move: not applied). */
  private targetPlies(e: FinishedGame): number | undefined {
    if (e.plyCount === undefined) return undefined;
    return e.termination === 'illegal move' ? e.plyCount - 1 : e.plyCount;
  }

  /** PGN names equal the bound names as an unordered set (true when names are not bound). */
  private namesMatchLoosely(e: FinishedGame): boolean {
    if (!this.boundNames) return true;
    const [w, b] = this.boundNames;
    return (e.white === w && e.black === b) || (e.white === b && e.black === w);
  }

  /** Emit the PGN result as soon as the game's plies reach the entry's PlyCount. */
  private pgnGate(): void {
    const auth = this.opts.authority;
    if (!auth || !this.gameActive) return;
    if (this.resultEmitted) {
      this.warnOverrun();
      return;
    }
    const e = auth.lookup(this.gameNumber);
    if (!e || !this.namesMatchLoosely(e)) return;
    const target = this.targetPlies(e);
    if (target === undefined || this.currentMoves.length < target) return;
    this.checkEntry(e, false);
    this.emittedEntry = e;
    this.emitResultOnce(e.result);
  }

  private warnOverrun(): void {
    const e = this.emittedEntry;
    if (!e || this.overrunWarned) return;
    const target = this.targetPlies(e);
    if (target !== undefined && this.currentMoves.length > target) {
      this.overrunWarned = true;
      logger.warn(`game ${this.gameNumber}: ${this.currentMoves.length} plies exceed PGN PlyCount ${e.plyCount} (misaligned PGN?)`);
    }
  }

  private checkEntry(e: FinishedGame, atBoundary: boolean): void {
    if (this.boundNames && (e.white !== this.boundNames[0] || e.black !== this.boundNames[1])) {
      const [w, b] = this.boundNames;
      logger.warn(`game ${this.gameNumber}: PGN names "${e.white}" vs "${e.black}" differ from log "${w}" vs "${b}"`);
    }
    const target = this.targetPlies(e);
    const plies = this.currentMoves.length;
    if (target !== undefined && plies > target) {
      logger.warn(`game ${this.gameNumber}: ${plies} plies exceed PGN PlyCount ${e.plyCount} (misaligned PGN?)`);
      this.overrunWarned = true;
    } else if (atBoundary && target !== undefined && plies < target) {
      logger.warn(`game ${this.gameNumber}: only ${plies} plies seen, PGN PlyCount ${e.plyCount}`);
    }
  }

  /**
   * Final chance to close a game: pull the PGN once, send its entry if present.
   * `boundary` (next game opens) falls back to the board result / `*`; `quit` does not.
   * Without an authority this is the legacy synthesized `*`.
   */
  private closeAtBoundary(kind: 'boundary' | 'quit'): void {
    if (!this.gameActive || this.resultEmitted) return;
    const auth = this.opts.authority;
    if (!auth) {
      if (kind === 'boundary') this.emitResultOnce(RESULT_UNKNOWN);
      return;
    }
    auth.refresh();
    const e = auth.lookup(this.gameNumber);
    if (e) {
      this.checkEntry(e, true);
      this.emittedEntry = e;
      this.emitResultOnce(e.result);
      return;
    }
    if (kind === 'quit') return;
    const r = this.game.isGameOver() ? this.game.result() : null;
    logger.warn(`no PGN entry for game ${this.gameNumber}; fallback ${r ?? RESULT_UNKNOWN}`);
    this.emitResultOnce(r ?? RESULT_UNKNOWN);
  }

  private onQuit(): void {
    this.clearPendingPv();
    this.closeAtBoundary('quit');
  }

  /** Called after every PGN registry poll. */
  onAuthorityTick(): void {
    if (!this.opts.authority) return;
    this.pgnGate();
    if (!this.gameActive || this.resultEmitted || !this.game.isGameOver()) return;
    const r = this.game.result();
    if (!r) return;
    this.heldTicks++;
    if (this.heldTicks >= (this.opts.holdTicks ?? 10)) {
      if (!this.holdWarned) {
        this.holdWarned = true;
        logger.warn(`PGN entry for game ${this.gameNumber} not seen after ${this.heldTicks} polls; using board result ${r}`);
      }
      this.emitResultOnce(r);
    }
  }
}

function sameMoves(a: string[], b: string[]): boolean {
  return a.length === b.length && isPrefixExtension(a, b);
}

/** Is `next` equal to `prev` followed by zero or more additional moves? */
function isPrefixExtension(prev: string[], next: string[]): boolean {
  if (next.length < prev.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (next[i] !== prev[i]) return false;
  }
  return true;
}

/**
 * WinBoard `level <mps> <base> <inc>` from a clock-bearing `go`. fastchess adds the
 * increment before the first move, so base = time − inc. Undefined unless both clocks are
 * present and equal (a fresh game).
 */
export function formatLevel(ev: GoEvent, stm: ColorCode): string | undefined {
  if (ev.wtimeMs === undefined || ev.btimeMs === undefined || ev.wtimeMs !== ev.btimeMs) return undefined;
  const incMs = (stm === 'w' ? ev.wincMs : ev.bincMs) ?? 0;
  let baseMs = ev.wtimeMs - incMs;
  if (baseMs <= 0) baseMs = ev.wtimeMs;
  return `${ev.movestogo ?? 0} ${formatBase(baseMs)} ${incMs / 1000}`;
}

function formatBase(ms: number): string {
  if (ms % 60000 === 0) return String(ms / 60000);
  const m = Math.floor(ms / 60000);
  const sec = (ms % 60000) / 1000;
  const [whole, frac] = sec.toFixed(3).split('.');
  const f = frac.replace(/0+$/, '');
  return `${m}:${whole.padStart(2, '0')}${f ? '.' + f : ''}`;
}

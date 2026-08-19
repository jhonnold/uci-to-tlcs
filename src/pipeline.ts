import { parseLine, type GoEvent, type PositionEvent } from './uci/parser.js';
import { scoreToCentipawns, type UciInfo } from './uci/info.js';
import { GameState } from './game/game-state.js';
import { msToCs, type ColorCode } from './tlcs/protocol.js';
import type { NormalizedLine } from './source/log-source.js';
import type { PgnGame } from './pgn.js';

/**
 * Everything the pipeline emits. Implemented by TlcsServer for the real UDP
 * broadcast, and by a fake in tests so the conversion logic can be checked
 * without any sockets.
 */
export interface BroadcastSink {
  setSite(site: string): void;
  setPlayers(white: string, black: string): void;
  emitInitialPosition(fenTruncated: string, fmr: number): void;
  /**
   * The board is already mid-game (bridge started partway into a game): publish
   * the current position so late joiners get the board, without announcing a move.
   * Same wire effect as emitInitialPosition.
   */
  emitCurrentPosition(fenTruncated: string, fmr: number): void;
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
}

export interface PipelineMeta {
  white: string;
  black: string;
  site: string;
  /**
   * Number of the first game in this run (the PGN file's finished count + 1).
   * Finished live games are numbered sequentially from here so they merge with
   * the file's games by number.
   */
  gameNumber?: number;
  /** Fired once per game, when its header is emitted, with that game's number. */
  onGameStart?: (gameNumber: number) => void;
}

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
 * - **Tagged**: each game's White is the engine that receives `position startpos`
 *   + the first `go`; Black is the other `ucinewgame` participant. Both are known
 *   before move 1, which matters because node-tlcv wipes shown moves if WPLAYER/
 *   BPLAYER arrive after a move. Player + initial-FEN emission is deferred to the
 *   first `go` so both names land first.
 * - **Untagged**: no name binding — falls back to CLI names (`id name` fills the
 *   defaults for the first game only); the header is emitted at the first position.
 *
 * **Mid-game start** (the first `position` seen for a game already carries moves,
 * e.g. `--from-end`): the current position is published immediately so clients
 * joining mid-game have the board, and on tagged input the side-to-move's colour
 * is pre-bound by move-count parity (even = White). The other colour binds as
 * soon as the second engine's identity appears (its `go`); if the first
 * `bestmove` beats that, the header goes out with fallback names and the real
 * names are re-sent when the bind completes. If the stream opens with an orphan
 * `bestmove` (its `position` was written before startup), it is skipped until the
 * first real `position` triggers the resync.
 *
 * Per-game emit order: (synthesized `result: *` for the previous game if it ended
 * without a board result) → WPLAYER → BPLAYER → startpos FEN (+FMR) → moves.
 * Every finished game is recorded (names + result) for the PGN merge.
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
  private positionSeen = false; // a `position` has been applied for the current game
  private positionEmitted = false;
  private resultEmitted = false;
  private gameActive = false; // a game's header has been emitted and not yet closed
  private pendingHeader = true; // players + initial FEN still owed for the current game
  private currentMoves: string[] = []; // coordinate moves applied, for reset detection

  // Per-game colour binding (tagged path).
  private participants = new Set<string>(); // engineIds seen via `ucinewgame` or a tagged `go`
  private collectingParticipants = false;
  private awaitingFirstGo = false;
  private whiteId?: string;
  private blackId?: string;

  // Finished-games record (for the PGN merge) + game numbering.
  private finished: { white: string; black: string; result: string }[] = [];
  private lastResult?: string;
  private firstGameNumber: number;

  private onGameStart?: (gameNumber: number) => void;

  constructor(private sink: BroadcastSink, meta: PipelineMeta) {
    this.site = meta.site;
    this.fallbackWhite = meta.white;
    this.fallbackBlack = meta.black;
    this.firstGameNumber = meta.gameNumber ?? 1;
    this.onGameStart = meta.onGameStart;
  }

  handleLine(n: NormalizedLine): void {
    if (n.direction !== undefined) this.tagged = true;

    // `ucinewgame` parses to null, so handle it from the raw payload. Tagged only:
    // it marks a new game's setup and identifies a participant before any move.
    if (n.direction === 'in' && n.uci && n.uci.trim() === 'ucinewgame') {
      this.onUciNewGame(n.engineId);
      return;
    }

    const ev = n.uci ? parseLine(n.uci) : null;
    if (!ev) return;

    switch (ev.type) {
      case 'idName':
        this.onIdName(ev.name);
        break;
      case 'position':
        this.onPosition(ev, n);
        break;
      case 'go':
        this.onGo(ev, n);
        break;
      case 'info':
        this.onInfo(ev.info);
        break;
      case 'bestmove':
        this.onBestMove(ev.move);
        break;
    }
  }

  // --------------------------------------------------------------- segmentation

  private onUciNewGame(engineId: string | undefined): void {
    // The first `ucinewgame` of a pair opens a new game's setup; the rest just add
    // participants. Closing out the previous game (record + synthesized result) must
    // happen BEFORE the old colour binding is cleared, so it records the right names.
    if (!this.collectingParticipants) {
      this.beginNewGame();
      this.collectingParticipants = true;
      this.participants.clear();
      this.whiteId = undefined;
      this.blackId = undefined;
      this.awaitingFirstGo = true;
    }
    if (engineId) this.participants.add(engineId);
    this.maybeBindPlayers();
  }

  /**
   * Bind the missing colour and emit the game header once one side is known and
   * exactly one other participant exists. Whichever event lands last fires it:
   * fastchess batches both `ucinewgame`s before the first `go` (binds at `go`);
   * myracle inits engines one at a time, so the second participant's `ucinewgame`
   * can arrive *after* White's `go` (binds there); a mid-game resync pre-binds one
   * colour by parity and binds the other at the second engine's first `go`.
   * Deferring the header until both names are known upholds node-tlcv's resetMoves
   * invariant (a move shown before WPLAYER/BPLAYER is wiped); `onBestMove` is the
   * backstop if a producer never reveals the second participant.
   */
  private maybeBindPlayers(): void {
    if (this.whiteId && this.blackId) return;
    const known = this.whiteId ?? this.blackId;
    if (!known) return; // which colour the first participant plays decides at the first `go` / parity
    const others = [...this.participants].filter((id) => id !== known);
    if (others.length !== 1) return;
    const white = this.whiteId ?? others[0];
    const black = this.blackId ?? others[0];
    this.whiteId = white;
    this.blackId = black;
    this.collectingParticipants = false;
    this.awaitingFirstGo = false;
    if (this.pendingHeader) {
      this.emitGameHeaderIfReady();
    } else {
      // The backstop already sent the header with fallback names (mid-game resync
      // race): correct them now that both are real. node-tlcv re-arms its move
      // list on the late WPLAYER/BPLAYER, restarting it at the join point.
      this.sink.setPlayers(white, black);
    }
  }

  /**
   * Close out the open game: record it (names + result) for the PGN merge, and
   * synthesize `result: *` if it ended without a board result so node-tlcv
   * finalizes + re-arms. Must run while the game's colour binding is still current.
   */
  private closeCurrentGame(): void {
    if (!this.gameActive) return;
    const result = this.lastResult ?? RESULT_UNKNOWN;
    if (!this.resultEmitted) this.sink.emitResult(result);
    this.resultEmitted = true;
    const [white, black] = this.resolveNames();
    this.finished.push({ white, black, result });
  }

  /** Close out the previous game and reset per-game state for a fresh one. */
  private beginNewGame(): void {
    this.closeCurrentGame();
    this.game.reset();
    this.positionSeen = false;
    this.positionEmitted = false;
    this.resultEmitted = false;
    this.lastResult = undefined;
    this.gameActive = false;
    this.pendingHeader = true;
    this.currentMoves = [];
  }

  /** Is this `position` the start of a NEW game (not a continuation of the current)? */
  private isGameReset(ev: PositionEvent): boolean {
    return !isPrefixExtension(this.currentMoves, ev.moves);
  }

  private onPosition(ev: PositionEvent, n: NormalizedLine): void {
    // Untagged path detects boundaries here (tagged path already did at `ucinewgame`).
    if (this.gameActive && this.isGameReset(ev)) this.beginNewGame();

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

    const midGameResync = !this.gameActive && ev.moves.length > 0;

    if (!this.game.setPosition(ev.startpos, ev.fen, ev.moves)) return;
    this.positionSeen = true;
    this.currentMoves = ev.moves.slice();

    if (midGameResync) {
      this.onMidGameResync(ev, n);
      return;
    }

    // Untagged: emit the header now (nothing to wait for). Tagged: defer to `go`.
    if (!this.tagged) this.emitGameHeaderIfReady();
  }

  /**
   * The first `position` seen for a game already carries moves — the bridge started
   * partway into a game (`--from-end`, restart). Publish the current position so
   * clients joining mid-game get the board, and on tagged input pre-bind the
   * side-to-move's colour by move-count parity (the `position` is addressed to the
   * engine about to move; an even move count means White to move). Parity needs a
   * `startpos`-based position; a `fen`-based one leaves names at the defaults.
   */
  private onMidGameResync(ev: PositionEvent, n: NormalizedLine): void {
    if (n.direction === 'in' && n.engineId && ev.startpos) {
      this.participants.add(n.engineId);
      this.collectingParticipants = true;
      // Parity, not `go`-order, decides White here: suppress the first-`go` binding.
      this.awaitingFirstGo = false;
      if (ev.moves.length % 2 === 0) this.whiteId = n.engineId;
      else this.blackId = n.engineId;
      this.maybeBindPlayers(); // binds the other side too if it is already known
    }
    if (this.tagged) {
      // Tagged: the header (names) is still owed; the position goes out now so a
      // client LOGONing during the gap already has the board.
      this.sink.emitCurrentPosition(this.game.fenTruncated(), this.game.halfmoveClock());
    } else {
      // Untagged: nothing to wait for — the header (CLI names) covers the position.
      this.emitGameHeaderIfReady();
    }
  }

  private onGo(ev: GoEvent, n: NormalizedLine): void {
    // First `go` to an engine after a reset binds that engine to White (suppressed
    // after a mid-game resync, where parity decides). A tagged `go` also registers
    // its engine as a participant — that is how the second colour binds in the
    // resync case, and how a sequential-init producer (myracle) can complete the
    // bind after the first `go`.
    if (n.direction === 'in' && n.engineId) {
      if (this.awaitingFirstGo) {
        this.whiteId = n.engineId;
        this.awaitingFirstGo = false;
      }
      if (this.collectingParticipants) {
        this.participants.add(n.engineId);
        this.maybeBindPlayers();
      }
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
    // A side bound by mid-game resync parity is real even while the other is still
    // owed; only unbound sides fall back to the CLI names.
    return [this.whiteId ?? this.fallbackWhite, this.blackId ?? this.fallbackBlack];
  }

  // --------------------------------------------------------------- emission

  private emitGameHeaderIfReady(): void {
    if (!this.pendingHeader) return;

    if (!this.siteEmitted) {
      this.sink.setSite(this.site);
      this.siteEmitted = true;
    }

    const [white, black] = this.resolveNames();
    this.sink.setPlayers(white, black);
    this.sink.emitInitialPosition(this.game.fenTruncated(), this.game.halfmoveClock());

    this.pendingHeader = false;
    this.positionEmitted = true;
    this.firstHeaderEmitted = true;
    this.gameActive = true;
    this.onGameStart?.(this.firstGameNumber + this.finished.length);
  }

  private onInfo(info: UciInfo): void {
    if (info.multipv !== 1) return; // only the primary line is the broadcast eval

    const color = this.game.turn(); // side to move = the thinking side
    const scoreCp = scoreToCentipawns(info); // side-to-move (engine) POV, matching TLCS
    const sanPv = this.game.playoutPvToSan(info.pv);
    if (sanPv.length === 0) return;

    this.sink.emitPv(color, info.depth, Math.round(scoreCp), msToCs(info.timeMs), info.nodes, sanPv);
  }

  /** Apply one coordinate move to the authoritative board and broadcast it (+ result). */
  private applyAndEmit(move: string): void {
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
    // Before the game's first `position` the board sits at startpos: any `bestmove`
    // here is orphaned (`--from-end` started between a `position` and its reply).
    // Skip it — letting it start the game would make the first real `position` take
    // the forward-extension path and replay the whole game instead of resyncing.
    if (!this.positionSeen) return;

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
    if (this.resultEmitted || !this.game.isGameOver()) return;
    const r = this.game.result();
    if (r) {
      this.sink.emitResult(r);
      this.resultEmitted = true;
      this.lastResult = r; // remembered so closeCurrentGame records the real result
    }
  }

  /**
   * This run's finished games, numbered from `meta.gameNumber`, for merging with
   * the PGN file's games (the file wins number collisions).
   */
  finishedGames(): PgnGame[] {
    return this.finished.map((g, i) => ({ number: this.firstGameNumber + i, ...g }));
  }

  /** Number of the current (or next) game in this run. */
  get currentGameNumber(): number {
    return this.firstGameNumber + this.finished.length;
  }
}

/** Is `next` equal to `prev` followed by zero or more additional moves? */
function isPrefixExtension(prev: string[], next: string[]): boolean {
  if (next.length < prev.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (next[i] !== prev[i]) return false;
  }
  return true;
}

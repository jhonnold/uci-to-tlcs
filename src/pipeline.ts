import { parseLine, type GoEvent, type PositionEvent } from './uci/parser.js';
import { scoreToCentipawns, type UciInfo } from './uci/info.js';
import { GameState } from './game/game-state.js';
import { msToCs, type ColorCode } from './tlcs/protocol.js';

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
}

export interface PipelineMeta {
  white: string;
  black: string;
  site: string;
}

/**
 * Drives the UCI transcript into TLCS broadcast calls. Owns the authoritative
 * board; translates each event to the matching wire message(s) with the unit and
 * perspective conversions the encoding map requires.
 */
export class Pipeline {
  private game = new GameState();
  private started = false;
  private positionEmitted = false;
  private resultEmitted = false;
  private idNames: string[] = [];
  private white: string;
  private black: string;

  constructor(
    private sink: BroadcastSink,
    private meta: PipelineMeta,
  ) {
    this.white = meta.white;
    this.black = meta.black;
  }

  handleLine(line: string): void {
    const ev = parseLine(line);
    if (!ev) return;
    switch (ev.type) {
      case 'idName':
        this.onIdName(ev.name);
        break;
      case 'position':
        this.onPosition(ev);
        break;
      case 'go':
        this.onGo(ev);
        break;
      case 'info':
        this.onInfo(ev.info);
        break;
      case 'bestmove':
        this.onBestMove(ev.move);
        break;
    }
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.sink.setSite(this.meta.site);
    this.sink.setPlayers(this.white, this.black);
  }

  private onIdName(name: string): void {
    // Fallback naming: only overrides a side left at its CLI default.
    this.idNames.push(name);
    if (this.started) return;
    if (this.idNames.length === 1 && this.white === 'White') this.white = name;
    else if (this.idNames.length === 2 && this.black === 'Black') this.black = name;
  }

  private onPosition(ev: PositionEvent): void {
    this.ensureStarted();
    if (!this.game.setPosition(ev.startpos, ev.fen, ev.moves)) return;

    if (!this.positionEmitted) {
      this.sink.emitInitialPosition(this.game.fenTruncated(), this.game.halfmoveClock());
      this.positionEmitted = true;
    }
  }

  private onGo(ev: GoEvent): void {
    if (ev.wtimeMs !== undefined && ev.btimeMs !== undefined) {
      this.sink.emitClocks(msToCs(ev.wtimeMs), msToCs(ev.btimeMs));
    }
  }

  private onInfo(info: UciInfo): void {
    if (info.multipv !== 1) return; // only the primary line is the broadcast eval

    const color = this.game.turn(); // side to move = the thinking side
    const whiteCp = this.game.toWhitePov(scoreToCentipawns(info));
    const sanPv = this.game.playoutPvToSan(info.pv);
    if (sanPv.length === 0) return;

    this.sink.emitPv(color, info.depth, Math.round(whiteCp), msToCs(info.timeMs), info.nodes, sanPv);
  }

  private onBestMove(move: string | null): void {
    if (move === null) {
      this.maybeEmitResult();
      return;
    }

    const applied = this.game.applyMove(move);
    if (!applied) return;

    this.sink.emitMove({
      fenTruncated: this.game.fenTruncated(),
      color: applied.color,
      fullMoveNumber: applied.fullMoveNumber,
      san: applied.san,
      fmr: this.game.halfmoveClock(),
    });

    this.maybeEmitResult();
  }

  private maybeEmitResult(): void {
    if (this.resultEmitted || !this.game.isGameOver()) return;
    const r = this.game.result();
    if (r) {
      this.sink.emitResult(r);
      this.resultEmitted = true;
    }
  }
}

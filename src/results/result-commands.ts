import { logger } from '../util/logger.js';
import * as P from '../tlcs/protocol.js';
import type { TlcsServer } from '../tlcs/server.js';
import type { GameRegistry } from './registry.js';
import { renderCrosstable, renderGameList } from './crosstable.js';

export type ResultTransport = Pick<TlcsServer, 'enqueue' | 'sendRaw' | 'getClient'>;

const NOT_CONFIGURED_CT = 'Sorry, this server is not configured to send the results table.';
const NOT_CONFIGURED_GL = 'MSG:Sorry, the server is not configured to provide you with a list of games';
const NO_GAMES_GL = 'MSG:PGN file not found!  Sorry, the server cannot provide you with a list of games.';
const MAX_RESENDS = 3;
/** Pushed dumps carry only this many game rows (node-tlcv merges older rows by number). */
const PUSH_RECENT = 20;

/**
 * Handles RESULTTABLE and GAMELIST: numbered replies to registered clients, plain to others.
 *
 * Consistency contract: the table a client sees never lists a game whose `result` has not
 * been enqueued to it before the table. `onResultEmitted(n)` enqueues a table capped at
 * game n right behind result n (to clients that have asked for a table at least once), and
 * every pull is capped at the last emitted result, so a node-tlcv that lags behind its
 * socket still numbers games from the results it has actually processed.
 */
export class ResultService {
  private gen = new Map<string, number>();
  private resends = new Map<string, number>();
  private subscribed = new Set<string>();

  /** `emitted`: number of the last game whose result has been broadcast (Infinity = unknown/uncapped). */
  constructor(
    private readonly t: ResultTransport,
    private readonly registry?: GameRegistry,
    private emitted = Infinity,
  ) {}

  /** The server just enqueued `result` for game `n` to every client: follow it with a capped table. */
  onResultEmitted(n: number): void {
    this.emitted = n;
    for (const dest of [...this.subscribed]) {
      if (!this.t.getClient(dest)) {
        this.forget(dest);
        continue;
      }
      this.resends.set(dest, 0);
      this.sendCt(dest, n, PUSH_RECENT);
    }
  }

  /**
   * CTRESET + table for games 1..n to one registered client, immediately (T09 reuses this for
   * its numbering dumps).
   */
  enqueueTableUpTo(dest: string, n: number, recent = 300): void {
    this.sendCt(dest, n, recent);
  }

  onResultTable(dest: string): void {
    if (!this.t.getClient(dest)) {
      this.sendCt(dest, this.emitted, 300);
      return;
    }
    this.subscribed.add(dest);
    this.resends.set(dest, 0);
    this.sendCt(dest, this.emitted, 300);
  }

  onGameList(dest: string): void {
    this.registry?.refresh();
    const games = this.registry?.games ?? [];
    const bodies = !this.registry ? [NOT_CONFIGURED_GL] : games.length ? renderGameList(games).map(P.gl) : [NO_GAMES_GL];
    logger.info(`GAMELIST -> ${dest} (${bodies.length})`);
    this.send(dest, bodies);
  }

  private forget(dest: string): void {
    this.subscribed.delete(dest);
  }

  private sendCt(dest: string, cap: number, recent: number): void {
    this.registry?.refresh();
    const games = (this.registry?.games ?? []).filter((g) => g.number <= cap);
    const lines = this.registry ? renderCrosstable(games, recent) : [NOT_CONFIGURED_CT];
    const g = (this.gen.get(dest) ?? 0) + 1;
    this.gen.set(dest, g);
    let fired = false;
    const onGiveUp = () => {
      // May run synchronously inside t.enqueue (hard-cap eviction): decide only, never enqueue here.
      if (fired || this.gen.get(dest) !== g) return;
      fired = true;
      const n = (this.resends.get(dest) ?? 0) + 1;
      this.resends.set(dest, n);
      if (n > MAX_RESENDS) {
        logger.warn(`RESULTTABLE to ${dest}: gave up after ${MAX_RESENDS} re-sends`);
        return;
      }
      setImmediate(() => {
        if (this.gen.get(dest) !== g) return;
        if (!this.t.getClient(dest)) return;
        logger.warn(`RESULTTABLE to ${dest}: line lost, re-sending dump (${n}/${MAX_RESENDS})`);
        this.sendCt(dest, this.emitted, recent);
      });
    };
    logger.info(`RESULTTABLE -> ${dest} (${lines.length} lines, ${games.length} games, cap ${cap})`);
    this.send(dest, [P.CTRESET, ...lines.map(P.ct)], onGiveUp);
  }

  private send(dest: string, bodies: string[], onGiveUp?: () => void): void {
    if (this.t.getClient(dest)) for (const b of bodies) this.t.enqueue(dest, b, { onGiveUp });
    else for (const b of bodies) this.t.sendRaw(dest, b);
  }
}

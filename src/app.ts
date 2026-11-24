import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Server as HttpServer } from 'node:http';
import type { Config } from './config.js';
import { FileTailer } from './tail.js';
import { TlcsServer } from './tlcs/server.js';
import { Pipeline } from './pipeline.js';
import { Demux } from './demux.js';
import { PacedSink } from './paced-sink.js';
import { makeSource } from './source/index.js';
import { GameRegistry, ResultService } from './results/index.js';
import { scanBoards } from './results/log-scan.js';
import { ClaimingAuthority } from './results/claiming.js';
import { startMetricsServer } from './metrics.js';
import { logger } from './util/logger.js';
import { numberingDump, enqueueDump } from './state/numbering.js';
import { planStart, type StartPlan } from './state/start.js';
import { catchUpSync } from './state/catch-up.js';
import { DebugLogSaver } from './state/debug-log.js';

const SAVEDEBUG_CONCURRENT = 'SAVEDEBUG: disabled, the log has concurrent games (per-game debug logs need one game at a time)';

export interface App {
  server: TlcsServer;
  close(): void;
}

/**
 * The server body: catch up to the live position (PGN + log scan), then live tailing. No
 * client state survives a restart: clients get the "not connected" notice and re-LOGON.
 */
export async function startApp(cfg: Config): Promise<App> {
  const server = new TlcsServer({
    port: cfg.port,
    bindAddr: cfg.bindAddr,
    clientTimeoutMs: cfg.clientTimeoutMs,
    menus: cfg.menus,
    adminPass: cfg.adminPass,
    maxClients: cfg.maxClients,
    bannedIps: cfg.bannedIps,
    fenSetupMove: cfg.fenSetupMove,
    // A client logging on mid-tournament (fresh node-tlcv starts at game number 1; a
    // re-LOGON after a restart may have missed games) learns the current number before the
    // resync snapshot.
    onLogon: (dest) => {
      if (!registry) return;
      registry.refresh();
      const g = registry.finishedCount() + 1;
      const b = numberingDump(registry.games, g);
      if (b) {
        enqueueDump(server, dest, b);
        logger.info(`logon: numbering dump -> ${dest} before game ${g} (${b.length} lines)`);
      }
    },
  });

  let registry: GameRegistry | undefined;
  if (cfg.tourneyPgn) {
    registry = new GameRegistry(cfg.tourneyPgn);
    registry.refresh();
    if (!existsSync(cfg.tourneyPgn)) logger.warn(`--pgn ${cfg.tourneyPgn} does not exist yet; results fall back to board/'*' until it appears`);
  }

  // Board 1 (the single-game stream) and boards >= 2 each get their own pacing.
  const pacedBoards = new Map<number, PacedSink>();
  let live = false;
  const pacedFor = (id: number): PacedSink => {
    let p = pacedBoards.get(id);
    if (!p) {
      pacedBoards.set(id, (p = new PacedSink(server.board(id), cfg)));
      p.setLive(live);
    }
    return p;
  };
  const setLive = (v: boolean) => {
    live = v;
    for (const p of pacedBoards.values()) p.setLive(v);
  };
  // Every finished game's result is "emitted" by the end of the synchronous catch-up.
  const results = new ResultService(server, registry, registry ? registry.finishedCount() : Infinity);
  server.setResultService(results);
  const authority = registry ? new ClaimingAuthority(registry) : undefined;

  const meta = { white: cfg.white, black: cfg.black, site: cfg.site, fenSetupMove: cfg.fenSetupMove };
  const cur = { demux: undefined as unknown as Demux, feed: (_l: string): void => {} };
  let debug: DebugLogSaver | undefined;
  const onConcurrent = () => {
    authority?.setConcurrent();
    results.setConcurrent();
    if (debug) {
      logger.warn(SAVEDEBUG_CONCURRENT);
      debug.close();
      debug = undefined;
    }
  };
  let firstScan: { starts: number[]; end: number } = { starts: [], end: 0 };

  /** Build a fresh pipeline for the log's current state and synchronously catch up. Returns the tail offset. */
  const session = (first: boolean): number => {
    registry?.refresh();
    let size = 0;
    try {
      size = statSync(cfg.logPath).size;
    } catch {
      /* log not there yet */
    }
    const fromEnd = first && !cfg.fromStart;
    const boards = size > 0 && !fromEnd ? scanBoards(cfg.logPath, cfg.format) : { boards: [], count: 1, starts: [], end: 0 };
    const concurrent = boards.count > 1;
    const scan = concurrent ? { starts: [], end: 0 } : { starts: boards.starts, end: boards.end };
    if (first) firstScan = scan;
    // Concurrent: from the oldest board's current game. Otherwise from the game in progress.
    const plan: StartPlan = concurrent
      ? { offset: Math.min(...boards.boards.map((b) => b.start)) }
      : planStart({ starts: scan.starts, end: scan.end, finished: registry?.finishedCount(), fromEnd, size });
    cur.demux?.close();
    if (!first) {
      // A new log: the old boards' games are over; the new Demux re-signals concurrency.
      server.endGames();
      authority?.setConcurrent(false);
      results.setConcurrent(false);
    }
    // Sequential: PGN entries of games before the caught-up one must not match it (restart, --from-end).
    if (authority && !concurrent) authority.claimBelow(plan.firstGame ?? registry!.finishedCount() + 1);
    const lazyFirst = () => (registry!.refresh(), registry!.finishedCount() + 1);
    const makePipeline = (id: number) =>
      new Pipeline(
        pacedFor(id),
        meta,
        authority
          ? { pvIntervalMs: cfg.pvIntervalMs, authority, firstGameNumber: id === 1 ? (plan.firstGame ?? lazyFirst) : lazyFirst }
          : { pvIntervalMs: cfg.pvIntervalMs },
      );
    const demux = new Demux(makePipeline, { onBoardAdded: onConcurrent });
    if (concurrent) {
      demux.reserve(new Map(boards.boards.map((b) => [b.channel, b.id])), boards.count);
      logger.info(`start: ${boards.count} concurrent boards; catching up from offset ${plan.offset}`);
    }
    const pipeline = demux.pipeline(1)!;
    cur.demux = demux;
    const source = makeSource(cfg.format);
    cur.feed = (line) => {
      const n = source.normalize(line);
      if (n) demux.handleLine(n);
    };

    setLive(false);
    const t0 = Date.now();
    const endOff = fromEnd ? size : catchUpSync(cfg.logPath, plan.offset, cur.feed);
    demux.endReservation();
    setLive(true);
    logger.info(
      `start: caught up ${concurrent ? `${boards.count} boards` : `game ${plan.firstGame ?? pipeline.currentGameNumber()}`} ` +
        `from offset ${plan.offset} to ${endOff} in ${Date.now() - t0} ms (live position; clients re-LOGON)`,
    );
    return endOff;
  };

  await new Promise<void>((r) => server.start(r));
  let metricsServer: HttpServer | undefined;
  if (cfg.metricsPort) metricsServer = startMetricsServer(cfg.metricsPort, cfg.bindAddr, server);

  // Same turn as the 'listening' callback: no inbound datagram is processed before the catch-up ends.
  const off = session(true);
  const tailer = new FileTailer(cfg.logPath, (l) => cur.feed(l), {
    start: off,
    onReset: () => session(false),
  });
  tailer.start();
  registry?.startPolling(() => cur.demux.onAuthorityTick());

  if (cfg.saveDebug && server.boardCount() > 1) {
    logger.warn(SAVEDEBUG_CONCURRENT);
  } else if (cfg.saveDebug) {
    const dir = cfg.iniPath ? dirname(cfg.iniPath) : dirname(resolve(cfg.logPath));
    debug = new DebugLogSaver(cfg.logPath, cfg.format, dir, registry, firstScan);
    debug.start();
  }

  logger.info(
    `Broadcasting ${cfg.logPath} (format=${cfg.format}) on UDP ${cfg.bindAddr}:${cfg.port} ` +
      `(white="${cfg.white}", black="${cfg.black}", site="${cfg.site}")`,
  );

  return {
    server,
    close: () => {
      tailer.close();
      registry?.close();
      debug?.close();
      cur.demux.close();
      metricsServer?.close();
      server.close();
    },
  };
}

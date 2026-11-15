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
import { loadState, type PersistedClient } from './state/state-file.js';
import { StateStore } from './state/progress.js';
import { ResumeSink, planResume, numberingDump, enqueueDump, attachPersisted, type ResumePlan } from './state/resume.js';
import { catchUpSync } from './state/catch-up.js';
import { DebugLogSaver } from './state/debug-log.js';

const SAVEDEBUG_CONCURRENT = 'SAVEDEBUG: disabled, the log has concurrent games (per-game debug logs need one game at a time)';

export interface App {
  server: TlcsServer;
  /** Stop everything. `flush: false` simulates a crash for the state file (no final write). */
  close(opts?: { flush?: boolean }): void;
}

/** The server body: startup recovery (state + PGN + log catch-up), then live tailing. */
export async function startApp(cfg: Config): Promise<App> {
  let store: StateStore | undefined;
  const server = new TlcsServer({
    port: cfg.port,
    bindAddr: cfg.bindAddr,
    clientTimeoutMs: cfg.clientTimeoutMs,
    menus: cfg.menus,
    adminPass: cfg.adminPass,
    maxClients: cfg.maxClients,
    bannedIps: cfg.bannedIps,
    onAcked: (d, e, c) => store?.onAcked(d, e, c),
    onClientsChanged: () => store?.save(),
    // A client logging on mid-tournament (fresh node-tlcv starts at game number 1) learns the
    // current number before the resync replay.
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

  // Restored clients: banned IPs and MAXCLIENTS still apply. Admin grants are not persisted.
  const loaded = cfg.stateFile ? loadState(cfg.stateFile) : null;
  if (loaded) {
    const kept: PersistedClient[] = [];
    for (const c of loaded.clients) {
      const dest = `${c.ip}:${c.port}`;
      if (cfg.bannedIps.includes(c.ip)) logger.warn(`state: not restoring banned ${dest}`);
      else if (cfg.maxClients > 0 && kept.length >= cfg.maxClients) logger.warn(`state: maxClients reached; not restoring ${dest}`);
      else kept.push(c);
    }
    loaded.clients = kept;
    logger.info(`state: restored ${kept.length} client(s) from ${cfg.stateFile}`);
  }
  store = cfg.stateFile ? new StateStore(cfg.stateFile, server, loaded, undefined, cfg.logPath) : undefined;

  const resume = new ResumeSink(server, store, registry);
  // Board 1 (the single-game stream) goes through ResumeSink; boards >= 2 straight to their server board.
  const paced = new PacedSink(resume, cfg);
  const pacedBoards = new Map<number, PacedSink>([[1, paced]]);
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
  const session = (restored: PersistedClient[], first: boolean): number => {
    registry?.refresh();
    let size = 0;
    try {
      const st = statSync(cfg.logPath);
      size = st.size;
      store?.setLogIno(st.ino);
    } catch {
      /* log not there yet */
    }
    const fromEnd = first && !cfg.fromStart;
    const boards = size > 0 && !fromEnd ? scanBoards(cfg.logPath, cfg.format) : { boards: [], count: 1, starts: [], end: 0 };
    const concurrent = boards.count > 1;
    const scan = concurrent ? { starts: [], end: 0 } : { starts: boards.starts, end: boards.end };
    if (first) firstScan = scan;
    const nextsIn = store ? store.restored() : restored;
    const rest = first ? nextsIn : [];
    // Concurrent: live position only, from the oldest board's current game (no numbered replay).
    const plan: ResumePlan = concurrent
      ? { offset: Math.min(...boards.boards.map((b) => b.start)), nexts: [], clamped: [] }
      : planResume({
      starts: scan.starts,
      end: scan.end,
      finished: registry?.finishedCount(),
      restored: rest.map((c) => c.next),
      fromEnd,
      size,
    });
    for (const i of plan.clamped) {
      logger.info(`resume: ${rest[i].ip}:${rest[i].port} missed more than ${3} games; replaying the last 3`);
    }
    cur.demux?.close();
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
      logger.info(`resume: ${boards.count} concurrent boards; catching up from offset ${plan.offset} (live position only)`);
    }
    const pipeline = demux.pipeline(1)!;
    cur.demux = demux;
    const source = makeSource(cfg.format);
    cur.feed = (line) => {
      const n = source.normalize(line);
      if (n) demux.handleLine(n);
    };

    let pending: Array<PersistedClient & { next: number }> = [];
    if (fromEnd) {
      for (const c of rest) attachPersisted(server, c);
    } else if (!concurrent) {
      pending = rest.map((c, i) => ({ ...c, next: plan.nexts[i] }));
    }
    resume.begin(
      plan.firstGame ?? lazyFirst,
      pending,
      plan.current ?? (() => (registry ? (registry.refresh(), registry.finishedCount() + 1) : 1)),
      () => pipeline.currentGameNumber(),
    );
    setLive(false);
    const t0 = Date.now();
    const endOff = fromEnd ? size : catchUpSync(cfg.logPath, plan.offset, cur.feed);
    resume.finishCatchUp();
    demux.endReservation();
    if (concurrent) {
      // Live position only: each restored client gets a full resync of every board it sees.
      for (const c of rest) server.resync(attachPersisted(server, c));
    }
    setLive(true);
    if (!fromEnd && !concurrent) {
      logger.info(
        `resume: log has ${scan.starts.length} game start(s), PGN ${registry ? registry.finishedCount() : 'n/a'} finished; ` +
          `caught up games ${plan.firstGame}..${pipeline.currentGameNumber()} from offset ${plan.offset} to ${endOff} ` +
          `in ${Date.now() - t0} ms (${rest.length} restored client(s))`,
      );
    }
    return endOff;
  };

  await new Promise<void>((r) => server.start(r));
  let metricsServer: HttpServer | undefined;
  if (cfg.metricsPort) metricsServer = startMetricsServer(cfg.metricsPort, cfg.bindAddr, server);

  // Same turn as the 'listening' callback: no inbound datagram is processed before the catch-up ends.
  const off = session(loaded?.clients ?? [], true);
  store?.markReady();
  const tailer = new FileTailer(cfg.logPath, (l) => cur.feed(l), {
    start: off,
    onReset: () => {
      store?.resetProgress();
      return session([], false);
    },
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
    close: ({ flush = true } = {}) => {
      tailer.close();
      registry?.close();
      debug?.close();
      cur.demux.close();
      store?.close(flush);
      metricsServer?.close();
      server.close();
    },
  };
}

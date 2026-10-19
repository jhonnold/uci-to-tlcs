import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Server as HttpServer } from 'node:http';
import type { Config } from './config.js';
import { FileTailer } from './tail.js';
import { TlcsServer } from './tlcs/server.js';
import { Pipeline } from './pipeline.js';
import { PacedSink } from './paced-sink.js';
import { makeSource } from './source/index.js';
import { GameRegistry, ResultService, scanGameStarts } from './results/index.js';
import { startMetricsServer } from './metrics.js';
import { logger } from './util/logger.js';
import { loadState, type PersistedClient } from './state/state-file.js';
import { StateStore } from './state/progress.js';
import { ResumeSink, planResume, numberingDump, enqueueDump } from './state/resume.js';
import { catchUpSync } from './state/catch-up.js';
import { DebugLogSaver } from './state/debug-log.js';

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
  const paced = new PacedSink(resume, cfg);
  // Every finished game's result is "emitted" by the end of the synchronous catch-up.
  server.setResultService(new ResultService(server, registry, registry ? registry.finishedCount() : Infinity));

  const meta = { white: cfg.white, black: cfg.black, site: cfg.site, fenSetupMove: cfg.fenSetupMove };
  const cur = { pipeline: undefined as unknown as Pipeline, feed: (_l: string): void => {} };
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
    const scan = size > 0 && !fromEnd ? scanGameStarts(cfg.logPath, cfg.format) : { starts: [], end: 0 };
    if (first) firstScan = scan;
    const nextsIn = store ? store.restored() : restored;
    const rest = first ? nextsIn : [];
    const plan = planResume({
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
    cur.pipeline?.close();
    const lazyFirst = () => (registry!.refresh(), registry!.finishedCount() + 1);
    const pipeline = new Pipeline(
      paced,
      meta,
      registry
        ? { pvIntervalMs: cfg.pvIntervalMs, authority: registry, firstGameNumber: plan.firstGame ?? lazyFirst }
        : { pvIntervalMs: cfg.pvIntervalMs },
    );
    cur.pipeline = pipeline;
    const source = makeSource(cfg.format);
    cur.feed = (line) => {
      const n = source.normalize(line);
      if (n) pipeline.handleLine(n);
    };

    let pending: Array<PersistedClient & { next: number }> = [];
    if (fromEnd) {
      for (const c of rest) server.addClient(c.ip, c.port, c.user);
    } else {
      pending = rest.map((c, i) => ({ ...c, next: plan.nexts[i] }));
    }
    resume.begin(
      plan.firstGame ?? lazyFirst,
      pending,
      plan.current ?? (() => (registry ? (registry.refresh(), registry.finishedCount() + 1) : 1)),
      () => pipeline.currentGameNumber(),
    );
    paced.setLive(false);
    const t0 = Date.now();
    const endOff = fromEnd ? size : catchUpSync(cfg.logPath, plan.offset, cur.feed);
    resume.finishCatchUp();
    paced.setLive(true);
    if (!fromEnd) {
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
  registry?.startPolling(() => cur.pipeline.onAuthorityTick());

  let debug: DebugLogSaver | undefined;
  if (cfg.saveDebug) {
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
      cur.pipeline.close();
      store?.close(flush);
      metricsServer?.close();
      server.close();
    },
  };
}

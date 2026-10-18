import { parseConfig } from './config.js';
import { FileTailer } from './tail.js';
import { TlcsServer } from './tlcs/server.js';
import { Pipeline } from './pipeline.js';
import { PacedSink } from './paced-sink.js';
import { makeSource } from './source/index.js';
import { GameRegistry } from './results/index.js';
import { logger } from './util/logger.js';
import { existsSync } from 'node:fs';

function main(): void {
  const cfg = parseConfig(process.argv.slice(2));
  logger.info('config: ' + JSON.stringify({ ...cfg, adminPass: cfg.adminPass ? '***' : undefined }));

  const server = new TlcsServer({ port: cfg.port, bindAddr: cfg.bindAddr });
  server.start();

  let registry: GameRegistry | undefined;
  if (cfg.tourneyPgn) {
    const reg = new GameRegistry(cfg.tourneyPgn);
    registry = reg;
    reg.refresh();
    if (!existsSync(cfg.tourneyPgn)) logger.warn(`--pgn ${cfg.tourneyPgn} does not exist yet; results fall back to board/'*' until it appears`);
    else if (reg.finishedCount() > 0 && cfg.fromStart) {
      logger.warn(
        `--pgn already holds ${reg.finishedCount()} finished game(s); assuming the log starts at game 1. ` +
          'A stale/appended PGN misaligns results: use a fresh -pgnout file.',
      );
    }
  }
  const sink = new PacedSink(server, cfg);
  const pipeline = new Pipeline(
    sink,
    { white: cfg.white, black: cfg.black, site: cfg.site, fenSetupMove: cfg.fenSetupMove },
    registry
      ? {
          authority: registry,
          firstGameNumber: cfg.fromStart ? 1 : () => (registry.refresh(), registry.finishedCount() + 1),
        }
      : {},
  );
  registry?.startPolling(() => pipeline.onAuthorityTick());
  const source = makeSource(cfg.format);
  const tailer = new FileTailer(
    cfg.logPath,
    (line) => {
      const n = source.normalize(line);
      if (n) pipeline.handleLine(n);
    },
    cfg.fromStart,
    () => sink.setLive(),
  );
  tailer.start();

  logger.info(
    `Broadcasting ${cfg.logPath} (format=${cfg.format}) on UDP ${cfg.bindAddr}:${cfg.port} ` +
      `(white="${cfg.white}", black="${cfg.black}", site="${cfg.site}")`,
  );

  const shutdown = () => {
    logger.info('Shutting down…');
    tailer.close();
    registry?.close();
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

try {
  main();
} catch (err) {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

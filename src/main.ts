import { parseConfig } from './config.js';
import { FileTailer } from './tail.js';
import { TlcsServer } from './tlcs/server.js';
import { Pipeline } from './pipeline.js';
import { PacedSink } from './paced-sink.js';
import { makeSource } from './source/index.js';
import { logger } from './util/logger.js';

function main(): void {
  const cfg = parseConfig(process.argv.slice(2));
  logger.info('config: ' + JSON.stringify({ ...cfg, adminPass: cfg.adminPass ? '***' : undefined }));

  const server = new TlcsServer({ port: cfg.port, bindAddr: cfg.bindAddr });
  server.start();

  const sink = new PacedSink(server, cfg);
  const pipeline = new Pipeline(sink, {
    white: cfg.white,
    black: cfg.black,
    site: cfg.site,
    fenSetupMove: cfg.fenSetupMove,
  });
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

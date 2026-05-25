import { parseConfig } from './config.js';
import { FileTailer } from './tail.js';
import { TlcsServer } from './tlcs/server.js';
import { Pipeline } from './pipeline.js';
import { logger } from './util/logger.js';

function main(): void {
  const cfg = parseConfig(process.argv.slice(2));

  const server = new TlcsServer({ port: cfg.port, bindAddr: cfg.bindAddr });
  server.start();

  const pipeline = new Pipeline(server, { white: cfg.white, black: cfg.black, site: cfg.site });
  const tailer = new FileTailer(cfg.logPath, (line) => pipeline.handleLine(line), cfg.fromStart);
  tailer.start();

  logger.info(
    `Broadcasting ${cfg.logPath} on UDP ${cfg.bindAddr}:${cfg.port} ` +
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

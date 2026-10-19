import { parseConfig } from './config.js';
import { startApp } from './app.js';
import { logger } from './util/logger.js';

async function main(): Promise<void> {
  const cfg = parseConfig(process.argv.slice(2));
  logger.info('config: ' + JSON.stringify({ ...cfg, adminPass: cfg.adminPass ? '***' : undefined }));
  const app = await startApp(cfg);
  const shutdown = () => {
    logger.info('Shutting down…');
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

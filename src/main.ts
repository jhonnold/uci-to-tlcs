import { parseConfig } from './config.js';
import { FileTailer } from './tail.js';
import { TlcsServer } from './tlcs/server.js';
import { Pipeline } from './pipeline.js';
import { loadPgnGames, mergeGames, type PgnGame } from './pgn.js';
import { makeSource } from './source/index.js';
import { logger } from './util/logger.js';

function main(): void {
  const cfg = parseConfig(process.argv.slice(2));

  const server = new TlcsServer({ port: cfg.port, bindAddr: cfg.bindAddr });
  server.start();

  // The PGN file is the finished-games database (fastchess appends each finished
  // game to it). Games the live run broadcasts continue its numbering; the file
  // is re-read at every game boundary so a live-appended PGN stays in sync.
  let fileGames: PgnGame[] = loadPgnGames(cfg.pgnPath);
  const pipeline = new Pipeline(server, {
    white: cfg.white,
    black: cfg.black,
    site: cfg.site,
    gameNumber: fileGames.length + 1,
    onGameStart: (gameNumber) => {
      fileGames = loadPgnGames(cfg.pgnPath);
      const all = mergeGames(fileGames, pipeline.finishedGames());
      logger.debug(`game ${gameNumber}: ${all.length} game(s) in database (${fileGames.length} from PGN)`);
    },
  });
  const source = makeSource(cfg.format);
  const tailer = new FileTailer(
    cfg.logPath,
    (line) => {
      const n = source.normalize(line);
      if (n) pipeline.handleLine(n);
    },
    cfg.fromStart,
  );
  tailer.start();

  logger.info(
    `Broadcasting ${cfg.logPath} (format=${cfg.format}) on UDP ${cfg.bindAddr}:${cfg.port} ` +
      `(white="${cfg.white}", black="${cfg.black}", site="${cfg.site}", pgn="${cfg.pgnPath}" with ${fileGames.length} finished game(s))`,
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

import { isFormat, type Format } from './source/index.js';

export interface Config {
  /** Path to the UCI transcript / engine log to tail. */
  logPath: string;
  /** Log producer format: `auto` (sniff), `raw` (stripped transcript), `fastchess`. */
  format: Format;
  /** UDP broadcast port (the port node-tlcv connects to and binds locally). */
  port: number;
  /** Local bind address (0.0.0.0 by default; a loopback alias for local testing). */
  bindAddr: string;
  white: string;
  black: string;
  site: string;
  /** Process the file from the beginning (default) vs. only new appends. */
  fromStart: boolean;
}

const USAGE = `uci-to-tlcs — broadcast a raw UCI transcript as TLCS over UDP

Usage:
  uci-to-tlcs --log <path> [options]

Options:
  --log <path>       UCI transcript / engine log to tail (required)
  --format <fmt>     Log producer: auto | raw | fastchess (default auto)
  --port <n>         UDP broadcast port (default 16066)
  --bind <addr>      Local bind address (default 0.0.0.0)
  --white <name>     White player name (default "White")
  --black <name>     Black player name (default "Black")
  --site <name>      Site / tournament label (default "uci-to-tlcs")
  --from-end         Only broadcast appends made after startup (default: from start)
  -h, --help         Show this help
`;

export function parseConfig(argv: string[]): Config {
  const cfg: Config = {
    logPath: '',
    format: 'auto',
    port: 16066,
    bindAddr: '0.0.0.0',
    white: 'White',
    black: 'Black',
    site: 'uci-to-tlcs',
    fromStart: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--log':
        cfg.logPath = argv[++i];
        break;
      case '--format': {
        const fmt = argv[++i];
        if (!isFormat(fmt)) throw new Error(`Invalid --format: ${fmt} (use auto | raw | fastchess)`);
        cfg.format = fmt;
        break;
      }
      case '--port':
        cfg.port = parseInt(argv[++i], 10);
        break;
      case '--bind':
        cfg.bindAddr = argv[++i];
        break;
      case '--white':
        cfg.white = argv[++i];
        break;
      case '--black':
        cfg.black = argv[++i];
        break;
      case '--site':
        cfg.site = argv[++i];
        break;
      case '--from-end':
        cfg.fromStart = false;
        break;
      case '-h':
      case '--help':
        process.stdout.write(USAGE);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  if (!cfg.logPath) throw new Error(`Missing required --log <path>\n\n${USAGE}`);
  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
    throw new Error(`Invalid --port: ${cfg.port}`);
  }

  return cfg;
}

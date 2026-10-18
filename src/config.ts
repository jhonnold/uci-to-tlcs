import { resolve } from 'node:path';
import { isFormat, type Format } from './source/index.js';
import { loadIni } from './ini.js';
import { logger } from './util/logger.js';

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
  /** Reference-style server.ini this config was loaded from (CLI flags override it). */
  iniPath?: string;
  /** DELAY= (reference: UDP receive timeout / main-loop pacing), ms. */
  delayMs: number;
  /** Pause after each move, ms (reference default 300; ours 0). */
  delayAfterMoveMs: number;
  /** Pause after each game, ms (reference default 1000; ours 0). */
  delayAfterGameMs: number;
  /** MENU lines, verbatim, ascending id (max 10). */
  /** Extension: non-startpos games get a synthetic `(setup)` move so node-tlcv loads the FEN. */
  fenSetupMove: boolean;
  menus: string[];
  /** PGN served for RESULTTABLE/GAMELIST (TOURNEYPGN= / --pgn). */
  tourneyPgn?: string;
  saveDebug: boolean;
  /** Extension: persisted-state file. */
  stateFile?: string;
  /** Extension: idle-client reap timeout, ms. */
  clientTimeoutMs: number;
  /** Extension: admin password. */
  adminPass?: string;
  /** Extension: max concurrent clients (0 = unlimited). */
  maxClients: number;
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
  --ini <path>       Reference-style server.ini (CLI flags override it)
  --pgn <path>       Tournament PGN (TOURNEYPGN=)
  --delay-after-move <ms>  Pause after each move (default 0)
  --delay-after-game <ms>  Pause after each game (default 0)
  --fen-setup-move <0|1>   Non-startpos games: synthetic "(setup)" move so node-tlcv loads the FEN (default 1)
  --from-end         Only broadcast appends made after startup (default: from start)
  -h, --help         Show this help
`;

function nonNegInt(flag: string, v: string | undefined): number {
  if (v === undefined || !/^\d+$/.test(v)) throw new Error(`Invalid ${flag}: ${v}`);
  return Number(v);
}

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
    delayMs: 100,
    delayAfterMoveMs: 0,
    delayAfterGameMs: 0,
    fenSetupMove: true,
    menus: [],
    saveDebug: false,
    clientTimeoutMs: 70000,
    maxClients: 0,
  };

  // --ini is pre-scanned so the CLI overrides it regardless of argument order.
  const iniIdx = argv.indexOf('--ini');
  if (iniIdx >= 0) {
    const p = argv[iniIdx + 1];
    if (!p) throw new Error(`--ini requires a path\n\n${USAGE}`);
    let res;
    try {
      res = loadIni(p);
    } catch (err) {
      if (err instanceof Error && 'code' in err) throw new Error(`Cannot read --ini ${p}: ${err.message}`);
      throw err;
    }
    for (const [k, v] of Object.entries(res.values)) {
      if (v !== undefined) (cfg as unknown as Record<string, unknown>)[k] = v;
    }
    cfg.iniPath = resolve(p);
    for (const w of res.warnings) logger.warn(`server.ini: ${w}`);
  }

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
      case '--ini':
        i++; // already handled by the pre-scan
        break;
      case '--pgn':
        cfg.tourneyPgn = resolve(process.cwd(), argv[++i]);
        break;
      case '--delay-after-move':
        cfg.delayAfterMoveMs = nonNegInt('--delay-after-move', argv[++i]);
        break;
      case '--delay-after-game':
        cfg.delayAfterGameMs = nonNegInt('--delay-after-game', argv[++i]);
        break;
      case '--fen-setup-move': {
        const v = argv[++i];
        if (v !== '0' && v !== '1') throw new Error(`Invalid --fen-setup-move: ${v} (use 0 or 1)`);
        cfg.fenSetupMove = v === '1';
        break;
      }
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

  if (!cfg.logPath) throw new Error(`Missing log path: pass --log <path> or PATH= in --ini\n\n${USAGE}`);
  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
    throw new Error(`Invalid --port: ${cfg.port}`);
  }

  return cfg;
}

// A stand-in for node-tlcv (default) or the desktop TLCV client (--mode desktop),
// for fast local iteration on the server and for e2e scenarios.
//
// Binding, in precedence order (--ephemeral with --local-port is a usage error):
//   --local-port <n>  bind <--bind or 127.0.0.1>:<n>
//   --ephemeral       bind <--bind or 127.0.0.1>:0 (OS port; the server replies to the source port)
//   neither           bind <--bind or 127.0.0.2>:<--port> (legacy same-port mode; needs a loopback alias)
//
//   tsx scripts/mock-client.ts --server 127.0.0.1 --port 16066 --ephemeral
//
// Modes: node-tlcv (default; plain PING every 10 s, node-tlcv's id rules and re-LOGON
// logic) and desktop (TLCV 2.1c: gated until LOGON SUCCESSFUL, numbered PING).
// See docs/e2e-testing.md for the full flag table. --help lists the flags.

import { MockSession, type SessionOpts } from './lib/mock-session.js';
import { resolveBind } from './lib/mock-core.js';

const HELP = `Usage: tsx scripts/mock-client.ts [options]
  --server <host>        server host (127.0.0.1)         --port <n>   server port (16066)
  --bind <addr>          local bind address              --local-port <n>   bind a fixed local port
  --ephemeral            OS-assigned local port          --user <name>   (tester)
  --mode node-tlcv|desktop   client model (node-tlcv)
  --drop <p> --reorder <p> --seed <n>   seeded loss/delay injection, both directions.
                         Outbound LOGON* is never dropped or delayed.
  --transcript <file.jsonl>   record every datagram and event
  --quiet                suppress pretty-print
  --logoff-after <s> [--logon-again-after <s>]   LOGOFF, then optionally re-LOGON
  --silent-after <s> [--silent-for <s>]          stop sending anything (test reaping)
  --exit-after <s>       LOGOFF and exit 0
  --relogin-min <s> (60) --data-timeout <s> (600)   node-tlcv re-LOGON tuning
  desktop only: --force-ping (ping without FEATURE: PING)  --no-disconnect  --chat <text>
  --control <file>       send each line appended to <file> (poll 200 ms); a leading '#' sends it numbered (desktop mode only)
`;

function parseOpts(argv: string[]): Omit<SessionOpts, 'onExit'> {
  const o: Omit<SessionOpts, 'onExit'> = {
    server: '127.0.0.1', port: 16066, bind: '', ephemeral: false, user: 'tester', mode: 'node-tlcv',
    drop: 0, reorder: 0, seed: 1, quiet: false, reloginMin: 60, dataTimeout: 600, forcePing: false, noDisconnect: false,
  };
  const num = (s: string | undefined, flag: string): number => {
    const n = Number(s);
    if (s === undefined || Number.isNaN(n)) usage(`${flag} needs a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    switch (a) {
      case '--server': o.server = v(); break;
      case '--port': o.port = num(v(), a); break;
      case '--bind': o.bind = v(); break;
      case '--local-port': o.localPort = num(v(), a); break;
      case '--user': o.user = v(); break;
      case '--ephemeral': o.ephemeral = true; break;
      case '--mode': {
        const m = v();
        if (m !== 'node-tlcv' && m !== 'desktop') usage('--mode must be node-tlcv or desktop');
        o.mode = m;
        break;
      }
      case '--drop': o.drop = num(v(), a); break;
      case '--reorder': o.reorder = num(v(), a); break;
      case '--seed': o.seed = num(v(), a); break;
      case '--transcript': o.transcript = v(); break;
      case '--quiet': o.quiet = true; break;
      case '--logoff-after': o.logoffAfter = num(v(), a); break;
      case '--logon-again-after': o.logonAgainAfter = num(v(), a); break;
      case '--silent-after': o.silentAfter = num(v(), a); break;
      case '--silent-for': o.silentFor = num(v(), a); break;
      case '--exit-after': o.exitAfter = num(v(), a); break;
      case '--relogin-min': o.reloginMin = num(v(), a); break;
      case '--data-timeout': o.dataTimeout = num(v(), a); break;
      case '--force-ping': o.forcePing = true; break;
      case '--no-disconnect': o.noDisconnect = true; break;
      case '--chat': o.chat = v(); break;
      case '--control': o.control = v(); break;
      case '--help': console.log(HELP); process.exit(0);
      default: usage(`unknown option ${a}`);
    }
  }
  try {
    resolveBind(o);
  } catch (e) {
    usage((e as Error).message);
  }
  return o;
}

function usage(msg: string): never {
  console.error(`mock-client: ${msg}\n\n${HELP}`);
  process.exit(2);
}

const session = new MockSession({ ...parseOpts(process.argv.slice(2)), onExit: (c) => process.exit(c) });
session.start();
process.on('SIGINT', () => session.exit(0));
process.on('SIGTERM', () => session.exit(0));

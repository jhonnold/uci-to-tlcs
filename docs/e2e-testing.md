# E2E testing flow

The full live path: **fastchess** writes a UCI engine log → **uci-to-tlcs** tails it and
broadcasts TLCS over UDP → **node-tlcv** (a TLCS client/kibitzer) reconstructs and saves
PGNs. Then **wait** for fastchess to finish and **check the logs & PGNs**.

Data flow: `fastchess` → `/tmp/fc.log` → `uci-to-tlcs` (UDP `:16000`) → `node-tlcv`
(port `8099`) → `PGNS_DIR`. Reach for it before shipping a protocol/transport change, or
to verify a move/result/name/clock bug end-to-end.

## 1. Prerequisites

- `fastchess` (`~/projects/engine-testing/fastchess`, `make -j4`) and `berserk`
  (`~/projects/berserk`, `make CC=gcc build`) both on `PATH` (symlinked into
  `~/.local/bin`).
- `uci-to-tlcs`: `npm ci` (runs via `tsx`; `npm run build` for the `node dist/src/main.js` path). `node-tlcv`: `npm ci`.

## 2. Configure node-tlcv

Use a private config dir so node-tlcv's own `config/config.json` and `.env` stay untouched. `config.json` →
one **ephemeral** connection to the bridge (binds an OS port and relies on our source-port reply, so no
same-host `EADDRINUSE`):

```json
{ "connections": [ { "connection": "127.0.0.1:16000", "ephemeral": true } ] }
```

Run it with `CONFIG_DIR=/tmp/ntcfg PORT=8099 PGNS_DIR=/tmp/node-tlcv-pgns LOG_LEVEL=info node --loader ts-node/esm src/main.ts`
in `../node-tlcv` (environment variables beat `.env`; add `TS_NODE_LOG_ERROR=true` if ts-node trips over a type error in
the checkout, and `TS_NODE_PROJECT=tsconfig.backend.json`). `npm run dev-server` (nodemon) can segfault under Node 22.

## 3. Run

```bash
# bridge (flags, or `--ini server.ini` for the full configuration; see README)
LOG_LEVEL=debug npm start -- --log /tmp/fc.log --format fastchess --pgn /tmp/games.pgn \
  --bind 127.0.0.1 --port 16000 > /tmp/uci-to-tlcs.log 2>&1 &

# kibitzer
( cd ../node-tlcv && CONFIG_DIR=/tmp/ntcfg PORT=8099 PGNS_DIR=/tmp/node-tlcv-pgns LOG_LEVEL=info \
  node --loader ts-node/esm src/main.ts ) > /tmp/node-tlcv.log 2>&1 &

# producer — engine names may contain spaces / versions / commit hashes; quote any
# name with a space. -concurrency 1 (games don't interleave), real tc= (ticking clocks).
fastchess -engine name="Berserk A" cmd=berserk -engine name="Berserk B" cmd=berserk \
  -engine name="Berserk C" cmd=berserk -engine name="Berserk D" cmd=berserk \
  -each tc=10+0.1 option.Hash=32 option.Threads=1 -rounds 3 -games 1 -concurrency 1 \
  -log file=/tmp/fc.log engine=true realtime=true -pgnout file=/tmp/games.pgn > /tmp/fastchess.log 2>&1
```

The bridge tails `/tmp/fc.log` and **waits for it to appear**, so bridge-vs-fastchess
order doesn't matter — only bridge-vs-node-tlcv does.

## 4. Wait

Until fastchess prints its summary and exits. The bridge drains the last lines and stays
alive; node-tlcv keeps kibitzing until killed.

## 5. Check the logs & PGNs

Artifacts: `/tmp/node-tlcv-pgns/uci-to-tlcs/*.pgn` (ground truth), `/tmp/uci-to-tlcs.log`
(bridge), `/tmp/node-tlcv.log` (kibitzer), `/tmp/fc.log` (raw UCI), `/tmp/fastchess.log`
(fastchess results), plus fastchess's own `/tmp/games.pgn`. Compare them mechanically:

```bash
npm run e2e-check -- --fastchess /tmp/games.pgn --pgns /tmp/node-tlcv-pgns --strict-numbers
```

It checks game count, White/Black, Result, the full SAN list and that no `*` results
remain; games are matched by content, and `--strict-numbers` also requires node-tlcv's file number
to equal the fastchess game index. It prints `PASS` or `FAIL n finding(s)` then one line per game (`DIFF [moves]
... first divergence at ply 10: exp X got Y`, `MISSING`, `EXTRA`, `COUNT`, `STAR`).
Exit 0 pass, 1 mismatch, 2 usage/IO error (including an empty `--pgns` dir). Other flags:
`--allow-star`, `--strict-numbers` (filename `N_` prefix must equal the fastchess game
index), `--expect-contiguous`, `--json`, and `--transcript <f.jsonl>` (repeatable) to check
mock transcripts (see below).

Then eyeball the logs:

- **Names** — `[White]`/`[Black]` are real engine names (not `Engine1`/`Engine2`);
  colours = side-to-move at start; stable across rounds.
- **Registration** — exactly one client in `/tmp/uci-to-tlcs.log` (`LOGONv15`); 0 =
  node-tlcv can't reach the bridge (check host/port), >1 = node-tlcv restarted.
- **Reliability** — `grep -E 'stalled|give-up|hard cap'` in the bridge log, or the `tlcs_giveups_total`,
  `tlcs_stalls_total` and `tlcs_resyncs_total` metrics (`METRICSPORT`): 0 = clean; a few `give-up … resync game` under injected
  loss are expected; a `stalled …` or `give-up critical` means a client stopped ACKing for 60 s (dead or starved).
- **Clocks** — `WTIME`/`BTIME` present and decreasing.
- **Errors** — `grep -iE 'error|warn|uncaught|unhandled' /tmp/uci-to-tlcs.log /tmp/node-tlcv.log /tmp/fastchess.log`.

node-tlcv names files `<N>_<white>_vs_<black>.pgn` from the results table, so repeated ordered pairs
(`-rounds 2`) do not overwrite each other. This needs `TOURNEYPGN`/`--pgn`.

## 6. Tear down

Kill the background jobs; `rm /tmp/{fc,uci-to-tlcs,node-tlcv,fastchess}.log`.

## Mock client modes

`npm run mock-client -- [flags]` (`--help` lists them). It binds, in precedence order:
`--local-port n` (fixed local port) > `--ephemeral` (OS port) > legacy same-port on
`127.0.0.2:<--port>`; `--ephemeral` with `--local-port` is a usage error.

| Flag | Meaning |
|---|---|
| `--mode node-tlcv` (default) | node-tlcv's rules: trim, `isIdRestart` + drop-if-not-increasing, ACK everything (`ACK: <idString>`), plain `PING` every 10 s, re-LOGON on an `MSG` containing "no longer connected" (rate-limited, only live data counts as recovery) and on the 600 s data watchdog |
| `--mode desktop` | TLCV 2.1c: untrimmed fixed-position parsing, ignores everything until `LOGON SUCCESSFUL`, last-100 duplicate ring, numbered `< N>PING` every 20 s once `FEATURE: PING` is seen, silence states at 10/30/50/70 s (exit 3 at 70 s) |
| `--force-ping` / `--no-disconnect` / `--chat <t>` | desktop only: ping without FEATURE, never exit on silence, send a numbered CHAT after logon |
| `--control <file>` | poll `<file>` (200 ms) and send each appended line as-is; a leading `#` sends it numbered with retransmit (desktop mode only). Drives scripted admin/chat steps |
| `--relogin-min <s>` (60), `--data-timeout <s>` (600) | node-tlcv re-LOGON floor / watchdog |
| `--drop <p>`, `--reorder <p>`, `--seed <n>` | seeded loss / 100-500 ms delay in both directions. Outbound `LOGON*` is exempt (node-tlcv never retries a lost LOGON) |
| `--transcript <f.jsonl>` | one JSON line per datagram/event: `ts, t, mode, user, session, dir, raw, id, body, verdict` (`accepted restart out-of-order unnumbered gated duplicate injected-drop injected-delay`) or `event` (`logon logon-ok relogon logoff silent-start silent-end disconnect ping-giveup logon-failed exit`) |
| `--logoff-after <s>` [`--logon-again-after <s>`] | LOGOFF, then re-LOGON (new `session`) or exit 0 |
| `--silent-after <s>` [`--silent-for <s>`] | send nothing (tests reaping) |
| `--exit-after <s>`, `--quiet` | LOGOFF + exit 0 / no pretty-print |

Desktop pretty-print shows the `Mid()`-parsed field (`SITE -> [ My Event]`; the leading
space is real: `Mid(body, 6)` of `SITE: x`).

The server ACKs a numbered desktop `< N>PING` and answers it with a numbered `PONG`, so `ping-giveup` events in a
desktop transcript now indicate a real problem.

## Launch / teardown pattern

Put every long-running process in its own process group and record the group id; never
`pkill -f` (it can match your own shell):

```bash
setsid bash -c 'echo $$ > "$S/name.pgid"; exec <cmd>' > "$S/name.log" 2>&1 &
trap 'cleanup' EXIT; trap 'exit 130' INT TERM      # cleanup: kill -TERM -- -$(cat "$S/name.pgid")
```

node-tlcv is a shared checkout: take `mkdir .../.tasks/locks/node-tlcv.lock`, and avoid editing its
config by running it with `CONFIG_DIR=<dir with config.json> PORT=... PGNS_DIR=... LOG_LEVEL=...`
(env beats `.env`).

## Variants

- **Local / mock client** (stand-in for node-tlcv): `npm run mock-client --
  --ephemeral` binds an OS port, LOGONs, ACKs every `<NNN>`, and pretty-prints what it
  receives (no loopback alias needed — we reply to the source port). Run it **alongside real
  fastchess** (the §3 commands, minus the kibitzer) to verify the bridge pushes the right
  `WPLAYER`/`BPLAYER` names and `WMOVE`/`BMOVE` stream without running node-tlcv — e.g. to
   confirm space-y engine names are pushed whole. For the strict same-port client instead, drop
  `--ephemeral` and use aliases (server `--bind 127.0.0.1`, client `--bind 127.0.0.2`,
  same port).
- **Late bridge**: node-tlcv's boot `LOGONv15` is lost if the bridge isn't up, but the bridge
  answers its next 10 s PING with the `MSG` notice and node-tlcv re-LOGONs — expect one
  `Re-sending LOGON` warn in node-tlcv's log.

## Acceptance run (restart + churn)

One scripted live tournament proves the whole stack, configured by `server.ini` only (the server is started as
`node dist/src/main.js --ini server.ini`, no other flag or env). Last passed: 2026-10-19 on `8dc7903` (one unattended in-run pass, all 13 gates).

**Set-up.** fastchess: 4 engines (one named `Berserk B` to cover names with spaces), EPD book with black-to-move starts,
`-rounds 1 -games 2 -concurrency 1`, `tc=60+0.6 option.Hash=16 option.Threads=1`,
`-resign movecount=3 score=600 -draw movenumber=40 movecount=8 score=10` (12 games, about 3 min each). The 100:1
base/increment ratio is close to the real 10 min + 5 s and about 10x slower than the `3+0.05` smokes, so it exercises
real-TC behaviour and not blitz backlog. Clients: real node-tlcv (ephemeral, private `CONFIG_DIR`), plus mocks:
a desktop (`--chat`), a node-tlcv (`--logoff-after 480 --logon-again-after 20`), a lossy node-tlcv
(`--drop 0.2 --reorder 0.05`), a silent one (`--silent-after 300 --silent-for 110`) and an admin/protocol probe
(`--force-ping --control`). Start order: server, wait for `TLCS server listening`, node-tlcv, mocks (2 s apart, one shared
per-IP rate-limit bucket), then fastchess.

| Trigger | Disruption | Proves |
|---|---|---|
| first game boundary | admin script: `<who>`, `CHANGE`, `ADMIN:`, `SECURITY`, `GAMELIST`, `RESULTTABLE` | session/admin/result protocol |
| +30 s | node-tlcv `kill -9`, relaunch 10 s later | new ephemeral dest, old one reaped at ~70 s, crash game exact |
| mock timers | silent for 110 s -> reaped -> `MSG` -> re-LOGON; node-tlcv-mode LOGOFF -> LOGON | churn |
| game K1, +20 s | server `kill -9`, restart after 15 s **with** `STATEFILE` | clients restored, numbered replay, no re-LOGON |
| game K1+1, +20 s | server `kill -9`, `state.json` deleted, restart | notice -> re-LOGON of node-tlcv-type clients, silent catch-up, operator re-opens the desktop (`desk2`) |
| a game later | late node-tlcv and late desktop join | full move history of the game in progress |
| end | `gl-probe` (plain and 20 % loss) | `GAMELIST`/`RESULTTABLE` dumps vs `fastchess` standings |

**Gates** (all must pass; evaluated offline by a script over the run directory):

1. Server command line is exactly the `--ini` form; the desktop got `SITE` and both `MENU` lines; fastchess exit 0, 12 games, no `Result "*"`.
2. `npm run e2e-check -- --fastchess games.pgn --pgns <node-tlcv pgns> --strict-numbers` passes. With `P2` = PGN count at the
   no-state kill and `P3` = PGN count when node-tlcv re-LOGONs, a game that ended in between is unrecoverable, so only these
   findings are allowed: `MISSING` for games `P2+1..P3`, `DIFF [number]` for game `P3+1`, and the matching `COUNT`.
3. Crosstable: `scripts/standings-check.ts` (`--fastchess-out`, `--pgn`, node-tlcv's `/<port>/result-table/json` and
   `/<port>/games/json`, and a raw `GL:`/`CT:` probe) agrees with fastchess's standings, also under 20 % loss.
4. `e2e-check --transcript` passes for every mock.
5. Crash and churn: the dead node-tlcv dest is reaped 60-95 s after the kill and its replacement LOGONs; the silent mock is reaped
   65-95 s after going quiet, then gets `MSG` and re-LOGONs; the desktop saw `DELUSER` for both.
6. Kill with `STATEFILE`: `state: restored n client(s)` with n = clients in the saved file, a `resume: … caught up games` line, a
   numbering dump per node-tlcv-type client; node-tlcv logs `Message ids restarting` and **no** `Re-sending LOGON`; mocks see a
   `restart` verdict without a re-LOGON; the desktop keeps receiving moves.
7. Kill without state: `state: no state file`, no resume dumps; each node-tlcv-type client gets the `MSG` notice and a `LOGON (new)`
   within 180 s, and nothing is sent to it before that; the desktop gets `MSG` and receives no game data until reopened.
8. Late join: both late clients receive `ADDUSER` for every connected user, both `MENU` lines and the full move list of the game in
   progress (`late-join-check`).
9. Protocol coverage (`<who>` `Users=`, alias, admin granted, `SECUSER`s, `GL`, `CT`, numbered PING ACK, chat echo, `FEATURE: PING`).
10. Reliability per destination: `stalled`, `give-up`, `hard cap` and `RESULTTABLE … lost` log lines are allowed only for a
    destination that is dead on purpose and only before it is reaped (silent mock, killed node-tlcv), plus `give-up … resync
    game` for the lossy clients. The Prometheus counters (`tlcs_giveups_total`, `tlcs_stalls_total`, `tlcs_resyncs_total`)
    must match the allowed log lines (`critical`/`control` give-ups equal; `1 <= tlcs_stalls_total <= stalled lines`, since one episode logs at start and again per new epoch). Any other `warn`/`error` is unclassified and fails the run.
11. `SAVEDEBUG`: exactly one `Debug-<white>_vs_<black>-<n>.log` per game (names sanitized `[^A-Za-z0-9._-]+ -> _`), no `.tmp`;
    the final `state.json` lists exactly the live clients.
12. `npm test`, `npm run typecheck`, `npm run build && node dist/src/main.js --help` are green; no leftover ports.

A `rate limit: dropping datagrams from 127.0.0.1` warning means the harness itself tripped the per-IP bucket (all clients are on
one IP): stagger the launches. A failure under host load (1-min load > 6, fastchess `time forfeit`) is rerun, not debugged.
Kill every process group at the end (`setsid` + pgid files, never `pkill -f`).

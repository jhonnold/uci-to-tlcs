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
`--allow-star`, `--allow-partial` (a node-tlcv game whose `[FEN]` is mid-game passes when it is the fastchess game's
tail from that position: a late join, a restart or lost lines), `--strict-numbers` (filename `N_` prefix must equal the fastchess game
index), `--expect-contiguous`, `--json`, and `--transcript <f.jsonl>` (repeatable) to check
mock transcripts (see below).

Then eyeball the logs:

- **Names** — `[White]`/`[Black]` are real engine names (not `Engine1`/`Engine2`);
  colours = side-to-move at start; stable across rounds.
- **Registration** — exactly one client in `/tmp/uci-to-tlcs.log` (`LOGONv15`); 0 =
  node-tlcv can't reach the bridge (check host/port), >1 = node-tlcv restarted.
- **Reliability** — `grep -E 'give-up|stale:|hard cap'` in the bridge log, or the `tlcs_giveups_total`,
  `tlcs_dropped_total` and `tlcs_resyncs_total` metrics (`METRICSPORT`): 0 = clean; a few `give-up` and `stale:` lines under
  injected loss or for a dead client are expected (best effort: the line is dropped; the client's next move reloads its FEN).
  A node-tlcv game it lost lines in is saved from the reload (`[SetUp][FEN]`): check those with `e2e-check --allow-partial`.
- **Clocks** — `WTIME`/`BTIME` present and decreasing.
- **Errors** — `grep -iE 'error|warn|uncaught|unhandled' /tmp/uci-to-tlcs.log /tmp/node-tlcv.log /tmp/fastchess.log`.

node-tlcv names files `<N>_<white>_vs_<black>.pgn` from the results table, so repeated ordered pairs
(`-rounds 2`) do not overwrite each other. This needs `TOURNEYPGN`/`--pgn`.

## 6. Tear down

Kill the background jobs; `rm /tmp/{fc,uci-to-tlcs,node-tlcv,fastchess}.log`.

## DMZ / WAN run (2026-10-20)

The same stack across a real network: a `tlcs-dmz` VM (homelab DMZ VLAN) ran fastchess + 4x Berserk and the
bridge on UDP 16001 (`server.ini` only, `STATEFILE` on; since retired). **Prod node-tlcv** on EC2 (ccrl.live) logged on through
a pfSense WAN forward locked to the node-tlcv source IP, non-ephemeral (its source port is 16001). The homelab host doc
(`docs/hosts/tlcs-dmz.md`) has the setup.

- Found: **PV panes were empty on prod.** We sent `WPV`/`BPV` in SAN; node-tlcv has parsed coordinates only since f465dc3.
  Fixed (coordinates; see `tlcs-wire.md` encoding invariants). The loopback acceptance gates never compared PV text, so it slipped
  through: check a live PV (`curl …/<port>/pgn` comments read `{(c5 Nf3 …) score/depth time}`, not `{() …}`).
- After the fix: 10 of 12 games finished before the run was stopped on purpose. Prod kept **1 session** throughout (one
  `LOGON (new)`, after a deliberate no-state restart: `notice` -> re-LOGON in 4 s). **0** `stalled`/`give-up`/`hard cap` log lines.
  Names with spaces, the black-to-move start and PVs showed correctly in prod's live PGN (`/16001/pgn`).
- Not done: `e2e-check`/`standings-check` against prod (no PGN export is reachable without touching prod; polling `/<port>/pgn`
  gives the live game only and mis-splits games when a snapshot lands mid-reset). With `-rounds 1`, fastchess plays **one opening
  for every game**, so use `-rounds` ≥ the number of book lines to cover them.

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
| game K1, +20 s | server `kill -9`, restart after 15 s | notice -> re-LOGON of node-tlcv-type clients, silent catch-up, live position, operator re-opens the desktop (`desk2`) |
| a game later | late node-tlcv and late desktop join | snapshot of the game in progress (position, not history) |
| end | `gl-probe` (plain and 20 % loss) | `GAMELIST`/`RESULTTABLE` dumps vs `fastchess` standings |

**Gates** (all must pass; evaluated offline by a script over the run directory):

1. Server command line is exactly the `--ini` form; the desktop got `SITE` and both `MENU` lines; fastchess exit 0, 12 games, no `Result "*"`.
2. `npm run e2e-check -- --fastchess games.pgn --pgns <node-tlcv pgns> --strict-numbers --allow-partial` passes. A game that
   ended between the kill and node-tlcv's re-LOGON is never sent, so only these findings are allowed: `MISSING` for those
   games and the matching `COUNT`; the game in progress at the re-LOGON (and any game node-tlcv lost lines in) is `partial OK`.
3. Crosstable: `scripts/standings-check.ts` (`--fastchess-out`, `--pgn`, node-tlcv's `/<port>/result-table/json` and
   `/<port>/games/json`, and a raw `GL:`/`CT:` probe) agrees with fastchess's standings, also under 20 % loss.
4. `e2e-check --transcript` passes for every mock.
5. Crash and churn: the dead node-tlcv dest is reaped 60-95 s after the kill and its replacement LOGONs; the silent mock is reaped
   65-95 s after going quiet, then gets `MSG` and re-LOGONs; the desktop saw `DELUSER` for both.
6. (retired: the `STATEFILE` restore no longer exists.)
7. Kill: a `start: caught up …` line; each node-tlcv-type client gets the `MSG` notice and a `LOGON (new)` within 180 s, and
   nothing is sent to it before that; then a numbering dump and the position steps of the live position (real node-tlcv:
   its `/broadcasts/<port>/pgn` `[FEN]` is the live position within a second of the LOGON); the desktop gets `MSG` and receives no
   game data until reopened.
8. Late join: both late clients receive `ADDUSER` for every connected user, both `MENU` lines and the snapshot (players, position
   steps, clocks, PV) of the game in progress.
9. Protocol coverage (`<who>` `Users=`, alias, admin granted, `SECUSER`s, `GL`, `CT`, numbered PING ACK, chat echo, `FEATURE: PING`).
10. Reliability per destination: `give-up`, `stale:`, `hard cap` and `RESULTTABLE … lost` log lines are allowed only for a
    destination that is dead on purpose and only before it is reaped (silent mock, killed node-tlcv), and for the lossy
    clients. The Prometheus counters (`tlcs_giveups_total`, `tlcs_dropped_total`) must match the allowed log lines
    (`tlcs_dropped_total{reason="giveup"}` = give-up lines). Any other `warn`/`error` is unclassified and fails the run.
11. `SAVEDEBUG`: exactly one `Debug-<white>_vs_<black>-<n>.log` per game (names sanitized `[^A-Za-z0-9._-]+ -> _`), no `.tmp`.
12. `npm test`, `npm run typecheck`, `npm run build && node dist/src/main.js --help` are green; no leftover ports.

A `rate limit: dropping datagrams from 127.0.0.1` warning means the harness itself tripped the per-IP bucket (all clients are on
one IP): stagger the launches. A failure under host load (1-min load > 6, fastchess `time forfeit`) is rerun, not debugged.
Kill every process group at the end (`setsid` + pgid files, never `pkill -f`).

## 8. Concurrent games (TLCS-MG)

Same stack as §3 with `-concurrency 3` (any N), plus TLCS-MG mocks. Every process via `run-logged`.

```bash
npm start -- --log fc.log --format fastchess --pgn games.pgn --bind 127.0.0.1 --port 16100
npx tsx scripts/mock-client.ts --port 16100 --ephemeral --user mg --multigame --transcript mg.jsonl --quiet
npx tsx scripts/mock-client.ts --port 16100 --ephemeral --user mglossy --multigame --drop 0.2 --seed 7 --transcript mglossy.jsonl --quiet
npx tsx scripts/mock-client.ts --port 16100 --ephemeral --user legacy --transcript legacy.jsonl --quiet
npx tsx scripts/mock-client.ts --port 16100 --ephemeral --user desk --mode desktop --transcript desk.jsonl --quiet
fastchess -engine name="Berserk A" cmd=berserk ... -engine name="Berserk D" cmd=berserk \
  -each tc=8+0.08 option.Hash=16 option.Threads=1 -rounds 1 -games 2 -concurrency 3 \
  -log file=fc.log engine=true realtime=true -pgnout file=games.pgn
```

Gates:

1. `npm run e2e-check -- --fastchess games.pgn --transcript mg.jsonl` (and `mglossy.jsonl`) PASS: for every `BOARD n GAMENO: k`
   the checker verifies names and result, and every SAN of game k, or, where the client joined late or lost lines (it models
   node-tlcv's FEN reload), the SANs since the reload and the final board; no board line precedes the `MULTIGAME:` reply and no
   bare game line follows it. A loss-free mock that opted in before the first game has one `GAMENO` per fastchess game.
2. `--legacy` on `legacy.jsonl`/`desk.jsonl` PASS: no TLCS-MG token ever reached them.
3. Un-upgraded node-tlcv on the same port: zero `Unable to process` warnings; its PGNs are the board-1 games
   (`e2e-check --allow-partial` against those fastchess games; their numbers can drift, see `docs/gaps.md`).
4. Kill the bridge mid-run and restart it: every node-tlcv-mode client re-LOGONs, and node-tlcv's live `[FEN]`
   (`curl :<web port>/broadcasts/<port>/pgn`) is the live position right after; its PGN for that game is `partial OK`.
5. Rerun §3 (`-concurrency 1`) the same way: `--strict-numbers --allow-partial` passes.

Measured (2026-11-15, coder, fastchess 1.8.2, 4 engines, EPD book, tc 8+0.08, 12 games; `.tasks/T13-lighter-delivery/`):

- `-concurrency 3`, bridge killed at +75 s and restarted 3 s later (1 s silent catch-up of 3 boards): gates 1-4 passed.
  Re-LOGON after the restart: node-tlcv +2.3 s, mocks +4.8 to +6.8 s; node-tlcv loaded the live board-1 position (move 125,
  right FMR) 0.4 s after its LOGON and saved that game from ply 249 (exact tail); its other 3 PGNs are complete. The desktop
  mock never re-LOGONs (the desktop TLCV waits for its operator). The 20 %-loss mock lost its `LOGON SUCCESSFUL` and never
  opted in during the first session (fixed since: the first numbered line stands in for it); after the restart it opted in and
  got its results 7-8 s after the loss-free mock (before best-effort delivery: about 4 min behind). 4 give-ups, 585 stale-move
  collapses (all for the lossy mock), no hard-cap eviction.
- Per client, loss-free, during play: 3 boards 12.3 KB/s, 140 datagrams/s (52 numbered/s); 1 board 3.6 KB/s, 46 datagrams/s
  (17.5 numbered/s); largest datagram 391 B (a long PV), median 48 B.
- `-concurrency 1`, same restart at +150 s: `--strict-numbers --allow-partial` PASS for all 12 games (the game in progress at the
  restart saved from ply 125), 0 node-tlcv warnings; the 20 %-loss mock got all 12 results, 0.1-9 s after the loss-free one
  (1 give-up, 189 stale collapses).

Run each scenario on a fresh node-tlcv: node-tlcv's `SITE` handler does not reset `currentGameNumber`, so a reused instance can
number a new tournament's first game after the previous tournament's last.


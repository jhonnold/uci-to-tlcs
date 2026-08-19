# E2E testing flow

The full live path: **fastchess** writes a UCI engine log → **uci-to-tlcs** tails it and
broadcasts TLCS over UDP → **node-tlcv** (a TLCS client/kibitzer) reconstructs and saves
PGNs. Then **wait** for fastchess to finish and **check the logs & PGNs**.

Data flow: `fastchess` → `/tmp/fc.log` → `uci-to-tlcs` (UDP `:16000`) → `node-tlcv`
(port `8099`) → `PGNS_DIR`. Reach for it before shipping a protocol/transport change, or
to verify a move/result/name/clock bug end-to-end.

## 1. Prerequisites

- `fastchess` (`~/projects/fastchess`, `make -j4`) and `berserk`
  (`~/projects/berserk`, `make CC=gcc build`) both on `PATH` (symlinked into
  `~/.local/bin`).
- `uci-to-tlcs`: `npm ci` (runs via `tsx`, no build needed). `node-tlcv`: `npm ci`.

## 2. Configure node-tlcv

`config/config.json` → one **ephemeral** connection to the bridge (binds an OS port and
relies on our source-port reply, so no same-host `EADDRINUSE`):

```json
{ "connections": [ { "connection": "127.0.0.1:16000", "ephemeral": true } ] }
```

`.env` → `PORT=8099`, `LOG_LEVEL=debug`, `PGNS_DIR=/tmp/node-tlcv-pgns`.

## 3. Run (bridge first)

```bash
# bridge — up first so node-tlcv's LOGON lands (see LOGON-race)
LOG_LEVEL=debug npm start -- --log /tmp/fc.log --pgn /tmp/ct.pgn --format fastchess \
  --bind 127.0.0.1 --port 16000 > /tmp/uci-to-tlcs.log 2>&1 &

# kibitzer
( cd ../node-tlcv && npm run dev-server ) > /tmp/node-tlcv.log 2>&1 &

# producer — engine names may contain spaces / versions / commit hashes; quote any
# name with a space. -concurrency 1 (games don't interleave), real tc= (ticking clocks).
# -pgnout feeds the bridge's PGN game database (one PGN appended per finished game).
fastchess -engine name="Berserk A" cmd=berserk -engine name="Berserk B" cmd=berserk \
  -engine name="Berserk C" cmd=berserk -engine name="Berserk D" cmd=berserk \
  -each tc=10+0.1 option.Hash=32 option.Threads=1 -rounds 3 -games 1 -concurrency 1 \
  -pgnout file=/tmp/ct.pgn append=true \
  -log file=/tmp/fc.log engine=true realtime=true > /tmp/fastchess.log 2>&1
```

The bridge tails `/tmp/fc.log` and **waits for it to appear**, so bridge-vs-fastchess
order doesn't matter — only bridge-vs-node-tlcv does.

## 4. Wait

Until fastchess prints its summary and exits. The bridge drains the last lines and stays
alive; node-tlcv keeps kibitzing until killed.

## 5. Check the logs & PGNs

Artifacts: `/tmp/node-tlcv-pgns/uci-to-tlcs/*.pgn` (ground truth), `/tmp/uci-to-tlcs.log`
(bridge), `/tmp/node-tlcv.log` (kibitzer), `/tmp/fc.log` (raw UCI), `/tmp/fastchess.log`
(fastchess results). Verify:

- **Names** — `[White]`/`[Black]` are real engine names (not `Engine1`/`Engine2`);
  colours = side-to-move at start; stable across rounds.
- **Results** — `[Result]`/`[Termination]` real (`1-0`/`0-1`/`1/2-1/2`); the count of `*`
  (board couldn't derive a result) should be 0 for normal games.
- **Count** — PGN files == fastchess's reported game count == bridge `new game` events.
- **Clocks** — `WTIME`/`BTIME` present and decreasing.
- **Registration** — exactly one client in `/tmp/uci-to-tlcs.log` (`LOGONv15`); 0 =
  LOGON-race, >1 = node-tlcv restarted.
- **Drops** — `grep -c 'unacked after 4 tries' /tmp/uci-to-tlcs.log`: 0 = clean, many = a
  slow consumer (gaps.md J). A handful over a fast RR is expected — node-tlcv self-corrects
  on the next `FEN`, so check names/results still land, not just the count.
- **Errors** — `grep -iE 'error|warn|uncaught|unhandled' /tmp/uci-to-tlcs.log /tmp/node-tlcv.log /tmp/fastchess.log`.

## 6. Tear down

Kill the background jobs; `rm /tmp/{fc,uci-to-tlcs,node-tlcv,fastchess}.log /tmp/ct.pgn`.

## Variants

- **Local / mock client** (stand-in for node-tlcv): `npm run mock-client --
  --ephemeral` binds an OS port, LOGONs, ACKs every `<NNN>`, and pretty-prints what it
  receives (no loopback alias needed — we reply to the source port). Run it **alongside real
  fastchess** (the §3 commands, minus the kibitzer) to verify the bridge pushes the right
  `WPLAYER`/`BPLAYER` names and `WMOVE`/`BMOVE` stream without running node-tlcv — e.g. to
   confirm space-y engine names are pushed whole. For the strict same-port client instead, drop
  `--ephemeral` and use aliases (server `--bind 127.0.0.1`, client `--bind 127.0.0.2`,
  same port).
- **LOGON-race**: node-tlcv sends `LOGONv15` once at boot and never retries. Bring the
  bridge up **before** node-tlcv, or it sits connected-but-unregistered (PINGs PONGed,
  0 moves).
- **Bridge starts mid-game (resync + parity binding)** — verifies `--from-end` against a
  log whose current game is already underway (the restart/attach case):
  1. Start fastchess as in §3 (with `-pgnout`); let game 2 get a few moves in.
  2. Start the bridge against the *live* log: `LOG_LEVEL=debug npm start -- --log
     /tmp/fc.log --pgn /tmp/ct.pgn --format fastchess --from-end --bind 127.0.0.1
     --port 16000` (`--from-end` skips the replayed history).
  3. Bring up a client (mock or node-tlcv) **after** the bridge.
  4. Check: the client gets real engine names in `WPLAYER`/`BPLAYER` (parity-bound from
     the resync `position`, corrected once the second engine's `go` lands), and the
     snapshot `FEN` equals the position the log has actually reached — recompute it by
     applying the log's `bestmove`s so far (chess.js, first three FEN fields) and diff.
     The viewer's move list starts at the join point (no history replay — expected).
- **Client joins mid-game (bridge already running)** — the regression path for the
  snapshot: bridge up from §3, then LOGON a second client (mock or a second node-tlcv
  config) during game 2; same assertions as above.

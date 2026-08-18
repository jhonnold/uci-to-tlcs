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
LOG_LEVEL=debug npm start -- --log /tmp/fc.log --format fastchess \
  --bind 127.0.0.1 --port 16000 > /tmp/uci-to-tlcs.log 2>&1 &

# kibitzer
( cd ../node-tlcv && npm run dev-server ) > /tmp/node-tlcv.log 2>&1 &

# producer — single-token engine names (multi-token names drop every line, gaps.md I),
# -concurrency 1 (games don't interleave), real tc= (ticking clocks), no adjudication.
fastchess -engine name=BerserkA cmd=BerserkA -engine name=BerserkB cmd=BerserkB \
  -engine name=BerserkC cmd=BerserkC -engine name=BerserkD cmd=BerserkD \
  -each tc=10+0.1 option.Hash=32 option.Threads=1 -rounds 3 -games 1 -concurrency 1 \
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
- **Retries** — `reliable send … unacked, retrying` count: 0 = clean, many = a slow
  consumer (gaps.md J).
- **Errors** — `grep -iE 'error|warn|uncaught|unhandled' /tmp/uci-to-tlcs.log /tmp/node-tlcv.log /tmp/fastchess.log`.

## 6. Tear down

Kill the background jobs; `rm /tmp/{fc,uci-to-tlcs,node-tlcv,fastchess}.log`.

## Variants

- **Local / mock client** (no fastchess or node-tlcv): `npm run mock-client --
  --ephemeral` binds an OS port and still receives (we reply to the source port), so no
  loopback alias is needed. To exercise the strict same-port client instead, drop
  `--ephemeral` and use aliases (server `--bind 127.0.0.1`, client `--bind 127.0.0.2`,
  same port).
- **LOGON-race**: node-tlcv sends `LOGONv15` once at boot and never retries. Bring the
  bridge up **before** node-tlcv, or it sits connected-but-unregistered (PINGs PONGed,
  0 moves).

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

# producer — engine names may contain spaces / versions / commit hashes; quote any
# name with a space. -concurrency 1 (games don't interleave), real tc= (ticking clocks).
fastchess -engine name="Berserk A" cmd=berserk -engine name="Berserk B" cmd=berserk \
  -engine name="Berserk C" cmd=berserk -engine name="Berserk D" cmd=berserk \
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
(fastchess results), plus fastchess's own `-pgnout file=/tmp/games.pgn` (add it to the
fastchess command in §3). Compare them mechanically:

```bash
npm run e2e-check -- --fastchess /tmp/games.pgn --pgns /tmp/node-tlcv-pgns
```

It checks game count, White/Black, Result, the full SAN list and that no `*` results
remain; games are matched by content (not by node-tlcv's game number, which is unreliable
until T07). It prints `PASS` or `FAIL n finding(s)` then one line per game (`DIFF [moves]
... first divergence at ply 10: exp X got Y`, `MISSING`, `EXTRA`, `COUNT`, `STAR`).
Exit 0 pass, 1 mismatch, 2 usage/IO error (including an empty `--pgns` dir). Other flags:
`--allow-star`, `--strict-numbers` (filename `N_` prefix must equal the fastchess game
index), `--expect-contiguous`, `--json`, and `--transcript <f.jsonl>` (repeatable) to check
mock transcripts (see below).

Then eyeball the logs:

- **Names** — `[White]`/`[Black]` are real engine names (not `Engine1`/`Engine2`);
  colours = side-to-move at start; stable across rounds.
- **Registration** — exactly one client in `/tmp/uci-to-tlcs.log` (`LOGONv15`); 0 =
  LOGON-race, >1 = node-tlcv restarted.
- **Retries** — `reliable send ... unacked, retrying` count: 0 = clean, many = a slow
  consumer (gaps.md J).
- **Clocks** — `WTIME`/`BTIME` present and decreasing.
- **Errors** — `grep -iE 'error|warn|uncaught|unhandled' /tmp/uci-to-tlcs.log /tmp/node-tlcv.log /tmp/fastchess.log`.

**Caveat:** until T07, node-tlcv names files `1_<white>_vs_<black>.pgn`, so the same
ordered pair overwrites its earlier game. Use tournaments whose ordered pairs are unique
(e.g. 3 engines, `-rounds 1 -games 2`), or the checker will report MISSING.

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
| `--relogin-min <s>` (60), `--data-timeout <s>` (600) | node-tlcv re-LOGON floor / watchdog |
| `--drop <p>`, `--reorder <p>`, `--seed <n>` | seeded loss / 100-500 ms delay in both directions. Outbound `LOGON*` is exempt (node-tlcv never retries a lost LOGON) |
| `--transcript <f.jsonl>` | one JSON line per datagram/event: `ts, t, mode, user, session, dir, raw, id, body, verdict` (`accepted restart out-of-order unnumbered gated duplicate injected-drop injected-delay`) or `event` (`logon logon-ok relogon logoff silent-start silent-end disconnect ping-giveup logon-failed exit`) |
| `--logoff-after <s>` [`--logon-again-after <s>`] | LOGOFF, then re-LOGON (new `session`) or exit 0 |
| `--silent-after <s>` [`--silent-for <s>`] | send nothing (tests reaping) |
| `--exit-after <s>`, `--quiet` | LOGOFF + exit 0 / no pretty-print |

Desktop pretty-print shows the `Mid()`-parsed field (`SITE -> [ My Event]`; the leading
space is real: `Mid(body, 6)` of `SITE: x`).

Today's server answers only a bare `PING` with `PONG`; a desktop `< N>PING` gets no reply, so
`ping-giveup` events in a desktop transcript are expected until T06.

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
- **LOGON-race**: node-tlcv sends `LOGONv15` once at boot and never retries. Bring the
  bridge up **before** node-tlcv, or it sits connected-but-unregistered (PINGs PONGed,
  0 moves).

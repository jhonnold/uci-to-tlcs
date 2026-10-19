# uci-to-tlcs

Broadcast chess games reconstructed from a **UCI engine transcript** over UDP in a
**TLCS-compatible** protocol, so [node-tlcv](https://github.com/jhonnold/node-tlcv)
(and the desktop TLCV) can watch them live. A single transcript may contain many
games and many matchups (e.g. a whole fastchess run); they are segmented and shown
in sequence on one board.

It's the inverse of node-tlcv: node-tlcv is a *client* of Tom's Live Chess Server;
this is a minimal *server* that speaks enough of the same wire protocol to drive it.
The protocol contract is defined empirically by what node-tlcv accepts — not by an
official spec — so this aligns with node-tlcv rather than being a 1:1 TLCS clone.

## How it works

```
log ──tail──▶ LogSource adapter ──▶ parser ──▶ Pipeline / GameState (chess.js) ──▶ TLCS UDP server ──▶ node-tlcv
```

A **`LogSource` adapter** normalizes one producer line into `{ uci, engineId?,
direction? }`, so different log producers can be supported without touching the
chess logic. Two adapters ship today (`--format`):

- **`fastchess`** — reads fastchess `-log file=… engine=true` output *directly* (no
  external stripping). The engine tags let it bind each game's player names to the
  right colour and detect game/matchup boundaries.
- **`raw`** — a bare, already-stripped UCI transcript. Games are still segmented
  (board resets between them), but without engine tags it can't bind names per game,
  so it falls back to CLI `--white`/`--black` (with `id name` filling the defaults).
- **`auto`** (default) sniffs the first line and picks one.

It live-tails the log and, for each event, emits the matching TLCS message(s):

| UCI | TLCS out | Notes |
|---|---|---|
| `position …` | `FEN` (+`FMR`) once at start | truncated FEN (`board stm castling`); board is authoritative |
| `go wtime … btime …` | `WTIME`/`BTIME` | ms → centiseconds (÷10) |
| `info … score … pv …` | `WPV`/`BPV` | score in side-to-move (engine) POV, matching TLCS; time ms→cs; PV coords→SAN; only `multipv 1` |
| `bestmove <coord>` | `FEN`, `WMOVE`/`BMOVE`, `FMR` | move number + SAN |
| game over (board) | `result:` | mate/stalemate/draw |
| new game (boundary) | `result:` (prev, if none) → `WPLAYER`/`BPLAYER` → startpos `FEN` | resets node-tlcv's board for the next game |

Reliability matches node-tlcv's transport: state-critical messages are ID-wrapped
(`<N>MSG`) and resent until `ACK: N`, in strict order, per client (a slow client never stalls another);
`WPV`/`BPV`/`WTIME`/`BTIME` are sent unwrapped. A client that logs on mid-game gets the **full
move history** of the current game replayed, and the results table (`RESULTTABLE`/`GAMELIST`) is rendered from the
tournament PGN.

Each client is tracked by its source `ip:port`, and the server replies to that
source port — not the fixed broadcast port that strict TLCS assumes. Compliant
clients (node-tlcv, desktop TLCV) send from the broadcast port, so this is identical
for them; it additionally lets clients on **ephemeral** ports receive the broadcast
and lets several clients share one host. A client that goes silent (no PING/ACK for
~70s; `CLIENTTIMEOUT` in the ini) is reaped. A PING/CHAT/CHANGE from an unknown (e.g. reaped) client gets
`MSG: You are no longer connected to the server.  Please re-connect.`, on which node-tlcv re-LOGONs.

## Quick start (fastchess tournament)

The whole server is configured by one `server.ini` (precedence: CLI flags > ini > defaults):

```bash
cp server.ini.example server.ini     # edit PORT, SITE, MENU, ...; PATH=fc.log and TOURNEYPGN=games.pgn are relative to this file
npm ci && npm run build
node dist/src/main.js --ini server.ini          # or: npm start -- --ini server.ini
```

Run the tournament from the same directory with **`-concurrency 1`**, a fresh `-pgnout` file, and the engine log
enabled (`TOURNEYPGN` makes every result exact, including resign/adjudication/forfeit):

```bash
fastchess -engine cmd=berserk name=A -engine cmd=berserk name=B -each tc=60+0.6 option.Hash=16 option.Threads=1 \
  -rounds 1 -games 2 -concurrency 1 \
  -log file=fc.log engine=true realtime=true -pgnout file=games.pgn
```

node-tlcv runs on the same host with one **ephemeral** connection (`config/config.json`):
`{ "connections": [ { "connection": "127.0.0.1:<PORT>", "ephemeral": true } ] }`. Start order does not matter
(a node-tlcv that boots first re-LOGONs on the server's notice). The server survives a `kill -9` and restart
mid-tournament, see "Restart and persistence". `docs/e2e-testing.md` has the full acceptance runbook.

## Usage

```bash
npm install
npm run build           # or run straight from source with tsx:
npm start -- --log path/to/game.uci --port 16066 --white "Engine A" --black "Engine B" --site "My Match"
```

Options: `--log <path>` (required), `--format auto|raw|fastchess` (auto),
`--port` (16066), `--bind` (0.0.0.0), `--white`/`--black`/`--site`, `--from-end` (skip
existing content; default is to resume at the current game, see "Restart and persistence"), `--ini <path>` (reference-style `server.ini`, see below),
`--pgn <path>`, `--delay-after-move <ms>`, `--delay-after-game <ms>`,
`--pv-interval <ms>` (default 200: min gap between PV updates; the mover's final PV is always sent before its move; 0 = every engine info),
`--metrics-port <n>` (Prometheus `/metrics`, default off), `--log-format human|json` (default human),
`--fen-setup-move <0|1>` (default 1: non-startpos games send a synthetic `(setup)` move so node-tlcv loads the FEN; desktop TLCV shows `1. (setup)` once, board correct). `LOG_LEVEL=debug` logs every UDP message.

`--pgn <path>` points at the fastchess `-pgnout` file; when set, its `Result` is the
authoritative result for each game (resign/adjudication/time forfeit included, zero
`*`). Use a **fresh** `-pgnout` file per run: fastchess appends, and old entries
misalign the game numbers.

With `--format fastchess` you point `--log` at the engine/tournament log
itself; with `--format raw` you point it at a pre-stripped transcript. `--white`/`--black`
are only used as the fallback names for the raw/untagged path. To attach to a log that is
*already running*, keep the default (read from start) so the top-of-file engine names are
learned — `--from-end` would skip them.

### server.ini

`npm start -- --ini server.ini` loads a reference-style (TLCS 1.6a) `server.ini`; `--log` becomes
optional (`PATH=` supplies it). Precedence: **CLI flags > ini > built-in defaults**, whatever the argument
order. See `server.ini.example` (for a fastchess tournament) and spec §8.1.

Parse rules: a key is an UPPERCASE `KEY=` at column 0 (case-sensitive, no space before `=`; the value is the
rest of the line). Lines starting with `'`, blank lines and unmatched lines are ignored (unmatched lines are
logged as warnings). CR, CRLF and LF all end a line; a later duplicate key wins. Numbers must be plain digits
(spaces around are trimmed) and in range, otherwise startup fails naming the line. Relative paths resolve
against the ini's directory.

| Key | Ref default | Our default | Notes |
| --- | --- | --- | --- |
| `PATH` | — | — | Log to tail (`--log`) |
| `PORT` | 16000 | 16066 | `--port` |
| `SITE` | Tom's live chess viewer | uci-to-tlcs | Verbatim (`--site`) |
| `DELAY` | 100 | 100 | ms |
| `DELAYAFTERMOVE` | 300 | 0 | ms (`--delay-after-move`) |
| `DELAYAFTERGAME` | 1000 | 0 | ms (`--delay-after-game`) |
| `MENU ID=n …` | — | none | Up to 10, ids 1..10, kept verbatim |
| `TOURNEYPGN` | — | — | Tournament PGN (`--pgn`) |
| `SAVEDEBUG` | 0 | 0 | `1` or `0` |
| `FENSETUPMOVE` | — | 1 | Extension, `1` or `0` (`--fen-setup-move`) |
| `ICSMODE`, `MAILSERVER`, `RETURNADD` | — | — | Accepted, warned, ignored |
| `FORMAT`* | — | auto | `auto`, `raw`, `fastchess` (`--format`) |
| `BIND`* | — | 0.0.0.0 | `--bind` |
| `STATEFILE`* | — | off | Connected clients + resume point, atomic JSON; a restart resumes without re-LOGON (see "Restart and persistence") |
| `CLIENTTIMEOUT`* | — | 70 | Idle-client reap timeout, seconds |
| `ADMINPASS`*, `MAXCLIENTS`* (0 = unlimited), `BANNED`* (IPs, comma/space separated, repeatable) | — | — / 0 / none | Admin commands (disabled without ADMINPASS; use a long random value), logon cap, silent source-IP drop. See `docs/tlcs-wire.md` "Admin & abuse" |
| `METRICSPORT`* | — | off | Prometheus `/metrics` HTTP port, bound to `BIND` (`--metrics-port`) |
| `LOGFORMAT`* | — | human | `human` or `json` (one `{"ts","level","msg"}` object per line) (`--log-format`) |

\* uci-to-tlcs extension, not in the reference server.

### Operations

`LOGFORMAT=json` switches stdout/stderr logs to JSON lines (same messages and `LOG_LEVEL`).
`METRICSPORT=<n>` serves `GET /metrics` (Prometheus text format 0.0.4); counters always count, only the endpoint is optional:
`curl http://127.0.0.1:<n>/metrics`.

| metric | type | labels |
|---|---|---|
| `tlcs_clients` | gauge | — |
| `tlcs_client_queue_depth` | gauge | `dest` (live clients) |
| `tlcs_retransmits_total` | counter | — |
| `tlcs_giveups_total` | counter | `kind` = game / control / critical |
| `tlcs_resyncs_total` | counter | `kind` = full (every logon) / giveup (game replay after a give-up) |
| `tlcs_coalesces_total`, `tlcs_stalls_total` | counter | — |
| `tlcs_messages_sent_total`, `tlcs_messages_received_total` | counter | `type` |

Point node-tlcv at it via `config/config.json`:
`{ "connections": ["<host>:16066"] }`.

## Restart and persistence

uci-to-tlcs can be killed (even `kill -9`) and restarted mid-tournament while the engine log keeps growing.
On startup it loads the PGN registry, scans the log for game starts, and catches up **silently and
synchronously** from the oldest game any restored client still needs (default: the current game); only then does it
go live. Game numbers are the 1-based index of game starts in the log, so use a fresh `-pgnout` file per log.

- **With `STATEFILE`** (written atomically on every client change and every ACKed game boundary; ignored when
  older than 10 min): connected clients are re-attached without a re-LOGON. Each gets exactly the games it has not
  fully ACKed, as coalesced replays with message ids restarting at 1 (node-tlcv accepts id 1 as a restart),
  preceded by a numbering dump (`CTRESET` + a one-row `CT:` table, then a 300 ms quiet period) so node-tlcv saves
  each replayed result under the right game number. A client that missed more than the last 3 games gets the last 3.
- **Without it** (missing, corrupt, stale): clients get the `MSG ... no longer connected` notice on their next PING
  and re-LOGON; a game that ended during the outage is lost for them. The desktop TLCV never re-logs on by itself: the operator reconnects it.
- **Truncation / rotation / replacement** of the log (smaller size, new inode, or vanish + reappear) re-scans and
  catches up the new file's current game; clients stay attached.
- **`--from-end`** skips all existing content: no catch-up, restored clients just see the next game.
- **`SAVEDEBUG=1`** copies each finished game's log segment to `Debug-<white>_vs_<black>-<n>.log` next to the ini
  (or next to the log without `--ini`); existing numbers are never rewritten.

## Testing

```bash
npm test                # unit tests via node:test (test/*.test.ts)
npm run typecheck && npm run build
```

**Local loop with the mock client**: it emulates node-tlcv (default) or the desktop TLCV (`--mode desktop`). Since
the server replies to the client's source port, the client can bind an ephemeral port on the same host (no loopback
alias needed):

```bash
npm start -- --log fixtures/sample-game.uci --port 16066 --bind 127.0.0.1 &
npm run mock-client -- --server 127.0.0.1 --port 16066 --ephemeral
# append lines to the log and watch them decode live
```

**Faithful end-to-end with real node-tlcv and fastchess** (single host, no Docker): see the Quick start above and
`docs/e2e-testing.md`, which also holds the restart/churn acceptance scenario and the checkers
(`npm run e2e-check`, `scripts/standings-check.ts`). Use a real `tc=` (not `st=`/`movetime`) so the clocks tick,
`-concurrency 1` so games don't interleave in one log, and `TOURNEYPGN`/`--pgn` so every result is exact (any
adjudication or forfeit included); without it a non-board ending emits `result: *`. Needs node-tlcv checked out at
`../node-tlcv`.

## Scope

In scope:

- Sequential multi-game / multi-matchup tournaments on one port (`-concurrency 1`), from a fastchess log
  (`--format fastchess`) or a pre-stripped UCI transcript (`--format raw`, CLI names).
- The TLCS session, result and admin protocol as node-tlcv and the desktop TLCV use it: logon burst and user list,
  chat/alias, `MENU`, `RESULTTABLE`/`GAMELIST` from the tournament PGN, admin (`ADMINPASS`), ban list, `MAXCLIENTS`,
  per-IP rate limit, a Prometheus endpoint.
- Restart persistence (`STATEFILE`): kill and restart mid-tournament without losing clients, games or numbering.

Out of scope: concurrent games (`-concurrency > 1`), a WinBoard/myracle adapter, `ICSMODE` and e-mail, several
broadcasts per process, and the reference server's strict `clientIP:<broadcast port>` addressing mode.
See `docs/gaps.md` for the status table, known limitations and node-tlcv follow-ups.

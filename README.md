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
chess logic. Three adapters ship today (`--format`):

- **`fastchess`** — reads fastchess `-log file=… engine=true` output *directly* (no
  external stripping). The engine tags let it bind each game's player names to the
  right colour and detect game/matchup boundaries.
- **`myracle`** — reads myracle's tournament `.debug` log *directly*. Lines look like
  `863187 >first : uci` (ms timestamp, `>`/`<` direction, `first`/`second` engine tag).
  The tag is remapped to the real display name (learned from the `Starting engine N`
  banner and the engine's `id name`), so names bind to the right colour like fastchess.
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
(`<N>MSG`) and resent until `ACK: N`, in strict order; `WPV`/`BPV`/`WTIME`/`BTIME`
are sent unwrapped. Late joiners get a unicast snapshot of current state.

Each client is tracked by its source `ip:port`, and the server replies to that
source port — not the fixed broadcast port that strict TLCS assumes. Compliant
clients (node-tlcv, desktop TLCV) send from the broadcast port, so this is identical
for them; it additionally lets clients on **ephemeral** ports receive the broadcast
and lets several clients share one host. A client that goes silent (no PING/ACK for
~30s) is reaped.

## Usage

```bash
npm install
npm run build           # or run straight from source with tsx:
npm start -- --log path/to/game.uci --pgn /tmp/ct.pgn --port 16066 --white "Engine A" --black "Engine B" --site "My Match"
```

Options: `--log <path>` (required), `--pgn <path>` (required — the PGN game database,
e.g. fastchess's `-pgnout file`; finished games are numbered from it),
`--format auto|raw|fastchess|myracle` (auto),
`--port` (16066), `--bind` (0.0.0.0), `--white`/`--black`/`--site`, `--from-end` (skip
existing content). `LOG_LEVEL=debug` logs every UDP message. The PGN file may not exist
yet (fastchess creates it at the first finished game) — a warning is enough.

With `--format fastchess` (or `myracle`) you point `--log` at the engine/tournament log
itself; with `--format raw` you point it at a pre-stripped transcript. `--white`/`--black`
are only used as the fallback names for the raw/untagged path. To attach to a log that is
*already running*, keep the default (read from start) so the top-of-file engine names are
learned — `--from-end` would skip them and the myracle path would fall back to `first`/`second`.

Point node-tlcv at it via `config/config.json`:
`{ "connections": ["<host>:16066"] }`.

## Testing

```bash
npm test                # unit tests (parser, encoder, pipeline) via node:test
```

**Local loop with the mock client** — emulates node-tlcv. Since the server replies to
the client's source port, the client can bind an ephemeral port on the same host (no
loopback alias needed):

```bash
npm start -- --log fixtures/sample-game.uci --pgn /tmp/ct.pgn --port 16066 --bind 127.0.0.1 &
npm run mock-client -- --server 127.0.0.1 --port 16066 --ephemeral
# append lines to the log and watch them decode live
```

(To emulate a strict TLCS client that binds the broadcast port instead, drop
`--ephemeral` and run the client on a loopback alias, e.g. `--bind 127.0.0.2`.)

**Faithful end-to-end with real node-tlcv (single host, no Docker)** — node-tlcv now
supports an *ephemeral* connection mode, so it runs alongside the bridge on one host (no
container or loopback alias). Point its `config/config.json` at the bridge:

```json
{ "connections": [ { "connection": "127.0.0.1:16066", "ephemeral": true } ] }
```

Start the bridge **first** (it must be listening before node-tlcv boots — node-tlcv LOGONs
once and never retries), start node-tlcv, then feed it a real game from fastchess:

```bash
# 1) bridge — tails the fastchess log directly (no sed), broadcasts on 16066
npm start -- --log /tmp/fc.log --pgn /tmp/ct.pgn --format fastchess --port 16066 --bind 127.0.0.1 &
# 2) node-tlcv (in ../node-tlcv): npm run dev-server   → http://127.0.0.1:8080/16066
# 3) real games — multiple games / matchups in one log are fine; -pgnout feeds the bridge's PGN
fastchess -engine cmd=<engineA> -engine cmd=<engineB> -each tc=10+0.1 \
  -rounds 4 -games 2 -repeat -concurrency 1 \
  -pgnout file=/tmp/ct.pgn append=true \
  -log file=/tmp/fc.log engine=true realtime=true
```

With `--format fastchess` the bridge consumes the engine-tagged log directly, so the
player names come from the run and swap correctly each game. (The old `--format raw`
path with `tail -F … | sed -u -E 's/.*(<--- |---> )//' >> /tmp/live.uci` still works
for pre-stripped transcripts.) Use a real `tc=` (not `st=`/`movetime`) so the clocks
tick, `-concurrency 1` so games don't interleave in one log, and no fastchess
adjudication so games end on the board (a non-board end emits `result: *`). Needs
node-tlcv checked out at `../node-tlcv`.

## Scope

Sequential multi-game / multi-matchup on one port (each game replaces the previous on
the board; assumes `-concurrency 1` so the log isn't interleaved). Player-name binding
needs a tagged producer (`--format fastchess`); the raw path keeps CLI names. Results
are board-derived (mate/stalemate/draw); an adjudicated/unknown end emits `result: *`.
A new game that starts from a *non-startpos* position won't visually reset node-tlcv's
board. Clients joining mid-game — including a bridge that started mid-game
(`--from-end`) — get site, player names, and the current position (not full move
history; the join point becomes the start of the shown game). Finished games are
numbered from the `--pgn` file (see `src/pgn.ts`); the RESULTTABLE reply is still a
minimal stub. See the comments in `src/` and `docs/` for the rationale behind each.

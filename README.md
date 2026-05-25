# uci-to-tlcs

Broadcast a chess game reconstructed from a **raw UCI engine transcript** over UDP
in a **TLCS-compatible** protocol, so [node-tlcv](https://github.com/jhonnold/node-tlcv)
(and the desktop TLCV) can watch it live.

It's the inverse of node-tlcv: node-tlcv is a *client* of Tom's Live Chess Server;
this is a minimal *server* that speaks enough of the same wire protocol to drive it.
The protocol contract is defined empirically by what node-tlcv accepts — not by an
official spec — so this aligns with node-tlcv rather than being a 1:1 TLCS clone.

## How it works

```
UCI transcript ──tail──▶ parser ──▶ GameState (chess.js) ──▶ TLCS UDP server ──▶ node-tlcv
```

It live-tails the transcript and, for each event, emits the matching TLCS message(s):

| UCI | TLCS out | Notes |
|---|---|---|
| `position …` | `FEN` (+`FMR`) once at start | truncated FEN (`board stm castling`); board is authoritative |
| `go wtime … btime …` | `WTIME`/`BTIME` | ms → centiseconds (÷10) |
| `info … score … pv …` | `WPV`/`BPV` | score normalized to White POV; time ms→cs; PV coords→SAN; only `multipv 1` |
| `bestmove <coord>` | `FEN`, `WMOVE`/`BMOVE`, `FMR` | move number + SAN |
| game over (board) | `result:` | mate/stalemate/draw |

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
npm start -- --log path/to/game.uci --port 16066 --white "Engine A" --black "Engine B" --site "My Match"
```

Options: `--log <path>` (required), `--port` (16066), `--bind` (0.0.0.0),
`--white`/`--black`/`--site`, `--from-end` (skip existing content). `LOG_LEVEL=debug`
logs every UDP message.

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
npm start -- --log fixtures/sample-game.uci --port 16066 --bind 127.0.0.1 &
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
# 1) bridge — tails a transcript, broadcasts on 16066
npm start -- --log /tmp/live.uci --port 16066 --bind 127.0.0.1 --white A --black B &
# 2) node-tlcv (in ../node-tlcv): npm run dev-server   → http://127.0.0.1:8080/16066
# 3) real game → stripped raw UCI → the transcript the bridge tails
fastchess -engine cmd=<engineA> -engine cmd=<engineB> -each tc=10+0.1 \
  -rounds 1 -games 1 -log file=/tmp/fc.log engine=true realtime=true &
tail -F /tmp/fc.log | sed -u -E 's/.*(<--- |---> )//' >> /tmp/live.uci
```

Use a real `tc=` (not `st=`/`movetime`) so the clocks tick, and run without fastchess
adjudication so the game ends on the board (only mate/stalemate/draw yields a `result:`).
Needs node-tlcv checked out at `../node-tlcv`.

## Scope (v1)

Single game on one port; board-derived results only (no resign/adjudication signal in
pure UCI); mid-game joiners get the current position (not full move history); minimal
RESULTTABLE. See the comments in `src/` and the plan for the rationale behind each.

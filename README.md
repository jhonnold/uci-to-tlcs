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

**Local loop with the mock client** — emulates node-tlcv. Because a TLCS client binds
the same port it sends to, the server and client can't share a port on one host; use
loopback aliases:

```bash
npm start -- --log fixtures/sample-game.uci --port 16066 --bind 127.0.0.1 &
npm run mock-client -- --server 127.0.0.1 --port 16066 --bind 127.0.0.2
# append lines to the log and watch them decode live
```

**Faithful end-to-end with real node-tlcv** — two containers (real node-tlcv binds
the port wildcard, so it needs its own IP):

```bash
docker compose -f docker-compose.test.yml up --build
# open http://localhost:8080/
```
(Needs node-tlcv checked out at `../node-tlcv`; `e2e/config.json` points it here.)

## Scope (v1)

Single game on one port; board-derived results only (no resign/adjudication signal in
pure UCI); mid-game joiners get the current position (not full move history); minimal
RESULTTABLE. See the comments in `src/` and the plan for the rationale behind each.

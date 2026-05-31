# CLAUDE.md

`uci-to-tlcs` reconstructs chess games from a **UCI engine log** (one log may hold
many games/matchups) and broadcasts them over UDP in a **TLCS-compatible** protocol,
so node-tlcv (and the desktop TLCV) can watch live. It is the inverse of node-tlcv: a
minimal TLCS *server*. See `README.md` for the full CLI, the UCI→TLCS encoding table,
the data flow, and scope — this file only captures what isn't obvious from the code.

## Commands

```bash
npm test          # unit tests (parser, encoder, pipeline) via node:test
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
npm start -- --log <path> [opts]   # run from source via tsx
npm run dev       # tsx watch
```

## Architecture seam

`tail → LogSource → parser → Pipeline → GameState (chess.js) → TlcsServer → UDP`.
Three concerns, kept separate on purpose:
- **`source/` (LogSource adapter)** normalizes one producer line into
  `{ uci, engineId?, direction? }` and nothing more — no chess, no segmentation.
  `RawUciSource` (untagged), `FastchessSource` and `MyracleSource` (engine-tagged) ship;
  `--format` / `makeSource` pick one (`auto` sniffs the first decisive line, tagged
  matchers before the loose `looksLikeRawUci`). Add a producer = add an adapter, don't
  touch the pipeline. An adapter MAY be stateful for *identity* only (e.g. `MyracleSource`
  remaps its `first`/`second` tag to the real display name, learned from the `Starting
  engine N` banner + the engine's `id name` — `id name` wins, it's hyphen-safe) — never
  for chess or segmentation.
- **`pipeline.ts` / `game/game-state.ts`** own all unit/perspective conversion **and**
  game segmentation. The `BroadcastSink` interface (`pipeline.ts`) is the test seam —
  `encoder.test.ts` / `multigame.test.ts` drive the pipeline through a fake sink with
  no sockets.
- **`tlcs/server.ts`** only transports. Keep conversion/segmentation out of it.

## Gotchas

- **ESM / NodeNext**: import with a `.js` extension even for `.ts` files
  (`import { GameState } from './game/game-state.js'`). Wrong extension = build break.
- **Protocol is reverse-engineered, not specced.** The TLCS wire contract is defined
  empirically by what node-tlcv accepts (`../node-tlcv` `src/game-service.ts`,
  `src/kibitzer/uci-parser.ts`, `src/udp-transport.ts`). Cross-check there before
  changing any wire format — there is no official spec.
- **Two send channels, different rules** (`tlcs/server.ts`):
  - *Reliable* (`sender.enqueue`) — ID-wrapped `<N>MSG`, ACKed, **stop-and-wait with
    strictly monotonic ids** (node-tlcv drops any id ≤ last seen). Used for
    state-critical msgs: SITE / PLAYER / FEN / MOVE / FMR / result / user / chat.
  - *Unwrapped* (`broadcastUnwrapped`) — fire-and-forget, high frequency: WPV / BPV /
    WTIME / BTIME. Don't move a message between channels casually.
- **Replies go to the source `ip:port`, not the broadcast port** (`tlcs/server.ts`).
  Strict TLCS ignores the source port and streams to `clientIP:<broadcastPort>`; we
  deliberately diverge so ephemeral-port clients work and several can share a host.
  It stays compatible because compliant clients (node-tlcv, desktop TLCV) send *from*
  the broadcast port, so source port == broadcast port. The client registry is keyed
  by the `ip:port` "dest" token (`destKey`); `rawSend(ip, port)` is the low-level send
  and `rawSendTo(dest)` splits a token. A client silent past `clientTimeoutMs` (30s ≈
  three missed 10s PINGs) is reaped — idle-timeout only, *never* on a reliable ACK
  timeout, because node-tlcv LOGONs once and never re-registers, so a false drop is
  unrecoverable.
- **Encoding invariants** (easy to regress, all enforced implicitly): 3-field
  truncated FEN (`board stm castling`); time ms→centiseconds (÷10); `score cp` is
  broadcast in side-to-move (engine) POV — each engine's own perspective, matching
  real TLCS, **no** White-POV flip; only `multipv 1` is the broadcast eval; mate
  mapped to ±(100000 − n) so node-tlcv renders it decisive.
- **Moves are emitted from two paths, deduped (`pipeline.ts`).** A move is broadcast
  either when its `bestmove` arrives *or* when a `position … moves` command first reveals
  it (a forward prefix-extension of the current list → `onPosition` applies + emits each
  new ply via `applyAndEmit`). This matters because myracle logs the opponent's
  `position` feed **before** that engine's own `bestmove`, so the move would otherwise be
  silently swallowed by the resync and never broadcast (≈half the game lost). `onBestMove`
  dedupes: if the move already tails `currentMoves` (pre-revealed via `position`) it's
  skipped — safe because consecutive plies can't share from/to coordinates. The game's
  **final** move never gets a following `position`, so `bestmove` stays its only path
  (and is where the terminal `result:` check lands). fastchess/raw always log `bestmove`
  before the including `position`, so their `position` deltas are empty — behaviour
  unchanged.
- **Results are board-derived only.** Pure UCI has no resign/adjudication signal, so
  only mate/stalemate/draw on the board produces a `result:` (`game-state.ts`). At a
  game boundary, if the previous game produced none, the pipeline synthesizes
  `result: *` (PGN unknown) so node-tlcv finalizes and re-arms (next gotcha).
- **Multi-game segmentation lives in `pipeline.ts`.** One log can hold many games/
  matchups (assume `-concurrency 1`; interleaved logs can't be demuxed). A new game
  is detected by a `position` move list that isn't a prefix-extension of the current
  one (covers startpos-no-moves and divergence); on the tagged path a `ucinewgame`
  (direction `in`) also triggers it and names the participants. **Name→colour binding
  needs a tagged producer**: White = the engine that gets `position startpos`+the first
  `go`; Black = the other `ucinewgame` participant. **Don't assume both `ucinewgame`s
  precede the first `go`** — fastchess batches them, but myracle inits engines one at a
  time, so the 2nd engine's `ucinewgame` can land *after* White's `go` (even after its
  first `info`). So `maybeBindBlack()` binds Black + emits the header when *both* are
  known (called from both `onUciNewGame` and `onGo`, whichever is last), not eagerly at
  `go`; `collectingParticipants` stays open until then so the late `ucinewgame` doesn't
  trigger a spurious new game. `onBestMove` is the header backstop. Untagged input keeps
  positional/CLI names (`id name` fills defaults for game 1 only).
- **node-tlcv new-game contract** (reverse-engineered, drives the per-game emit order
  `result → WPLAYER → BPLAYER → startpos FEN → moves`; see `../node-tlcv/src/game-service.ts`):
  (1) board reset fires only on a **startpos** FEN while loaded (`onFen`) — a non-startpos
  new-game FEN won't reset it; (2) WPLAYER/BPLAYER set `resetMoves`, so **both players
  must precede move 1** or the shown move is wiped (`buildGameDelta`); (3) `gameStartArmed`/
  PGN finalize re-arm **only on `result:`** (`onResult`) — hence the synthesized `*`.

## Testing the live path

- **Local**: `scripts/mock-client.ts --ephemeral` binds an OS-assigned port and still
  receives (we reply to the source port), so no loopback alias is needed. To exercise
  the strict same-port client instead, drop `--ephemeral` and use an alias (server
  `--bind 127.0.0.1`, client `--bind 127.0.0.2`, same port).
- **Faithful e2e, single host (no Docker)**: real node-tlcv now supports an *ephemeral*
  connection mode, so it coexists with the bridge on one host. Point its
  `config/config.json` at the bridge —
  `{ "connections": [ { "connection": "127.0.0.1:16066", "ephemeral": true } ] }` — so it
  binds an OS port instead of the broadcast port (no same-host `EADDRINUSE`) and relies on
  our source-port reply. Start the bridge first (`--bind 127.0.0.1 --port 16066
  --format fastchess`), then `npm run dev-server` in `../node-tlcv`, then drive real
  game(s) with fastchess — the bridge tails the engine log **directly** (no `sed`):
  `fastchess -engine cmd=<sf> -engine cmd=<berserk> -each tc=10+0.1 -rounds 4 -games 2 -repeat -concurrency 1 -log file=/tmp/fc.log engine=true realtime=true`
  with `--log /tmp/fc.log --format fastchess`. Watch at `http://127.0.0.1:8080/16066`
  (or `curl …/16066/pgn`). Use a real `tc=` (not `st=`/`movetime`) for ticking clocks,
  `-concurrency 1` so games don't interleave, and no adjudication so games end on the
  board. (`--format raw` + `tail -F … | sed -u -E 's/.*(<--- |---> )//' >> /tmp/live.uci`
  is the old pre-stripped path.) README has the full runbook.
- **LOGON-race**: node-tlcv sends `LOGONv15` once at boot and never retries. Bring the
  bridge up **before** node-tlcv, or it sits connected-but-unregistered (PINGs PONGed,
  0 moves).

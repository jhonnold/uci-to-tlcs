# Pipeline: move emission, results & multi-game segmentation

What to reach for: changing how/when a move is broadcast, changing result detection,
or touching game boundaries / player-name binding in `pipeline.ts` and
`game/game-state.ts`.

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

- **Book / pre-join prefix is replayed as moves.** A game-start `position … moves …` is
  validated whole, then the board is rewound to the base and the prefix is held in
  `openingMoves`; at header time (`emitGameHeaderIfReady`) it is replayed through
  `applyAndEmit` after the base position, so clients see the book moves (node-tlcv tags
  them `(Book)` — no PV precedes them). Book plies count in `currentMoves`; the `(setup)`
  move does not. Non-startpos base: `emitBasePosition` sends `FEN startpos`+FMR 0, `FEN X`+FMR,
  then `xMOVE (setup)` (gated by `fenSetupMove`; off = plain `FEN X`).

- **Stale PVs are dropped** (`onInfo`): no active game, an `in`-direction line, or (both
  colours bound) info from the engine not on move. PVs are sent at `info` time, i.e. before
  the move's FEN/xMOVE (§9.7).

- **`level`** is emitted once per tagged game at the first clock-bearing `go`
  (`formatLevel`): fastchess pre-adds the increment, so base = wtime − winc; needs
  `wtime == btime`. No-op in node-tlcv. Needs the sink's optional `emitLevel`.

- **Pacing** (`paced-sink.ts`): `DELAYAFTERMOVE`/`DELAYAFTERGAME` hold the queue after each
  `emitMove`/`emitResult`, only after the tailer reaches EOF (`setLive()`), so log replay is
  not slowed. This includes the synthetic `(setup)` move and replayed book plies (a 16-ply
  book at 500 ms stalls ~8 s at game start) — deliberate, simplest. The queue is unbounded
  like the reference's pause-after-move; one warning at >1000 queued sends.

- **Results are board-derived only.** Pure UCI has no resign/adjudication signal, so
  only mate/stalemate/draw on the board produces a `result:` (`game-state.ts`). At a
  game boundary, if the previous game produced none, the pipeline synthesizes
  `result: *` (PGN unknown) so node-tlcv finalizes and re-arms (see
  `tlcs-wire.md`, node-tlcv new-game contract).

- **Multi-game segmentation lives in `pipeline.ts`.** One log can hold many games/
  matchups (assume `-concurrency 1`; interleaved logs can't be demuxed). A new game
  is detected by a `position` move list that isn't a prefix-extension of the current
  one (covers startpos-no-moves and divergence); on the tagged path a `ucinewgame`
  (direction `in`) also triggers it and names the participants. **Name→colour binding
  needs a tagged producer**: the engine that gets the first `go` plays the side to move
  of its `position` (fastchess sends the first `go` to the side to move, so a black-to-move
  EPD/book start makes it Black); the other `ucinewgame` participant plays the other colour. **Don't assume both `ucinewgame`s
  precede the first `go`** — fastchess batches them, but myracle inits engines one at a
  time, so the 2nd engine's `ucinewgame` can land *after* White's `go` (even after its
  first `info`). So `maybeBindColours()` binds colours + emits the header when *both* are
  known (called from both `onUciNewGame` and `onGo`, whichever is last), not eagerly at
  `go`; `collectingParticipants` stays open until then so the late `ucinewgame` doesn't
  trigger a spurious new game. `onBestMove` is the header backstop. Untagged input keeps
  positional/CLI names (`id name` fills defaults for game 1 only).

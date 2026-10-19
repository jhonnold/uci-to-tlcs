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
- **PVs are coalesced** (`--pv-interval`, default 200 ms; 0 = legacy every-info): `onInfo` only
  stores the latest raw info (tagged with game sequence + ply); it is converted to SAN and
  emitted at most once per interval (first info after a gap goes out at once, later ones are
  flushed by an unref'd timer) and **always** by `applyAndEmit` before the move, against the
  pre-move board. A pending PV is dropped on a new game, a board-replacing `position`, `quit`,
  `Pipeline.close()`, or if the ply changed. A latest info whose PV converts to nothing yields
  no update (never a wrong one). A hosting layer that discards a Pipeline (session swap) must
  call `close()`. SAN conversion reuses one probe board with object-form moves
  (string moves make chess.js generate SAN for every legal move); identical `position`
  resends are not rebuilt.

- **`level`** is emitted once per tagged game at the first clock-bearing `go`
  (`formatLevel`): fastchess pre-adds the increment, so base = wtime − winc; needs
  `wtime == btime`. No-op in node-tlcv. Needs the sink's optional `emitLevel`.

- **Pacing** (`paced-sink.ts`): `DELAYAFTERMOVE`/`DELAYAFTERGAME` hold the queue after each
  `emitMove`/`emitResult`, only after the tailer reaches EOF (`setLive()`), so log replay is
  not slowed. This includes the synthetic `(setup)` move and replayed book plies (a 16-ply
  book at 500 ms stalls ~8 s at game start) — deliberate, simplest. The queue is unbounded
  like the reference's pause-after-move; one warning at >1000 queued sends.

- **Results: PGN-authoritative with `--pgn`/`TOURNEYPGN` (board and `*` fallback without it).** Pure UCI has no
  resign/adjudication/forfeit signal, so without a PGN only mate/stalemate/draw on the
  board produces a `result:` (`game-state.ts`), and at a game boundary a game with none
  gets a synthesized `result: *` (see `tlcs-wire.md`, node-tlcv new-game contract).
  With `--pgn <fastchess -pgnout file>` (`src/results/`: `ByteLineReader` ->
  `PgnStreamParser` -> `GameRegistry`) the Pipeline numbers its own games (`gameNumber`,
  opened at `ucinewgame` / header) and asks the registry (`ResultAuthority`) for entry
  N. The PGN `Result` is sent as `result: <r>` (no reason) at the earliest of: (a) the
  **ply gate** (`plies >= PlyCount`, or `PlyCount-1` for `illegal move`; only when the
  PGN White/Black equal the bound names as an unordered set, so a stale/appended PGN
  cannot fire mid-game); (b) the **boundary** (next `ucinewgame`; the PGN is re-read
  once, synchronously; no entry -> board result or `*` with a warning); (c) an `in`
  `quit` (end of tournament; same pull, but no entry means do nothing). A board-terminal
  game with no entry after `holdTicks` polls (~2 s) gets its board result plus a
  warning. `emitResultOnce` is the only `sink.emitResult` call site: one result per
  game. fastchess writes entry k before game k+1's `ucinewgame`; `quit` can also appear
  mid-tournament (`recover`, `restart=on`), which is safe because lookup is by live game
  number. Use a fresh `-pgnout` file: fastchess appends, so an old file misaligns game
  numbers (startup warns when it already holds games).

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

## Startup and restart

`src/app.ts` (`startApp`) runs: load `STATEFILE` -> `registry.refresh()` -> `scanGameStarts` -> `planResume`
(start game `S` = min(current game, every restored client's `next`, clamped to the last 3) ) -> bind the socket ->
in the `listening` turn, synchronously feed the log from `starts[S-1]` to EOF through `PacedSink` (not live) and
`ResumeSink` -> `setLive()` -> start the tailer at the catch-up's end offset. `ResumeSink` attaches each restored
client right before its `next` game's `setPlayers` and queues a numbering dump ahead of every replayed game; its
per-client queue is therefore `dump(a), game a ... result a, dump(a+1), game a+1, ...` (the sender is FIFO and a coalesce
re-inserts a game's replay at its first removed index, so a game never crosses its own dump). `next` per client is
the oldest game it has not fully ACKed (game item of g -> g, `result` of g -> g+1), persisted by `StateStore` in the
same JS turn as the ACK. Rotation re-runs the same session for the new file's current game.

- **Segmentation plus the PGN game count let a restart skip finished games.** `scanGameStarts` finds the
  log's game boundaries with the same rules as the live segmenter, and the registry says how many games are
  finished. `planResume` therefore starts the catch-up at the oldest game any restored client still needs
  (default: the game in progress) and feeds only that part of the log; earlier games are never replayed.
  Clients that were not restored (no `STATEFILE`, or a corrupt/stale one) receive nothing until they re-LOGON,
  and then get the full history of the current game.

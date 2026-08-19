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
  needs a tagged producer**: White = the engine that gets `position startpos`+the first
  `go`; Black = the other `ucinewgame` participant. **Don't assume both `ucinewgame`s
  precede the first `go`** — fastchess batches them, but myracle inits engines one at a
   time, so the 2nd engine's `ucinewgame` can land *after* White's `go` (even after its
   first `info`). So `maybeBindPlayers()` completes the bind + emits the header when one
   side is known and exactly one other participant exists (called from `onUciNewGame`,
   `onGo`, and the resync path below — whichever lands last), not eagerly at `go`;
   `collectingParticipants` stays open until then so a late participant doesn't trigger
   a spurious new game. `onBestMove` is the header backstop. Untagged input keeps
   positional/CLI names (`id name` fills defaults for game 1 only).

- **Mid-game resync (bridge starts partway into a game).** When the first `position`
  seen for a game already carries moves *and the bridge has not yet observed a game
  boundary* (`sawGameBoundary`, latched in `beginNewGame`), `onMidGameResync`
  fires: the current position is published via `emitCurrentPosition` (FEN+FMR, so a
  client LOGONing during the binding gap already has the board) and — on tagged input
  with a `startpos`-based position — the side-to-move's colour is pre-bound **by move
  count parity** (the `position` is addressed to the engine about to move; even count =
  White). `awaitingFirstGo` is suppressed so the first `go` can't mis-bind. The other
  colour binds when the second engine's first tagged `go` registers it as a participant —
  tracked by `resyncBinding`, deliberately *not* `collectingParticipants`: that flag gates
  new-game detection at `ucinewgame`, and a resync bind that never completes (the joined
  game ends before the second engine's `go`) would latch it and swallow the next boundary.
  Only the first game the bridge sees can resync; afterwards a first `position` with moves
  is an opening book, and re-publishing it would duplicate the header's FEN.
  If the first `bestmove` beats that (the usual order), the backstop emits the header
  with the parity-bound side + CLI fallback for the other; when the bind completes, the
   real names are re-sent via `setPlayers` (node-tlcv re-arms its move list on the late
   WPLAYER/BPLAYER, restarting the shown game at the join point). A `fen`-based resync
   position has no absolute parity → names stay at the defaults. **Orphan `bestmove`:**
   `--from-end` can start *between* a `position` and its `bestmove` — the first line is
   then a `bestmove` whose `position` was already written. `onBestMove` skips any
   `bestmove` seen before the game's first `position` (`positionSeen`): letting it start
   the game at startpos would make the first real `position` take the forward-extension
   path (empty list is a prefix of everything) and replay the whole game instead of
   resyncing.

- **Finished games are recorded for the PGN merge.** `closeCurrentGame` (at every game
  boundary, before the old colour binding is cleared) records `{white, black, result}`
  — real result if the board produced one, else the synthesized `*` — and
  `finishedGames()` numbers them from `meta.gameNumber` (the PGN file's finished count +
  1, set by `main.ts`); `currentGameNumber` is `gameNumber + finished.length`. The file
  is the database of record: `mergeGames` (in `pgn.ts`) lets file entries win number
  collisions. `meta.onGameStart` fires per game so `main.ts` re-reads the live-appended
  PGN at every boundary.

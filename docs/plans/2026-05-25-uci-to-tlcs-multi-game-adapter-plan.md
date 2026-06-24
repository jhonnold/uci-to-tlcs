---
ingested: 2026-06-04
source_type: plan
author: "claude_code (plan), jhonnold (approval)"
synthesis: done
---

> **Outcome:** implemented, tested (29/29), live-verified, merged as PR #1 on
> [[gitea]] (squash commit `684efff` on `main`) on 2026-05-25. See [[uci-to-tlcs]].

# Multi-game / multi-matchup support via a `LogSource` adapter

## Context

`uci-to-tlcs` previously assumed **one game, forever**: the pipeline never reset the
board between games, and player names came from CLI `--white`/`--black`. That broke
the moment a single UCI log contained more than one game (e.g. any fastchess run), and
CLI names are wrong for multi-matchup streams where the players change.

Empirically confirmed (running a real fastchess 3-engine round-robin, 12 games, 3
matchups) the hard constraint that shaped the design: **raw, untagged UCI cannot
recover player identity.** There is no per-line origin tag, identical binaries report
identical `id name`, and engine processes are *reused* across matchups so `id name` is
sent only once per process — never per matchup. Lines attribute to a *colour* (via
board side-to-move), never to a *name*.

Decision (user): **consume the producer's *tagged* log lines** (which carry engine
identity + direction), but behind an **adapter interface** so other UCI-log producers
can be supported later. Other settled decisions: assume **concurrency=1** (lines never
interleaved across simultaneous games); render **sequentially on one node-tlcv board /
port** (each game replaces the previous).

Outcome: tail a fastchess log *directly* (no external `sed` strip), segment it into
games, and broadcast each game with correct, swapping player names — while a degraded
"raw" adapter preserves the prior behaviour for pre-stripped transcripts.

## Architecture

```
tail → LogSource.normalize(line) → { uci, engineId?, direction? }
     → parseLine(uci) → UciEvent
     → Pipeline (segment games + bind colors→names) → BroadcastSink → UDP
```

The adapter only normalizes a line; **all** chess/segmentation logic stays in the
Pipeline (extends the "keep conversion out of the server" seam to "keep
producer-parsing in the adapter, segmentation in the pipeline"). `BroadcastSink` and
`TlcsServer` are **unchanged** — `setPlayers` / `emitInitialPosition` / `emitResult`
are re-called per game; the reliable sender's monotonic id counter persists across
games so re-emits are accepted by node-tlcv.

## node-tlcv reset contract (verified against `node-tlcv/src/game-service.ts`, `chess-game.ts`)

Three reverse-engineered invariants drive the per-game emit order:

1. **Board reset is startpos-FEN driven.** `onFen` (game-service.ts:109-139): an
   already-`loaded` board calls `game.reset()` only when the FEN board prefix ==
   startpos (`rnbqkbnr/pppppppp/...`, line 128). The 3-field truncated FEN matches. A
   *non-startpos* new-game FEN is treated as a backup FEN, **not** a reset.
2. **Players must precede move 1.** `buildGameDelta` sets `resetMoves:true` whenever
   `dirty.players` is set (lines 498-503). So a WPLAYER/BPLAYER arriving *after* a move
   wipes that move from the UI. **Both** players must be emitted before the first move
   of every game.
3. **A `result:` is required to re-arm.** `gameStartArmed` re-arms only in `onResult`
   (lines 481-482), which is also where PGN/`game-started`/`game-finished` fire. A game
   that ends with no `result:` (adjudication) leaves the next game's lifecycle stalled
   (board still resets, but PGN never finalizes). `onResult` stores `tokens[1]` verbatim
   as the PGN Result and accepts any string, so `result: *` (PGN "unknown") is the safe
   synthesized close-out.

**Per-game emit order:** *(synthesized `result: *` for previous game if it had none)*
→ `WPLAYER` → `BPLAYER` → startpos `FEN` (+`FMR`) → moves.

## The adapter (`src/source/`)

`log-source.ts` — interface (the regex below was validated against a real 12-game log:
26,652 lines parsed, banners/diagnostics correctly dropped):

```ts
export interface NormalizedLine {
  uci: string | null;          // bare UCI payload for parseLine(), or null
  engineId?: string;           // stable per-process identity (undefined = raw)
  direction?: 'in' | 'out';    // GUI→engine vs engine→GUI (undefined = unknown)
}
export interface LogSource {
  readonly name: string;
  normalize(line: string): NormalizedLine | null;   // null = drop the line
}
```

- `raw-source.ts` — `RawUciSource`: `{ uci: line.trim() }`, no identity/direction.
  Back-compat; pipeline falls back to positional + CLI/`id name` behaviour.
- `fastchess-source.ts` — `FastchessSource`: parses
  `[Engine] [ts] <THREADID>  ENGINENAME <---|---> COMMAND`.
  `RE = /^\[\s*\w+\s*\]\s+\[[\d:.]+\]\s+<\s*\d+>\s+(\S+)\s+(<---|--->)\s+(.*)$/`
  (g1 = ENGINENAME = engineId, g2 = direction, g3 = uci). `engineId` = operator-configured
  name (the natural display name; better than the identical self-reported `id name`).
  Non-matching lines (`[INFO]`/`[WARN]` banners, fastchess `Info;`/`Position;`/`Moves;`
  diagnostic dumps) → `null`.
- `index.ts` — `Format = 'auto'|'raw'|'fastchess'`; `makeSource(fmt)`. `auto` (default)
  sniffs the first decisive line against the fastchess regex (or a bare-UCI keyword),
  skipping leading banners, then delegates forever after.

## Pipeline changes (`src/pipeline.ts`)

`handleLine(line: string)` → `handleLine(n: NormalizedLine)`; calls `parseLine(n.uci)`
internally. Adds an inline game-segmenter.

- **Game-boundary detection.** A new game begins when (tagged path) a `ucinewgame`
  (direction `in`) opens a new pending pair, OR a `position` whose move list *resets* —
  empty (startpos no-moves) or not a prefix-extension of the current game's applied
  moves. The move-list check also drives the **raw** path, so board reset works without
  identity.
- **Name binding.** White = the engine that receives `position startpos`(no moves) +
  the first `go`; Black = the other `ucinewgame` participant. Both participants are
  known *before any move* (both get a tagged `ucinewgame` at game start), satisfying
  invariant 2. `displayName(id) = id` (configured name). Colour/name swap fall out
  because `whiteId`/`blackId` recompute per game.
- **Emit ordering.** Player + initial-FEN emission is deferred to the first `go` (after
  the resetting `position`) so both names land first; `result→players→FEN→move` every
  game. `beginNewGame()` synthesizes `result: '*'` if the prior game ended without one.
- **Degraded raw path.** `isGameReset` still segments games, but names can't re-bind —
  keep CLI names; `id name` fallback fills defaults for the first game only.

## Supporting edits

- `src/game/game-state.ts` — add `reset()` (re-`new` the inner `Chess`, clear
  `startFen`), mirroring `node-tlcv/src/chess-game.ts:142-157`.
- `src/config.ts` — add `format: Format`; CLI `--format auto|raw|fastchess` (default
  `auto`); `--white/--black` remain as raw-path fallback.
- `src/main.ts` — `const source = makeSource(cfg.format)`; tail callback normalizes each
  line through the source before `pipeline.handleLine(n)`.
- (Optional, deferred) `src/tlcs/server.ts` `resetLiveSnapshot()` to clear stale PVs for
  a client joining *between* games — cosmetic; left out to keep the server unchanged.

## Edge cases

- **Non-startpos openings (FRC / book positions):** node-tlcv won't board-reset on a
  custom FEN while `loaded` (invariant 1) — custom-start multi-game won't visually reset
  between games (startpos is the fastchess norm). This is why the live demo ran from
  startpos rather than the EPD book.
- **First `go` without a tagged engineId:** binding no-ops; header falls back to
  positional/CLI names; never block move emission on binding.
- **Adjudicated end (no board result):** synthesized `result: *` before the next game's
  players keeps the ordering/arming contract.
- **Duplicate operator-configured names:** engineId would collide (out of scope).
- **`--from-end` mid-stream join / divergent move list (takeback):** positional
  fallback; reset iff the new list isn't a prefix-extension of the current one.

## Verification

- `npm run typecheck` + `npm test` — **29/29** pass (new `test/source.test.ts`,
  `test/multigame.test.ts`; existing single-game `encoder.test.ts` unchanged via
  auto→raw). Build clean.
- Fixtures: `fixtures/multi-game.uci` (raw, 2 games, colour swap);
  `fixtures/fastchess-multigame.log` (tagged, doubles as the auto-sniff fixture; a
  `!fixtures/*.log` `.gitignore` negation was needed so the `.log` fixture is committed).
- **Real 12-game / 3-matchup fastchess log** through the built pipeline: all 12 games
  segmented with correctly swapping names/colours/results; game 12 matched fastchess's
  own "Finished game 12 (EngC vs EngB): 1-0".
- **Wire-level UDP e2e** (bridge + mock client): clean 2-game stream, players swapped
  (`EngA/EngB → EngB/EngA`), board reset on the game-2 startpos FEN, reliable IDs
  strictly monotonic across the boundary, zero out-of-order/DROP warnings.
- **Live e2e against real [[node-tlcv]]** (5m+3s, 3 Berserk copies, round-robin): node-tlcv
  showed live moves/clocks/eval, players, and the first completed move on the board;
  config repointed to the bridge (ephemeral) and restored afterwards.

## Docs

- README: `--format auto|raw|fastchess`; with `--format fastchess` tail the fastchess
  log **directly** (drop the `sed` strip); revised scope to "sequential multi-game /
  multi-matchup on one port"; noted adjudicated-end (`result: *`) and non-startpos
  limitations.
- CLAUDE.md: "Adapter seam" note + the three node-tlcv reset invariants.

## Critical files

- `src/pipeline.ts` (segmentation + binding + per-game reset)
- `src/source/fastchess-source.ts`, `src/source/index.ts` (new adapter + selection)
- `src/main.ts`, `src/config.ts` (wiring + `--format`)
- `src/game/game-state.ts` (`reset()`)
- `node-tlcv/src/game-service.ts` (reference for the reset/result/players invariants)

## Related

- [[uci-to-tlcs]] — the project this extends
- [[node-tlcv]] — the TLCS client; source of the reset contract above
- [[fastchess]] — the tagged-log producer the first adapter consumes directly
- [[2026-05-25-uci-to-tlcs-plan]] — the original design/build plan
- [[berserk]] — the engine used (3 copies) in the live verification

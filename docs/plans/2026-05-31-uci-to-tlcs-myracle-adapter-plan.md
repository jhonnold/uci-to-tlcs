---
ingested: 2026-06-04
source_type: plan
author: claude_code (with Jay Honnold)
synthesis: done
---

> Implemented 2026-05-31. See [[uci-to-tlcs]] for the as-built outcome, including a
> second pipeline fix (move emission from `position` deltas) discovered during real-data
> testing that the plan did not anticipate. This page is the approved plan as written.

# Plan: myracle debug-log support for uci-to-tlcs

## Context

`uci-to-tlcs` reconstructs chess games from a UCI engine log and rebroadcasts them
as TLCS over UDP so node-tlcv can watch live. Log producers are pluggable via the
`LogSource` adapter seam (`src/source/`): `raw` (untagged) and `fastchess`
(engine-tagged) ship today. We want to watch **myracle** GUI tournaments the same
way, which means a new adapter for myracle's `.debug` log format.

Source studied: `~/downloads/myracle_linux/tournaments/tournament_2026_05_31_10_22_10.debug`
(9959 lines, one game: Berserk 14 = engine 1 = tag `first` = White, Stockfish 18 =
engine 2 = tag `second` = Black, draw by threefold repetition).

### myracle log format (established by inspection)

- UCI lines: `863187 >first : uci` and `863199 <first : id name Berserk 14`
  - leading int = ms timestamp; `>` = GUI→engine (`in`), `<` = engine→GUI (`out`)
  - token glued to the arrow is the engine **tag** `first`/`second` (NOT a display name)
  - then ` : ` then the raw UCI payload
- Diagnostic (non-UCI) lines use `*` and must be dropped:
  - `863186**----------New game---`
  - `863186*1*---------------------Starting engine 1 Berserk 14----------------------`
  - `863186*2*---------------------Starting engine 2 Stockfish 18----------------------`
  - `863899*1*Found move:e2e4`
  - engine number `1` ↔ tag `first`, `2` ↔ tag `second`
- Standard UCI payloads otherwise (`uci`/`uciok`/`id name`/`ucinewgame`/`position`/
  `go`/`info`/`bestmove`/`info string`/`setoption`). Non-keyword payloads such as
  Stockfish's `Stockfish 18 by the Stockfish developers...` banner are passed through
  and harmlessly dropped by the existing `parseLine` (first token not a UCI keyword).

### The non-obvious problem (why an adapter alone is not enough)

fastchess batches **both** `ucinewgame`s before any `go`. myracle initializes engines
**sequentially**, so game 1's order is:
`>first ucinewgame` (L20) → `>first position startpos` (L27) → `>first go` (L28) →
`>second ucinewgame` (L54) → `<first bestmove e2e4` (L81) → `>second position ...`.

The current pipeline tagged-binding (`src/pipeline.ts`) assumes both `ucinewgame`s
precede the first `go`. Traced against myracle it **breaks**: at `>first go` (L28) it
binds `whiteId=first`, finds no other participant, leaves `blackId` undefined, and sets
`collectingParticipants=false`; then `>second ucinewgame` (L54) re-opens collection →
a **spurious `beginNewGame()`** (emits `result:*`, resets the board mid-game) and later
rebinds `whiteId=second`. So the pipeline binding must be generalized to tolerate
participants arriving interleaved with the first `go`.

## Approach

Two coordinated changes — a new adapter (mirrors `FastchessSource`) plus a minimal,
general pipeline binding fix — then wiring, docs, and tests.

### 1. New adapter — `src/source/myracle-source.ts`

`MyracleSource implements LogSource` (model on `src/source/fastchess-source.ts`):

- **UCI-line regex:** `/^\d+\s+([<>])(first|second)\s*:\s*(.*)$/`
  → direction `>`→`'in'` / `<`→`'out'`; tag = group 2; payload = `group3.trim()`
  (empty → `uci: null`, as fastchess does).
- **Stateful tag→display-name map**, two sources, banner seeds then `id name` upgrades:
  - Seed from the `Starting engine N <name>` banner:
    `/^\d+\*([12])\*-+Starting engine [12]\s+(.+?)-+$/`, `.trim()` group 2, map
    `1→first`, `2→second`. (Available before any UCI line under `--format myracle`.)
  - **Upgrade** on every `<tag : id name X` line: overwrite the tag's entry with `X`.
    `id name` is authoritative and hyphen-safe — the banner's trailing-hyphen run makes
    the non-greedy capture truncate hyphenated engine names, so `id name` is the source
    of truth and the banner is only a bootstrap.
- **Emit `engineId` = the friendly display name** (fallback to the raw tag if not yet
  learned). The pipeline uses `engineId` directly as `WPLAYER`/`BPLAYER`
  (`resolveNames`), so emitting `first`/`second` would show those as player names —
  remap is required and matches fastchess's "engineId = configured/display name".
- All `*`-diagnostic lines (`New game`, `Starting engine`, `Found move`) return `null`
  (the UCI regex doesn't match them; the banner is consumed for the name map first).
- `static matches(trimmed)` tests the **UCI-line** regex only (banner lines are skipped
  by AutoSource's undecided path, like fastchess `[INFO]` banners).

### 2. Pipeline binding fix — `src/pipeline.ts`

Defer black-binding + collection-close + header emit until **both** white and the
single other participant are known. Add:

```ts
private maybeBindBlack(): void {
  if (this.whiteId && !this.blackId) {
    const others = [...this.participants].filter((id) => id !== this.whiteId);
    if (others.length === 1) {
      this.blackId = others[0];
      this.collectingParticipants = false;
      this.awaitingFirstGo = false;
      this.emitGameHeaderIfReady();
    }
  }
}
```

- `onUciNewGame`: after `participants.add(engineId)`, call `maybeBindBlack()`.
- `onGo`: in the `awaitingFirstGo && direction==='in' && engineId` block, set
  `whiteId` + `awaitingFirstGo=false`, then call `maybeBindBlack()` — **replacing** the
  inline `blackId` derivation and `collectingParticipants=false`. **Remove** the
  unconditional `if (this.tagged) this.emitGameHeaderIfReady();` (it would emit a
  premature header with a fallback black for myracle). **Keep** the clock emit.
- The defensive `emitGameHeaderIfReady()` at the top of `onBestMove` stays as backstop.

This is a generalization, not a myracle special-case: it makes binding robust to any
sequential-init producer while preserving fastchess behavior exactly (when both
participants are already known at `go`, `maybeBindBlack` fires the header in the same
`onGo` call, same observable order as today).

#### Traces proving correctness

- **fastchess** (batched): `ucinewgame A`, `ucinewgame B`, `position A`, `go A` →
  whiteId=A, `maybeBindBlack` others=[B] → blackId=B, header `[A,B]` before first move.
  Game 2 reopens on next `ucinewgame` → `[B,A]`. ✅ (existing `fastchess multi-game` test)
- **adjudicated inline test**: game-2 `ucinewgame` with `collecting=false` →
  `beginNewGame` synthesizes `result:*` before players. ✅ (existing test)
- **myracle** (interleaved): `>first ucinewgame` opens, adds Berserk 14; `>first go`
  → whiteId=Berserk 14, others=[] → no bind, collecting stays **true**, no premature
  header; `>second ucinewgame` (collecting still true → no spurious reset) adds
  Stockfish 18, `maybeBindBlack` → blackId=Stockfish 18, header `[Berserk 14, Stockfish 18]`
  before `bestmove e2e4`. ✅ white=first, black=second, no spurious mid-game result.

### 3. Wiring

- `src/source/index.ts`: import + re-export `MyracleSource`; add `'myracle'` to
  `Format` and `FORMATS`; add `makeSource` case; in `AutoSource.normalize` test
  `MyracleSource.matches` and `FastchessSource.matches` (mutually exclusive) **before**
  `looksLikeRawUci` (raw is the loosest matcher, must stay last).
- `src/config.ts`: update `--format` help in `USAGE` and the `isFormat` error message
  to `auto | raw | fastchess | myracle`.

### 4. Docs

- `README.md`: add the `myracle` bullet to the format-adapters list and the `--format`
  option lines; note it reads myracle `.debug` logs directly.
- `CLAUDE.md`: new gotcha — myracle interleaved sequential init (one `ucinewgame` at a
  time; the first engine's `go`/`bestmove` can precede the second engine's
  `ucinewgame`) and the tag→name remap (banner seed + `id name` upgrade). Update the
  segmentation gotcha that currently implies binding relies on both `ucinewgame`s
  preceding move 1 in a batch — it now defers via `maybeBindBlack` until both
  participants are known, however interleaved.

## Files

- **Create** `src/source/myracle-source.ts`
- **Create** `fixtures/myracle-multigame.debug` (synthetic, see Tests)
- **Modify** `src/source/index.ts`, `src/pipeline.ts`, `src/config.ts`, `README.md`,
  `CLAUDE.md`

## Tests

- **`test/source.test.ts`** — add a `MyracleSource` block mirroring the fastchess one:
  - `normalize` of `>first`/`<first` lines → correct direction/engineId/payload;
    diagnostics (`New game`, `Starting engine`, `Found move`) → `null`.
  - name learning: banner seed, then `id name` upgrade; include a **hyphenated** engine
    name (e.g. `Stockfish-dev`) to prove the `id name` path beats banner truncation.
  - `MyracleSource.matches`: true for `'863187 >first : uci'`; false for
    `'position startpos'`, a `*`-banner, and a fastchess line.
  - `makeSource('auto')`: skips leading `*`-banners, selects myracle on the first
    `>first :` line, stays myracle.
- **`test/multigame.test.ts`** — add a `myracle multi-game` test driving a synthetic
  fixture through `MyracleSource` + `Pipeline` (reuse `RecordingSink`/`drive`), asserting:
  players `[{Berserk 14, Stockfish 18}, {Stockfish 18, Berserk 14}]` (swap in game 2),
  header precedes each game's first move, synthesized `result:*` at the game-2 boundary
  if game 1 didn't end on the board, single `site` emit.
- **Fixture:** hand-write a small `fixtures/myracle-multigame.debug` (two short
  fool's-mate-style games with swapped `first`/`second`, including `New game` /
  `Starting engine 1|2` / `Found move:` noise lines) — same approach as the tiny
  synthetic `fixtures/fastchess-multigame.log`. The real 9959-line download is a single
  in-progress game; keep it only as a manual e2e smoke, not a committed fixture.

## Operational note — starting the parser after the log is already running

The tailer defaults to `fromStart: true` (`config.ts`; `--from-end` is the opt-out)
and on `start()` streams the **entire existing file from byte 0** (`tail.ts` —
`offset = fromStart ? 0 : size`, then `consume(0, size)`) before following live appends.
So attaching the parser *late* to an already-running `.debug` works: the top-of-file
`Starting engine N <name>` banners and `id name` lines are replayed first → the adapter's
tag→name map populates → and because the pipeline defers the header emit until both
participants are bound (after both `id name`s), names are correct on first emit — a clean
in-order replay, no retroactive backfill. **Caveat:** `--from-end` seeks to EOF and skips
the top of the file, so it would miss the name-learning lines (names fall back to raw
`first`/`second`) and the in-progress game's setup — for a late attach, use the default.

## Verification

1. `npm run typecheck` and `npm test` (new + existing source/multigame tests pass —
   the existing fastchess/adjudicated traces must stay green, proving no regression).
2. **Manual e2e (single host, no Docker)** against the real download, mirroring the
   CLAUDE.md runbook:
   - `npm start -- --log <…>.debug --format myracle --bind 127.0.0.1 --port 16066`
   - start node-tlcv (`npm run dev-server` in `../node-tlcv`, config pointed at
     `127.0.0.1:16066` ephemeral), bridge up **first** (LOGON race).
   - confirm at `http://127.0.0.1:8080/16066`: players show **Berserk 14** / **Stockfish 18**
     (not `first`/`second`), board reconstructs the game, eval/PV/clocks update, and the
     draw renders as `1/2-1/2` (board-derived threefold).

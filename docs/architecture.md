# Architecture & conventions

What to reach for: touching any part of the pipeline, adding a log producer, or
editing a `.ts` file and hitting an import-extension build break.

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

## Conventions

- **ESM / NodeNext**: import with a `.js` extension even for `.ts` files
  (`import { GameState } from './game/game-state.js'`). Wrong extension = build break.

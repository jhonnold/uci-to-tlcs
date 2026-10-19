# Architecture & conventions

What to reach for: touching any part of the pipeline, adding a log producer, or
editing a `.ts` file and hitting an import-extension build break.

## Architecture seam

`tail → LogSource → parser → Pipeline → GameState (chess.js) → TlcsServer → UDP`.
Three concerns, kept separate on purpose:
- **`source/` (LogSource adapter)** normalizes one producer line into
  `{ uci, engineId?, direction? }` and nothing more — no chess, no segmentation.
  `RawUciSource` (untagged) and `FastchessSource` (engine-tagged) ship;
  `--format` / `makeSource` pick one (`auto` sniffs the first decisive line, tagged
  matchers before the loose `looksLikeRawUci`). Add a producer = add an adapter, don't
  touch the pipeline. An adapter MAY be stateful for *identity* only (e.g. remapping a
  producer's engine tag to the real display name) — never for chess or segmentation.
- **`pipeline.ts` / `game/game-state.ts`** own all unit/perspective conversion **and**
  game segmentation. The `BroadcastSink` interface (`pipeline.ts`) is the test seam —
  `encoder.test.ts` / `multigame.test.ts` drive the pipeline through a fake sink with
  no sockets.
- **`tlcs/`** only transports and answers clients. Keep conversion/segmentation out of it.
  `server.ts` is the socket and the two send channels; `reliable-sender.ts` the per-client
  stop-and-wait queues (RTO, give-up, resync); `inbound.ts` numbered-datagram dedupe;
  `commands.ts` the session commands (logon burst, names, chat, PING/reap); `admin.ts`
  `ADMIN`/`SECURITY`/`BOOT`, ban list and the per-IP rate limit; `protocol.ts` the wire formats.
- **`results/`** is the stateful side of results: a streaming reader of the tournament PGN
  (`GameRegistry`), the authority the pipeline asks for a game's `Result`, and the
  `RESULTTABLE`/`GAMELIST` renderers (`crosstable.ts`, `result-commands.ts`).
- **`state/` + `app.ts`** own startup and restart: `app.ts` wires everything and runs the
  silent, synchronous catch-up (`state/catch-up.ts`, `state/resume.ts`), `state-file.ts`
  persists clients and their resume point, `debug-log.ts` implements `SAVEDEBUG`.
  `metrics.ts` (Prometheus counters) and `paced-sink.ts` (`DELAYAFTERMOVE`/`GAME`) sit
  between the pipeline and the server.

## Conventions

- **ESM / NodeNext**: import with a `.js` extension even for `.ts` files
  (`import { GameState } from './game/game-state.js'`). Wrong extension = build break.

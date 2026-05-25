# CLAUDE.md

`uci-to-tlcs` reconstructs a chess game from a **raw UCI engine transcript** and
broadcasts it over UDP in a **TLCS-compatible** protocol, so node-tlcv (and the
desktop TLCV) can watch it live. It is the inverse of node-tlcv: a minimal TLCS
*server*. See `README.md` for the full CLI, the UCI→TLCS encoding table, the data
flow, and v1 scope — this file only captures what isn't obvious from the code.

## Commands

```bash
npm test          # unit tests (parser, encoder, pipeline) via node:test
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
npm start -- --log <path> [opts]   # run from source via tsx
npm run dev       # tsx watch
```

## Architecture seam

`tail → parser → Pipeline → GameState (chess.js) → TlcsServer → UDP`.
All unit/perspective conversion lives in **`pipeline.ts` / `game/game-state.ts`**;
`tlcs/server.ts` only transports. The `BroadcastSink` interface (`pipeline.ts`) is
the test seam — `encoder.test.ts` drives the pipeline through a fake sink with no
sockets. Keep new conversion logic out of the server so it stays testable.

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
  side-to-move POV → normalize to White; only `multipv 1` is the broadcast eval; mate
  mapped to ±(100000 − n) so node-tlcv renders it decisive.
- **Results are board-derived only.** Pure UCI has no resign/adjudication signal, so
  only mate/stalemate/draw on the board produces a `result:` (`game-state.ts`).

## Testing the live path

- **Local**: `scripts/mock-client.ts --ephemeral` binds an OS-assigned port and still
  receives (we reply to the source port), so no loopback alias is needed. To exercise
  the strict same-port client instead, drop `--ephemeral` and use an alias (server
  `--bind 127.0.0.1`, client `--bind 127.0.0.2`, same port).
- **Faithful e2e**: two containers, `docker compose -f docker-compose.test.yml up --build`
  (needs node-tlcv at `../node-tlcv`). Unaffected by the source-port reply: real
  node-tlcv binds the broadcast port, so its source port *is* the broadcast port.
- **LOGON-race**: node-tlcv sends `LOGONv15` once at boot and never retries. Bring the
  bridge up **before** node-tlcv (or `docker compose restart node-tlcv`), or it sits
  connected-but-unregistered (PINGs PONGed, 0 moves).

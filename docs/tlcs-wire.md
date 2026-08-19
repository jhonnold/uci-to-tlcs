# TLCS wire protocol, transport & encoding

What to reach for: changing any wire format, moving a message between send channels,
changing reply/targeting logic, or touching the FEN/time/score/PV encoding in
`tlcs/server.ts` and the encoder.

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

- **Mid-game join** (`tlcs/server.ts` `sendSnapshot`): on `LOGONv15` the server unicasts a
  snapshot of the live game — SITE → WPLAYER → BPLAYER → FEN → FMR → clocks → last PV — all on
  the reliable channel in that order, so a late client lands on the current board/players/site
  without waiting for the next move (node-tlcv's first-FEN `resetFromFen` path). Board-only: no
  move history is replayed (matches existing TLCS servers). Re-LOGON replays it too.

- **node-tlcv new-game contract** (reverse-engineered, drives the per-game emit order
  `result → WPLAYER → BPLAYER → startpos FEN → moves`; see `../node-tlcv/src/game-service.ts`):
  (1) board reset fires only on a **startpos** FEN while loaded (`onFen`) — a non-startpos
  new-game FEN won't reset it; (2) WPLAYER/BPLAYER set `resetMoves`, so **both players
  must precede move 1** or the shown move is wiped (`buildGameDelta`); (3) `gameStartArmed`/
  PGN finalize re-arm **only on `result:`** (`onResult`) — hence the synthesized `*`.

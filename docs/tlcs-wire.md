# TLCS wire protocol, transport & encoding

What to reach for: changing any wire format, moving a message between send channels,
changing reply/targeting logic, or touching the FEN/time/score/PV encoding in
`tlcs/server.ts` and the encoder.

- **Protocol is reverse-engineered, not specced.** The TLCS wire contract is defined
  empirically by what node-tlcv accepts (`../node-tlcv` `src/game-service.ts`,
  `src/kibitzer/uci-parser.ts`, `src/udp-transport.ts`). Cross-check there before
  changing any wire format — there is no official spec. For what the original
  server (TLCS 1.6a) does, see `docs/tlcs-server-spec.md`.

- **Two send channels, different rules** (`tlcs/server.ts`, `tlcs/reliable-sender.ts`):
  - *Reliable* (`sender.enqueue`) — ID-wrapped `<N>MSG` (no space), ACKed. **Per client**: own
    id counter (starts at 1, strictly increasing, never reset while the process lives, even
    across LOGOFF/re-LOGON), FIFO queue, one message in flight (stop-and-wait; a window would
    land a resend behind a newer id and node-tlcv drops any id ≤ last seen). A slow client never
    stalls another. Retransmit uses an adaptive RTO (RFC 6298 estimator, Karn's rule, clamped
    50 ms–2 s, doubling per retransmit of one item). Give-up after 10 s: a *game* item is
    replaced by a replay of its game under new ids; a *control* item is dropped (`onGiveUp`);
    the `result` is retried until 60 s then dropped with an error. Queues over `maxQueue` are
    coalesced to replays when shorter. Game data is dropped only for a *stalled* client (no
    ACK progress for 60 s while busy), logged at error. Used for SITE / PLAYER / FEN / MOVE /
    FMR / level / result / user / chat.
  - *Unnumbered* — fire-and-forget, latest-only per key: WPV / BPV / WTIME / BTIME. An idle
    client gets them at once; a busy client has them held in queue order (so a position always
    precedes its clock/PV). Never retransmitted. Don't move a message between channels casually.
  - *Inbound numbered*: a datagram `<N>body` / `< N>body` is ACKed (`ACK: N`) on **every** copy,
    deduped per source (ring of 256, reset on `LOGONv15`), then dispatched. ACK parsing is
    `ACK:\s*N`.

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

- **Mid-game join** (`tlcs/server.ts` `resync`): every successful `LOGONv15` (new or known)
  gets a full replay of the current game on the reliable channel — SITE, WPLAYER, BPLAYER, the
  setup sequence (start FEN, setup moves, `level`), every SAN (each preceded by the mover's last
  PV so node-tlcv's archive does not label replayed moves "(Book)"), the latest FEN/FMR — then the
  clocks and last PV as latest items. A board-only snapshot cannot repair a client whose board is
  already loaded (node-tlcv after a server restart or a reap), so history is always replayed. A
  finished game whose result is already delivered or in flight is not replayed. Game records are
  kept for every epoch some client's queue still references and dropped when none does.

- **Non-startpos new game** (`FENSETUPMOVE`, default on): `WPLAYER`/`BPLAYER` → `FEN startpos`/`FMR 0`
  → `FEN X`/`FMR f` → `FEN X`/`xMOVE n. (setup)`/`FMR f` → book moves. node-tlcv's `onMove` fails
  `(setup)` in chess.js and its catch runs `resetFromFen()` (loads `X f n`; PGN gets `[SetUp][FEN]`,
  no move). Desktop TLCV appends the text unvalidated: `1. (setup)` once in the move list, board
  correct. `FENSETUPMOVE=0` sends only `FEN X`/`FMR f`: clean on desktop, wrong on an already-loaded
  node-tlcv.

- **node-tlcv new-game contract** (reverse-engineered, drives the per-game emit order
  `result → WPLAYER → BPLAYER → startpos FEN → moves`; see `../node-tlcv/src/game-service.ts`):
  (1) board reset fires only on a **startpos** FEN while loaded (`onFen`) — a non-startpos
  new-game FEN won't reset it; (2) WPLAYER/BPLAYER set `resetMoves`, so **both players
  must precede move 1** or the shown move is wiped (`buildGameDelta`); (3) `gameStartArmed`/
  PGN finalize re-arm **only on `result:`** (`onResult`) — hence the synthesized `*`.

# TLCS-MG v1: several games over one TLCS port

Status: implemented by uci-to-tlcs (server side and `scripts/mock-client.ts --multigame`).
Audience: a client implementer, mainly node-tlcv. The spec is self-contained; it assumes
`docs/tlcs-wire.md` (the single-game wire contract) and adds only what is new.

## 1. Goals and non-goals

- One TLCS server port carries N concurrent games ("boards") of one broadcast, e.g. a fastchess
  run with `-concurrency N`.
- **Non-breaking.** A client that does not opt in receives exactly the single-game protocol: one
  game (board 1) on the bare commands, never an unknown token. A client that opts in against a
  server without the extension gets no answer and keeps working as a single-game client.
- Not in v1: closing boards, per-board SITE/crosstable, a sliding window on the reliable channel.

## 2. Terms

- **Board**: a numbered game slot, id `1..N` (decimal, no leading zeros). Each board shows one
  game at a time and then the next game played in that slot, exactly like a single-game TLCS
  stream does today. Board ids are stable for the life of the server process and normally across a
  server restart (§8). Boards are never removed in v1.
- **Board 1** always exists. A server that only ever has one game (sequential play) never creates
  board 2, so an opted-in client sees everything on board 1.
- **Game line**: a body from this set (the single-game game channel):
  `WPLAYER:` `BPLAYER:` `FEN:` `FMR:` `WMOVE:` `BMOVE:` `level ` `result:` (numbered) and
  `WTIME:` `BTIME:` `WPV:` `BPV:` `WINFO:` `BINFO:` (unnumbered, latest-only).
- **Broadcast line**: everything else the server sends: `SITE:` `CT:` `CTRESET` `GL:` `CHAT:`
  `ADDUSER:` `DELUSER:` `MENU` `PONG` `MSG:` `FEATURE:` `LOGON SUCCESSFUL` `ACK:` `SECUSER:`.

## 3. Handshake

| Step | Direction | Body | Channel |
|---|---|---|---|
| 1 | C→S | `LOGONv15:<name>` | as today |
| 2 | S→C | `LOGON SUCCESSFUL`, then the normal single-game burst | as today |
| 3 | C→S | `MULTIGAME: 1` | plain or numbered |
| 4 | S→C | `MULTIGAME: 1` | numbered |
| 5 | S→C | `BOARDS: <id> <id> …` | numbered |
| 6 | S→C | per board, a snapshot of its current game, wrapped (§5, §7) | numbered + latest |

- The client sends step 3 after **every** `LOGON SUCCESSFUL` (a re-LOGON makes the server forget the
  opt-in). `LOGON SUCCESSFUL` is unnumbered and can be lost: a client that gets numbered lines after its LOGON
  without having seen it sends step 3 on the first of them. If no `MULTIGAME:` arrives within 5 s, resend; after 3 tries treat the server as
  single-game. Resending after success is harmless (the server answers again with steps 4-6).
- `1` is the protocol version. A server answers with the highest version ≤ the requested one it
  supports; v1 servers always answer `1`. A client must ignore a `MULTIGAME:` whose version it does
  not know (and stay single-game).
- **Mode switch.** Everything numbered *before* the step-4 reply was single-game data. On receiving
  the step-4 reply the client discards all game state it built from bare game lines and from then
  on ignores bare game lines (none should arrive; the server stops sending them before the reply).
  Broadcast lines are unaffected. Because the reliable channel is in order, no bare game line can
  follow the reply.
- An unknown or legacy server (TLCS 1.6a, older uci-to-tlcs) drops `MULTIGAME: 1` silently: it
  matches no prefix of the reference dispatcher (`LOGON:` `LOGONv15:` `CHANGE:` `CHAT:` `EMAIL:`
  `SEND:` `ACK:` `BOOT:` `SRBOOT:` or the exact commands).

## 4. Board list

`BOARDS: 1 2 3` (numbered) lists every board that exists, ascending, space separated. It is sent
right after the `MULTIGAME:` reply and again whenever a board is added. The newest list is
complete: a board id the client has not seen before is new. A board appears in the list before its
first wrapped line. A client should still create a board implicitly for a `BOARD <n>` line it has
not seen in a list (robustness; a v1 server does not do this).

## 5. Wrapped game lines

```
BOARD <id> <game line>
```

- `<id>` is a board id from the latest `BOARDS:` list, then exactly one space, then a game line
  byte-identical to the single-game form (`docs/tlcs-wire.md`), e.g.
  `BOARD 2 WMOVE: 14. Nf3`, `BOARD 3 WPV: 12 -35 87 41233 e2e4 e7e5`,
  `BOARD 1 result: 1-0`.
- The channel of a wrapped line is the channel of the line it wraps: wrapped numbered lines are
  numbered, wrapped `WTIME`/`BTIME`/`WPV`/`BPV`/`WINFO`/`BINFO` are unnumbered, latest-only per
  (board, key).
- Parse: strip `BOARD `, read the decimal id up to the next space, the remainder is the game line;
  dispatch it with the single-game parser against that board's state.
- Per board, the order and semantics of game lines are **the single-game contract unchanged**:
  `result:` (synthesized `*` if needed) → `WPLAYER` → `BPLAYER` → startpos `FEN`/`FMR` →
  optional non-startpos setup (`FEN X`, `FMR`, `xMOVE n. (setup)`, `FMR`) → book moves → `level`
  → moves → … → `result:`. A board reset fires only on a startpos `FEN`; both players precede
  move 1; every game is closed by exactly one `result:`.
- Interleaving across boards is arbitrary. Within one board, numbered lines arrive in order
  (one in-order reliable channel per client, shared by all boards).

### 5.1 Game number

```
BOARD <id> GAMENO: <n>
```

Numbered, sent immediately before that board's `result:` when the server knows the game's number in
the tournament PGN (the number used by `CT:` and `GL:`, 1-based, PGN file order = finish order).
Absent when the server has no PGN entry for the game (unknown result, crash, no `TOURNEYPGN`); the
client then has no number for it. A client should use `GAMENO` to name saved games instead of
deriving the number from the `CT:` table (with concurrent games that derivation is wrong).

## 6. Broadcast lines

Never wrapped, sent to every client in both modes: `SITE:`, `CTRESET`/`CT:` (one crosstable over
all boards), `GL:`, chat, users, `MENU`, `PONG`, `MSG:`, `FEATURE:`. `SITE:` may be repeated (at the
head of a board resync); an unchanged value is a no-op.

The `CT:` game section lists every finished game of every board, newest first, as today.

## 7. Snapshots and lost lines

Delivery is best effort: the server never replays history. A client keeps each board right from the `FEN:` lines,
as node-tlcv already does for a single game (a move that does not apply → reload the last `FEN:`; its PGN history
restarts there).

- **Opt-in snapshot** (step 6), also after a re-LOGON (bare, board 1 only) and after a server restart (§8): the
  client's queued game lines are dropped; then `SITE` and, for each board in ascending order whose current game is
  unfinished, `WPLAYER`, `BPLAYER`, the board's **position steps** for its current position X, `level`, then each
  board's latest clocks/PV/INFO as wrapped latest items. A board whose current game is finished is skipped: it shows
  nothing until its next game starts; a result still queued for the client is dropped (that game is not saved).
- **Position steps**: `FEN <startpos>`, `FMR 0`, `FEN X`, `FMR f`, `FEN X`, `xMOVE n. (setup)`, `FMR f` (the
  single-game non-startpos new-game sequence; just `FEN X`/`FMR f` when X is the start position or the server runs
  with `FENSETUPMOVE=0`). A client must treat the startpos `FEN` as a board reset and the `(setup)` move (which no
  chess library accepts) as "load the last `FEN` with the last `FMR` and move number `n`". The game's PGN then starts
  at X (`[SetUp "1"][FEN …]`).
- **Lost line** (5 s without an ACK): the line is dropped, whatever it is (move, players, `GAMENO`, `result`) and the
  next one follows under the next id. The next move of that board comes with its own post-move `FEN`, so the client
  recovers on the first move that does not apply. Rarely, a move is legal on the stale board too: the board stays
  wrong until a later move fails. A lost `result:` means the game is not saved; a client must therefore drop a pending
  `GAMENO` when that board's next `WPLAYER` arrives, so it never names the next game with it.
- **Falling behind** (more than 256 move steps queued; other lines do not count): per board, the queued move steps are replaced by the
  position steps of the newest one; players, `level`, `GAMENO`, `result` and broadcast lines are kept, in order.

## 8. Server restart

- No client survives a restart: the server catches up silently to every board's game in progress and goes live.
  The client gets the `MSG: … no longer connected` notice on its next `PING`, re-LOGONs, re-sends `MULTIGAME: 1` (§3)
  and gets the §7 snapshot. Ids restart at 1 per process (`isIdRestart` rules apply unchanged).
- Board ids are recomputed from the log and match the previous process for the games in progress. Games that
  finished while the server was down are not sent (they remain in `CT:`/`GL:`).

## 9. Legacy clients (no opt-in)

- Receive board 1 on the bare game lines, byte-identical to a single-game stream, plus all
  broadcast lines. Games on boards ≥ 2 are invisible to them.
- Known limitation: node-tlcv derives its saved-game number from the newest `CT:` row, so under
  concurrency a legacy node-tlcv may save a board-1 game under another game's number.
- The desktop TLCV is a legacy client.

## 10. Server-side behaviour (informative, uci-to-tlcs)

- A board is a slot. When a fastchess worker thread opens a game, it gets the board it used last if
  that board is idle, else the lowest idle board, else a new board. Sequential play (one worker, or
  one run after another appended to the same log) therefore stays on board 1.
- The game number is the PGN entry matched by White/Black names, start FEN, PlyCount and (with
  `-pgnout notation=san`, the default) the SAN move list. With other notations two concurrent games
  with the same pairing, start and length can swap numbers.
- Stop-and-wait delivery is shared by all boards: per client ~3 numbered items per move per board. A slow or lossy
  client therefore loses lines (§7) rather than falling further behind: 5 s per undeliverable line, and stale moves
  are dropped once more than 256 move steps are queued.
- Verified with fastchess 1.8.2 on Linux; the worker-thread id in the log identifies the game.
  Windows fastchess is unverified.

## 11. Implementation notes for node-tlcv

Where the single-game assumption lives today (node-tlcv @ `9e3e6ee`):

- `src/transport/udp-transport.ts` — no change; ACK and id dedupe already cover new tokens.
- `src/protocol.ts` `splitOnCommand` / `KNOWN_COMMANDS` — add `MULTIGAME`, `BOARDS`, `BOARD`
  (token ends at the first space for `BOARD`). `GAMENO` only ever appears inside `BOARD`.
- `src/broadcast.ts` — one `ChessGame` per `Broadcast` (`this.game = new ChessGame(String(this.port))`);
  becomes a `Map<boardId, ChessGame>` (board 1 created eagerly). Send `MULTIGAME: 1` after
  `LOGON SUCCESSFUL` (it currently processes everything without waiting for it), with the §3 retry.
- `src/game-service.ts` — every W*/B*/FEN/FMR/result/level handler takes a board; the
  `game-started` arming, `currentGameNumber` (from CT; replace by `GAMENO` when present), PGN
  saving and the kibitzer are per board. The `SITE` slug and the crosstable stay per broadcast.
- Identity: the port keys the broadcast map, routes (`/:port`), Socket.IO rooms, metrics labels,
  webhooks and archive filenames. A board needs a sub-key (`/:port/:board`, room `port:board`);
  board 1 keeps the existing routes for compatibility.
- A `BOARD` line for a board not (yet) in `BOARDS:` creates that board (§4); log it, since a v1 server
  always sends `BOARDS:` first (it is never evicted from the queue).
- Per board, keep today's `onMove` recovery (a move that does not apply → `resetFromFen()`) and `onFen` rules
  (startpos while loaded → `reset()`): the §7 snapshots and lost-line recovery rely on them, there is no replay.
- Clear a board's pending `GAMENO` on its `WPLAYER` (its `result:` may have been lost).
- Request `RESULTTABLE` after every `LOGON SUCCESSFUL`, not only at start-up (today the server pushes a numbering
  dump on every LOGON to cover this).

## 12. Test vectors

Captured from a live run (fastchess 1.8.2, 4 engines, `-concurrency 3`, `tc=8+0.08`, 12 games), client
`mock-client --multigame` in node-tlcv mode. `<N>` = numbered, no prefix = unnumbered. Long lines cut.

Handshake (the client opted in before any game; boards appear as fastchess workers start):

```
C->S  LOGONv15:mg
S->C  LOGON SUCCESSFUL
S->C  <1>FEATURE: PING          ... <5>ADDUSER: legacy      (normal single-game burst)
C->S  MULTIGAME: 1
S->C  <6>MULTIGAME: 1
S->C  <7>BOARDS: 1
S->C  <9>BOARDS: 1 2
S->C  <10>BOARDS: 1 2 3
S->C  <11>SITE: MGE2E
S->C  <12>BOARD 1 WPLAYER: Berserk B
S->C  <13>BOARD 1 BPLAYER: Berserk A
S->C  <14>BOARD 1 FEN: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq
S->C  <15>BOARD 1 FMR: 0
S->C  <16>BOARD 1 level 0 0:08 0.08
S->C  BOARD 1 WTIME: 808 otim 808
S->C  BOARD 1 BTIME: 808 otim 808
S->C  BOARD 1 WPV: 1 47 0 20 d2d4
```

End of a game (board 2 finished first, so it is PGN game 1):

```
S->C  BOARD 3 BINFO: depth 24 seldepth 24 score cp 0 wdl 5 990 5 nodes 125531 nps 2615229 ...
S->C  <1159>BOARD 2 FEN: 5R2/8/8/2Pr4/1P3k2/4p1p1/1P2K3/8 b -
S->C  <1160>BOARD 2 WMOVE: 62. Rf8+
S->C  <1161>BOARD 2 FMR: 10
S->C  <1162>BOARD 2 GAMENO: 1
S->C  <1163>BOARD 2 result: 1/2-1/2
```

Opt-in snapshot after a bridge restart (the client re-LOGONed on the notice; its bare board-1 snapshot was still queued
when `MULTIGAME: 1` arrived, so it was replaced by the wrapped one; boards 1-3 mid-game; 2026-11-15 run, PV lines cut):

```
S->C  <19>MULTIGAME: 1
S->C  <20>BOARDS: 1 2 3
S->C  <21>SITE: uci-to-tlcs
S->C  <22>BOARD 1 WPLAYER: Berserk B
S->C  <23>BOARD 1 BPLAYER: Berserk C
S->C  <24>BOARD 1 FEN: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq
S->C  <25>BOARD 1 FMR: 0
S->C  <26>BOARD 1 FEN: 8/8/R5pk/5r1p/7P/5PK1/8/8 w -
S->C  <27>BOARD 1 FMR: 74
S->C  <28>BOARD 1 FEN: 8/8/R5pk/5r1p/7P/5PK1/8/8 w -
S->C  <29>BOARD 1 WMOVE: 141. (setup)
S->C  <30>BOARD 1 FMR: 74
S->C  <31>BOARD 1 level 0 0:08 0.08
S->C  BOARD 1 WTIME: 228 otim 265
S->C  BOARD 1 BTIME: 265 otim 228
S->C  BOARD 1 WPV: 34 0 2 103526 a6a4 f5b5 ...
S->C  BOARD 1 BPV: 38 0 7 300097 g7h6 a6a7 ...
S->C  BOARD 1 WINFO: depth 34 seldepth 22 score cp 0 ...
S->C  BOARD 1 BINFO: depth 38 seldepth 38 score cp 0 ...
S->C  <32>BOARD 2 WPLAYER: Berserk C
S->C  <33>BOARD 2 BPLAYER: Berserk B
S->C  <34>BOARD 2 FEN: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq
S->C  ...                           (board 2, then board 3, the same way)
```

Reference setup to reproduce: `docs/e2e-testing.md` §8 (bridge + concurrent fastchess + mocks; check with
`npm run e2e-check -- --fastchess games.pgn --transcript mg.jsonl`, which verifies every `GAMENO` game's names and
result, and its full move list, or for a game the client joined late or lost lines in, the moves since its last FEN
reload and the final position, against fastchess).

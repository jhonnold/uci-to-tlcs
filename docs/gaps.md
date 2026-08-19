# Known gaps vs. the node-tlcv contract

What to reach for: judging whether uci-to-tlcs is a faithful TLCS server for a real
node-tlcv (or desktop TLCV) consumer, or deciding what to build next. This is an
**exploratory gap analysis** (as of 2026-08), not a fixed spec — the contract keeps
moving with node-tlcv.

## Framing

- uci-to-tlcs is a minimal TLCS **server**; node-tlcv is the TLCS **client** it feeds.
  There is no official spec — the contract is whatever node-tlcv accepts, so every
  claim here is reverse-engineered from `../node-tlcv` (`src/protocol.ts`,
  `src/game-service.ts`, `src/broadcast.ts`, `src/transport/*`, `src/services/result-parser.ts`).
- The core tension: a UCI log is a **straight-through stream** of "what is happening now".
  Long-term state — a game's true result, its number, the tournament crosstable — is **not
  in the moves** and has to come from somewhere stateful (a PGN, producer metadata) that we
  do not yet consume. Most gaps below are downstream of that.

## Command surface: what node-tlcv accepts vs. what we emit

node-tlcv recognizes **22** TLCS commands (`../node-tlcv/src/protocol.ts:1-24`, one handler
each in `src/game-service.ts:74-99`). We emit **18** of them (`src/tlcs/protocol.ts`); every
command we emit is accepted, so nothing we send is dropped as unknown.

| accepted by node-tlcv | we emit |
|---|---|
| FEN, WMOVE/BMOVE, WPLAYER/BPLAYER, WPV/BPV, WTIME/BTIME | ✅ |
| SITE, FMR, result | ✅ |
| CT, CTRESET, ADDUSER, DELUSER, CHAT, PONG | ✅ |
| **MENU** | ❌ (the only *functional* one missing) |
| LOGON, FEATURE, LEVEL | ❌ (all **no-ops** in node-tlcv, so absence is free) |

We reply `LOGON SUCCESSFUL`, which is not in node-tlcv's enum but parses to the no-op
`LOGON` token, so it is harmless. `MENU` is the one real capability node-tlcv exposes (a
viewer menu bar built from `NAME=`/`URL=` pairs, `game-service.ts:476`) that we never feed.

## Client→server commands (all handled)

node-tlcv, as client, sends exactly six commands (`src/broadcast.ts`, `src/transport/udp-transport.ts`).
All six are handled by `src/tlcs/server.ts:153-182`; none hits the `Unhandled client message` branch.

| node-tlcv sends | we respond |
|---|---|
| `LOGONv15:<user>` (once, at boot — `broadcast.ts:58`) | `LOGON SUCCESSFUL` + ADDUSER to others + snapshot |
| `PING` (10s — `broadcast.ts:59`) | `PONG` |
| `RESULTTABLE` (`broadcast.ts:70`) | `CTRESET` + `CT: total games = 0` |
| `CHAT: <msg>` (`broadcast.ts:74`) | re-broadcast `<user>: <msg>` |
| `LOGOFF` (`broadcast.ts:85`) | `DELUSER` to others |
| `ACK: <id>` (`udp-transport.ts:68`) | advances the stop-and-wait reliable channel |

## The RESULTTABLE gap (the stateful one)

node-tlcv uses `RESULTTABLE` to rebuild the **crosstable + game archive + `currentGameNumber`**
(`game-service.ts:430-454`). We answer with a fixed stub — `CTRESET` then `total games = 0`
(`src/tlcs/server.ts:218`) — regardless of how many games we have broadcast.

- **What a proper table is** (from `result-parser.ts`): a standings block (`RANK … GAMES POINTS`
  header + one H2H column per player; cells `1`/`=`/`0`, `*` self, `.` unplayed), a `game no.`
  section (`<n> <white> <black> <1-0|0-1|1/2-1/2|*>`), and a `total games = N` footer.
- **It is fully derivable from `(game#, white, black, result)` tuples** — no move bodies. So a
  PGN's *headers* (White/Black/Result + sequence number) are enough; the PGN body is irrelevant
  to the table.
- **What we lack to produce it:**
  1. a **global game counter** — none exists (only in-game move history in `GameState`);
  2. a **finished-games accumulator** — `Pipeline` emits `result` then `beginNewGame()` discards
     it; the server keeps only the single live-game snapshot;
  3. a **crosstable renderer** matching the format above;
  4. **reliable transport** for a multi-line dump — `sendResultTable` uses the unreliable channel
     (`server.ts:218`), so a large table would drop lines.
- **Identity is name-keyed**: the H2H matrix keys rows on player *name*. fastchess identity is the
  configured engine name, and identical binaries share a name — two same-named engines collapse
  into one row.

## Other gaps (prioritized)

- **A. One-shot LOGON is all-or-nothing (robustness).** Both send channels gate on
  `this.clients` (reliable: `ReliableSender.getClients()`; unwrapped: `broadcastUnwrapped`,
  `server.ts:274`), and only `LOGONv15` registers a client — `PING` does not. node-tlcv LOGONs
  **once and never retries**. So any missed LOGON — the boot race (`docs/e2e-testing.md`) **or a
  bridge restart** — leaves node-tlcv getting only PONGs: 0 moves / 0 PV / 0 clocks, until
  node-tlcv itself restarts. The bridge-restart case is the same bug, unrecoverable mid-session.
- **B. Result is board-only, so most real endings become `*` (correctness).** UCI has no result
  command. We derive it from the board (mate/stalemate/3fold/50-move) or synthesize `*`
  (`pipeline.ts:308`, `beginNewGame` `:166`). A **flag/time, resignation, or adjudication** all
  broadcast as `*` rather than 1-0/0-1/½; node-tlcv then saves the PGN and fires
  `game-finished` with `*`.
- **C. Games must be sequential, not concurrent (scope).** One `GameState`, one board. The e2e
  runbook insists on `-concurrency 1`. Interleaved UCI from two engine-pairs can't be split on a
  single board.
- **D. Inter-game board reset only on startpos (edge).** node-tlcv resets its board in `onFen`
  **only for a startpos FEN** (or first load) (`game-service.ts:129`). Our per-game header emits
  the actual start FEN; a new game opening from a non-startpos FEN (chess960, endgame study,
  handicap) is treated as backup-only — the new game's move 1 applies to the *previous* board.
- **E. `currentGameNumber` pinned at 1 (symptom of RESULTTABLE).** With the `total games = 0`
  stub, node-tlcv's `currentGameNumber` stays at its default (`game-service.ts:445` derives it
  from the games list); every result is labeled "Game 1" and `savePgn` overwrites one filename.
- **F. Clocks update only on `go` (fidelity).** WTIME/BTIME sent only when a `go` carries
  `wtime`/`btime`, plus the snapshot. No tick between moves (fine for replay); a producer omitting
  clock state leaves a side's clock stale; the increment is read but never modeled.
- **G. No persistence in the bridge (operational).** Restart re-tails from 0 (default) = full
  replay; with `--from-end` a restart loses prior move history. The mid-game resync now
  restores the board + names, but the shown move list still starts at the join point and the
  RESULTTABLE is a stub.
- **K. Mid-game snapshot has no move list (fidelity, accepted).** The real server replays the
  **last move** (FEN-before → BMOVE/WMOVE → FEN-after) so a joiner's move list carries one
  prior move; we send only the current FEN (see `tlcs-wire.md`). node-tlcv handles both —
  the board is correct either way, and the saved PGN starts from the join point in both cases.
- **H. Desktop TLCV is assumed, not validated (coverage).** All invariants are reverse-engineered
  from node-tlcv + the mock client. Desktop TLCV may want `MENU`, a different LOGON-success string,
  or a full 6-field FEN.
- **J. The "reliable" channel is bounded — lossy against a slow consumer (robustness, reproduced).**
  The stop-and-wait sender (`src/tlcs/reliable-sender.ts:92-99`) retransmits each ID-wrapped message
  at most `maxTries=4` × `retransmitMs=750` (~3s). If a client doesn't `ACK: <id>` in that window the
  bridge **advances past it** — the message is dropped for that client while the id sequence keeps
  climbing. node-tlcv drops ids below its last-seen but accepts a higher one, so the gap is silent:
  the next move lands on a board missing the lost one, and recovery rides on the **next `FEN`**
  (node-tlcv self-corrects with "…Loading from FEN"). **Reproduced in the 2026-08 fast RR (10s games):**
  node-tlcv was too busy (PV + lichess tablebase + SAN parse) to ACK ~23 state-critical messages →
  23 `Reliable msg <N> unacked after 4 tries; advancing`. (The send log counts every resend, so raw
  tallies — 1872/1853 WMOVE/BMOVE sent vs 1838/1832 received — can't be diffed exactly, but the
  direction is clear: a slow consumer loses state-critical moves.) Net effect: the "reliable" channel
  degrades to lossy under a slow viewer; a live board can transiently skip a move and re-sync on the
  next FEN. Fix ideas: longer/backed-off retry, per-client pacing, or make the next FEN the explicit
  resync anchor.
- **Smaller:** `MENU` not emitted; LOGON **snapshot ordering** mixes reliable (FEN/players,
  stop-and-wait) with unwrapped (PV/clock, immediate), so a fresh client can get PV before its
  position and briefly replay against the wrong board; identity is display-name-keyed (fine for
  the live board, collapses same-named engines in a crosstable).

## Where the evidence lives

- Wire/transport rules & the new-game emit-order contract: `docs/tlcs-wire.md`.
- Move emission, board-derived results, game segmentation: `docs/pipeline.md`.
- Live-path runbooks + the LOGON-race: `docs/e2e-testing.md`.
- Acceptance contract (source of truth): `../node-tlcv/src/{protocol,game-service,broadcast}.ts`,
  `../node-tlcv/src/transport/{udp-transport,message-buffer}.ts`,
  `../node-tlcv/src/services/result-parser.ts`.

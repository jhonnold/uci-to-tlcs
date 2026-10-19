# Status vs. the node-tlcv / desktop contract

What to reach for: judging whether uci-to-tlcs is a faithful TLCS server for a real
node-tlcv (or desktop TLCV) consumer, picking what to build next, or checking whether a
behaviour is a known limitation. Status as of `8dc7903`.

## Framing

- uci-to-tlcs is a minimal TLCS **server**; node-tlcv is the TLCS **client** it feeds.
  There is no official spec — the contract is whatever node-tlcv accepts, so every
  claim here is reverse-engineered from `../node-tlcv` (`src/protocol.ts`,
  `src/game-service.ts`, `src/broadcast.ts`, `src/transport/*`, `src/services/result-parser.ts`).
- The core tension: a UCI log is a **straight-through stream** of "what is happening now".
  Long-term state — a game's true result, its number, the tournament crosstable — is **not
  in the moves** and comes from the tournament PGN (`TOURNEYPGN`, written by fastchess `-pgnout`).

## Gap status

| Gap | What it was | Status |
|---|---|---|
| A. One-shot LOGON | A missed LOGON (boot race, server restart) left node-tlcv with only PONGs | **FIXED.** Unknown clients get `MSG: … no longer connected` on `PING`/`CHAT`/`CHANGE`; node-tlcv re-LOGONs on it. The desktop TLCV must be reconnected by the operator after a restart without `STATEFILE` |
| B. Results were board-only | Resign/adjudication/forfeit broadcast as `*` | **FIXED with `TOURNEYPGN`** (PGN `Result` is authoritative). Without it: board result, else `*` |
| C. Sequential games only | One board, one `GameState` | **Remains.** `-concurrency 1` is required; interleaved logs cannot be demuxed |
| D. Board reset on non-startpos | node-tlcv resets only on a startpos FEN | **FIXED** with the synthetic `(setup)` move (`FENSETUPMOVE`, default on); see `tlcs-wire.md` |
| E. `currentGameNumber` pinned at 1 | RESULTTABLE was a stub | **FIXED.** Numbered `RESULTTABLE`/`GAMELIST` crosstable from the PGN registry; node-tlcv files are `N_<white>_vs_<black>.pgn` |
| F. Clocks only on `go` | No ticking between moves; the increment is not modeled | **Remains** (fine for replay) |
| G. No persistence | A restart replayed the log as live traffic | **FIXED.** `STATEFILE` + silent catch-up; see README "Restart and persistence" |
| H. Desktop TLCV assumed | Invariants come from node-tlcv and the mock | **PARTIAL.** The desktop client is emulated by `mock-client --mode desktop` (untrimmed parsing, `LOGON SUCCESSFUL` gate, 100-id ring, numbered PING); the real TLCV 2.1c under Wine has **not** been run |
| J. Bounded "reliable" channel | Dropped state-critical messages after ~3 s | **FIXED.** Per-client stop-and-wait with adaptive RTO, 30 s give-up with replay resync, stall detection, metrics |

## Command surface

node-tlcv recognizes 23 TLCS commands (`../node-tlcv/src/protocol.ts`, one handler each in `game-service.ts`).

Emitted by us (`src/tlcs/protocol.ts`, `commands.ts`, `results/`): `FEN`, `FMR`, `WMOVE`/`BMOVE`, `WPLAYER`/`BPLAYER`,
`WPV`/`BPV`, `WTIME`/`BTIME`, `SITE`, `result`, `level`, `CT`/`CTRESET`, `GL`, `ADDUSER`/`DELUSER`, `CHAT`, `PONG`,
`MENU` (verbatim from the ini), `FEATURE: PING`, `LOGON SUCCESSFUL`, `MSG:`, `SECUSER`.

Handled from clients (`tlcs/server.ts`, `commands.ts`, `admin.ts`, `results/result-commands.ts`): `LOGONv15`,
`LOGON:` (refused), `LOGOFF`, `CHANGE`, `PING`, `CHAT` (plus the `<who> <time> <ver> <stats> <q>` queries), `VOTE` (ignored),
`EMAIL`/`SEND` (not supported), `RESULTTABLE`, `GAMELIST`, `ACK`, `ADMIN`, `SECURITY`, `BOOT`, `SRBOOT`.

## Known limitations

- **Concurrency:** `-concurrency 1` only (gap C).
- **Strict addressing / WinBoard adapter:** not implemented (replies always go to the source `ip:port`; fastchess and raw UCI are the
  only producers).
- **Desktop TLCV:** only emulated (gap H). It cannot send `ADMIN:`, so admin is done from a script (`mock-client --control`).
  After a restart *without* `STATEFILE` the operator must reconnect it. A restart *with* `STATEFILE` is safe for the desktop only
  once it has received more than 100 numbered ids from the previous session (its duplicate ring).
- **Restart without `STATEFILE`:** games that end during the outage are lost for clients; node-tlcv saves the next game under a
  stale number (the numbering dump on LOGON mitigates this).
- **`STATEFILE`** is written atomically but not fsynced, and is ignored when older than 10 min.
- **Same-named engines collapse** into one row of the crosstable (identity is the display name).
- **`BANNED=`/`SRBOOT`** are IPv4-only.
- **All clients behind one IP share the per-IP rate-limit bucket** (burst 30, 10/s). Many mocks on 127.0.0.1 can trip it.
- **TLCS FEN drops the en-passant field**, so node-tlcv's `[FEN]` always has `-`.
- **Clocks do not tick** between moves (gap F).
- **MENU `NAME` with spaces** is mangled by node-tlcv (see below).
- **Fast-TC backlog artifacts** (blitz-speed message rates, e.g. `tc=3+0.05` at 5 % loss): a few `(Book)` labels when a mover's
  final PV is not numbered ahead of its move (fix deferred as T13: reliable final PV), and hard-cap eviction of a control item during a full-log live replay. Neither
  occurs at real time controls (10 min + 5 s) and neither affects moves or results.

## node-tlcv follow-ups

Client-side changes that would remove a workaround here (never committed from this repo):

- Parse `MENU` with a quote-aware tokenizer (`game-service.ts` `onMenu`): names with spaces are mangled today.
- Reset the board on any `FEN` that directly follows `WPLAYER`/`BPLAYER`: removes the need for the `(setup)` move.
- A freshly started node-tlcv begins at `currentGameNumber = 1` and only learns the real number after a `result`; the server
  works around it with a numbering dump on every LOGON.

## Where the evidence lives

- Wire/transport rules, restart numbering & the new-game emit-order contract: `docs/tlcs-wire.md`.
- Move emission, PGN-authoritative results, game segmentation, restart catch-up: `docs/pipeline.md`.
- Live-path runbooks, the LOGON-race and the restart/churn acceptance scenario: `docs/e2e-testing.md`.
- Acceptance contract (source of truth): `../node-tlcv/src/{protocol,game-service,broadcast}.ts`,
  `../node-tlcv/src/transport/{udp-transport,message-buffer}.ts`,
  `../node-tlcv/src/services/result-parser.ts`.

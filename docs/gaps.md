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
| C. Sequential games only | One board, one `GameState` | **FIXED server-side (TLCS-MG v1).** `-concurrency N` logs are demuxed by fastchess worker thread into boards; opted-in clients get every board (`docs/tlcs-multigame-spec.md`), legacy clients board 1. **node-tlcv follow-up:** implement the client side of the spec |
| D. Board reset on non-startpos | node-tlcv resets only on a startpos FEN | **FIXED** with the synthetic `(setup)` move (`FENSETUPMOVE`, default on); see `tlcs-wire.md` |
| E. `currentGameNumber` pinned at 1 | RESULTTABLE was a stub | **FIXED.** Numbered `RESULTTABLE`/`GAMELIST` crosstable from the PGN registry; node-tlcv files are `N_<white>_vs_<black>.pgn` |
| F. Clocks only on `go` | No ticking between moves; the increment is not modeled | **Remains** (fine for replay) |
| G. No persistence | A restart replayed the log as live traffic | **FIXED.** Silent catch-up to the game in progress; clients re-LOGON on the notice (no client state is kept; `STATEFILE` is ignored). See README "Restart" |
| H. Desktop TLCV assumed | Invariants come from node-tlcv and the mock | **PARTIAL.** The desktop client is emulated by `mock-client --mode desktop` (untrimmed parsing, `LOGON SUCCESSFUL` gate, 100-id ring, numbered PING); the real TLCV 2.1c under Wine has **not** been run |
| J. Bounded "reliable" channel | Dropped state-critical messages after ~3 s | **By design (best effort).** Per-client stop-and-wait with adaptive RTO; any line is dropped after 5 s, stale moves of a client that falls behind are replaced by a forced FEN reload; the client's board recovers from the next `FEN:` (only its PGN history is lost). Metrics `tlcs_dropped_total` |

## Command surface

node-tlcv recognizes 23 TLCS commands (`../node-tlcv/src/protocol.ts`, one handler each in `game-service.ts`).

Emitted by us (`src/tlcs/protocol.ts`, `commands.ts`, `results/`): `FEN`, `FMR`, `WMOVE`/`BMOVE`, `WPLAYER`/`BPLAYER`,
`WPV`/`BPV`, `WTIME`/`BTIME`, `SITE`, `result`, `level`, `CT`/`CTRESET`, `GL`, `ADDUSER`/`DELUSER`, `CHAT`, `PONG`,
`MENU` (verbatim from the ini), `FEATURE: PING`, `LOGON SUCCESSFUL`, `MSG:`, `SECUSER`.

Handled from clients (`tlcs/server.ts`, `commands.ts`, `admin.ts`, `results/result-commands.ts`): `LOGONv15`,
`LOGON:` (refused), `LOGOFF`, `CHANGE`, `PING`, `CHAT` (plus the `<who> <time> <ver> <stats> <q>` queries), `VOTE` (ignored),
`EMAIL`/`SEND` (not supported), `RESULTTABLE`, `GAMELIST`, `ACK`, `ADMIN`, `SECURITY`, `BOOT`, `SRBOOT`.

## Known limitations

- **Concurrency (gap C):** legacy clients (today's node-tlcv, desktop TLCV) see board 1 only, and a legacy node-tlcv may save a
  board-1 game under another game's number (it derives numbers from the newest `CT:` row). `SAVEDEBUG` is
  disabled once a second board exists. PGN matching uses SAN movetext (`-pgnout notation=san`, the default); with other
  notations two concurrent games with the same pairing, start and length can swap numbers. Verified on Linux fastchess
  1.8.2 only (worker-thread id = game). Stop-and-wait is shared by all boards (~3 numbered items per move per board per client).
- **Strict addressing / WinBoard adapter:** not implemented (replies always go to the source `ip:port`; fastchess and raw UCI are the
  only producers).
- **Desktop TLCV:** only emulated (gap H). It cannot send `ADMIN:`, so admin is done from a script (`mock-client --control`).
  After a server restart the operator must reconnect it (it shows the "no longer connected" notice; it does not re-LOGON by
  itself, measured with the desktop mock 2026-11-15).
- **Best-effort delivery (by design):** a lost line (5 s), a stale-move drop or a mid-game join costs a client its PGN history
  for that game: node-tlcv saves it from the reload position (`[SetUp][FEN]`); a lost `result:` means the game is not saved.
  Rarely a move after a lost one is legal on the stale board, so node-tlcv shows a wrong board until a later move fails to
  apply (no forced reload on a give-up). Desktop TLCV gets gaps in its move list.
- **Restart:** games that end during the outage are not sent to anyone (node-tlcv does not save them; they stay in `CT:`/`GL:`);
  the numbering dump on every LOGON keeps node-tlcv's numbers right.
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
- Accept SAN PV tokens again (try the from/to slice, fall back to `chess.move(token)`): `replayUci` (`src/util/uci.ts`) has
  parsed coordinates only since node-tlcv f465dc3 (2026-08-03); before that it took both. We now send coordinates, but a feed
  that relays SAN would lose its PV pane silently.
- Consume `WINFO`/`BINFO` (`docs/tlcs-wire.md`): parse the tag-value pairs, keep seldepth/wdl/nps/hashfull/tbhits in
  `liveData` and the move meta, and show them in the UI. Until then node-tlcv drops them as unknown commands. The desktop
  TLCV is assumed to ignore them too (not verified against the binary).
- A freshly started node-tlcv begins at `currentGameNumber = 1` and only learns the real number after a `result`; the server
  works around it with a numbering dump on every LOGON.
- Request `RESULTTABLE` after every `LOGON SUCCESSFUL` (today only at start-up and after a result): would remove that dump.

## Where the evidence lives

- Wire/transport rules, restart numbering & the new-game emit-order contract: `docs/tlcs-wire.md`.
- Move emission, PGN-authoritative results, game segmentation, restart catch-up: `docs/pipeline.md`.
- Live-path runbooks, the LOGON-race and the restart/churn acceptance scenario: `docs/e2e-testing.md`.
- Acceptance contract (source of truth): `../node-tlcv/src/{protocol,game-service,broadcast}.ts`,
  `../node-tlcv/src/transport/{udp-transport,message-buffer}.ts`,
  `../node-tlcv/src/services/result-parser.ts`.

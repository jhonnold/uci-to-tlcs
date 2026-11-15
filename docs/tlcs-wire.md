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
    50 ms–2 s, doubling per retransmit of one item; an ACK of a retransmitted item lifts the next RTO by at most 2x, since it is ambiguous under Karn). Queued PV/clock items are replaced by a newer one only while no numbered item is queued after them, so a PV is never delivered behind the move it precedes.
    **Best effort:** a line still unACKed after `giveUpMs` (5 s) is dropped, whatever it is (move, `result`,
    players, control; a control line's `onGiveUp` runs), and the next one goes out. A client's board recovers by
    itself: every move is preceded by its post-move `FEN:`, and node-tlcv reloads that FEN when a move does not apply
    (`onMove` catch → `resetFromFen()`); only its PGN history is lost (that game's PGN starts at the reload, with
    `[SetUp][FEN]`; a lost `result:` means that game is not saved). A client with more than `maxQueue` (256) game lines queued (moves, players,
    PV/clock; control lines such as a crosstable dump do not count) has fallen behind: per board and game, its queued
    move steps (`FEN`/`xMOVE`/`FMR`) and the PV/clock lines before the newest one are dropped and the **position steps**
    of the newest one take its place when they are fewer (see "Position steps"), so every game still ends on its real
    final position ahead of its `result:`; players, `level`, `GAMENO`, `result`, later PV/clock and control lines
    stay. Metrics: `tlcs_giveups_total{kind}`, `tlcs_dropped_total{reason=giveup|stale}`. Used for SITE / PLAYER /
    FEN / MOVE / FMR / level / result / user / chat.
  - *Unnumbered* — fire-and-forget, latest-only per key: WPV / BPV / WINFO / BINFO / WTIME / BTIME. An idle
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
  and `rawSendTo(dest)` splits a token. A client silent past `clientTimeoutMs` (default 70 s, covers
  the desktop's 20 s PING) is reaped — idle-timeout only, *never* on a reliable ACK
  timeout. The reaper broadcasts `DELUSER` + `CHAT: [SERVER] - Lost connection with <n>`.

- **Session commands** (`tlcs/commands.ts`, `SessionCommands`):
  - `LOGON:` (old viewer) → plain `MSG:Connection refused…`. `LOGONv15:<name>`: name stripped of
    control chars and `:<>`, clamped to 30, empty → `Anonymous`, deduped `name 1`… (own slot
    excluded, so a same-`ip:port` re-logon keeps its name). Burst to the newcomer: plain
    `LOGON SUCCESSFUL`; numbered `FEATURE: PING`; `resync` (the join snapshot: SITE, players,
    position steps, level, clocks/PV); `DELUSER: <old>` (renaming re-logon only); `ADDUSER:` self then others;
    `MENU` lines verbatim. Others get `ADDUSER` + `CHAT: [Server] <n> has arrived!` only for a
    new client (rename: `DELUSER`+`ADDUSER`).
  - `LOGOFF` → `DELUSER` + `CHAT: [SERVER] - <n> has left!`. `CHANGE:<n>` → `DELUSER`, `ADDUSER`,
    `CHAT: [SERVER] - Alias changed from <a> to <b>`. `CHAT:<t>` → numbered `CHAT: [<name>] - <t>`
    to everyone (sender included); `<who> <time> <ver> <stats> <q>` get plain private
    `CHAT: [SERVER] …` replies. `VOTE:` ignored; `EMAIL:`/`SEND:` → `MSG:` not supported.
  - `PING`: known → numbered `PONG`; unknown → plain `MSG: You are no longer connected to the
    server.  Please re-connect.` (no PONG). Plain PINGs (node-tlcv) always get it; numbered PINGs
    (desktop, modal per notice) at most once per 60 s per source. Unknown `CHAT`/`CHANGE` get it too.
    Recovery after a restart/reap: node-tlcv ≤10 s, desktop on its next PING (≤20 s).

- **Encoding invariants** (easy to regress, all enforced implicitly): 3-field
  truncated FEN (`board stm castling`); time ms→centiseconds (÷10); `score cp` is
  broadcast in side-to-move (engine) POV — each engine's own perspective, matching
  real TLCS, **no** White-POV flip; only `multipv 1` is the broadcast eval; mate
  mapped to ±(100000 − n) so node-tlcv renders it decisive.
  `WPV`/`BPV` moves are **UCI coordinates** (`e2e4`, `e1g1`, `e7e8q`), truncated at the first illegal move:
  node-tlcv's `replayUci` (`src/util/uci.ts`) slices from/to out of each token, so a SAN PV plays zero
  moves and the PV pane stays empty while depth/score/nodes still update. The desktop TLCV prints the
  tokens as-is.
- **`WINFO`/`BINFO`** (extension, not in the reference): the full `info depth …` search line as
  UCI-style `<tag> <value…>` pairs in **raw UCI units**, sent right after every `WPV`/`BPV` with the
  same legal PV prefix:
  `WINFO: depth 33 seldepth 64 score cp 61 wdl 196 801 3 nodes 18853873877 nps 263995696 hashfull 214 tbhits 36079 time 71417 pv h2h3 …`.
  `time` in ms; `score cp|mate` in engine POV with no mate collapse; `lowerbound`/`upperbound` flags;
  tags the engine omitted are omitted. `depth`, `score`, `nodes`, `time`, `pv` always present, `pv` last;
  consumers must accept any tag order and skip unknown tags. Unnumbered, latest-only (`WINFO`/`BINFO`
  keys); a LOGON resync sends the last of each after the last PV. Legacy consumers keep reading `WPV`/`BPV`; node-tlcv drops unknown commands (`splitOnCommand`).

- **Mid-game join** (`tlcs/server.ts` `resync`): every successful `LOGONv15` (new or known) and every TLCS-MG
  opt-in replaces the client's queued game lines by a **snapshot** of each board it sees: SITE, then for an
  unfinished game WPLAYER, BPLAYER, the position steps of the current position, `level`, then clocks and last
  PV/INFO as latest items. No move history is kept or sent: node-tlcv's PGN of a game it joined mid-way starts at the
  join (`[SetUp][FEN]`). A finished game is not resent (its result, if still queued, is dropped).
- **Position steps** (`positionSteps`): the non-startpos new-game sequence below, for the current position X:
  `FEN startpos`/`FMR 0` → `FEN X`/`FMR f` → `FEN X`/`xMOVE n. (setup)`/`FMR f`. The startpos FEN resets a loaded
  node-tlcv (`onFen`), the `(setup)` move always fails in chess.js so `resetFromFen()` loads X with the right `FMR`
  and move number, on a fresh and on an already-loaded client alike (verified on node-tlcv 9e3e6ee after a bridge
  restart, see `docs/e2e-testing.md` §8). X = the start position, or `FENSETUPMOVE=0`: just `FEN X`/`FMR f` (an
  already-loaded node-tlcv then shows its old board until a later move fails to apply).

- **Non-startpos new game** (`FENSETUPMOVE`, default on; also the position steps): `WPLAYER`/`BPLAYER` → `FEN startpos`/`FMR 0`
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

## Several games per port (TLCS-MG)

Opt-in extension, specified in `docs/tlcs-multigame-spec.md`: a client sends `MULTIGAME: 1` after `LOGON SUCCESSFUL`
and from the reply on gets every board's game lines wrapped as `BOARD <n> <line>` (numbered/unnumbered as the line
it wraps), a `BOARDS:` list and `GAMENO: <n>` before each PGN-matched result. A client that does not opt in gets
board 1 on the bare commands and never a new token. One id counter per client across boards; a re-LOGON drops the
opt-in (its queued wrapped lines are replaced by the LOGON resync's bare snapshot). On opt-in, the reply and
`BOARDS:` are queued, then the resync replaces the client's queued bare game lines by wrapped snapshots of every board.
Per client, the latest keys are `WPV@<board>` etc.; a stale-move drop works per board and never drops `GAMENO` or
`result`; `BOARDS:` is pinned against hard-cap eviction.

## Deliberate deviations from the reference server

Everything else follows `docs/tlcs-server-spec.md`; these differ on purpose (all accepted by node-tlcv and the desktop TLCV):

- `<N>` without the space (both clients parse either; input accepts both).
- Per-client ids and queues, not one global sequence; ids restart at 1 on every process start (see "Restart").
- Replies go to the datagram's source `ip:port`, not `clientIP:<broadcast port>`.
- `SITE: <text>` with a space after the colon.
- The mover's final PV is sent before its `FEN`/`xMOVE`.
- `WINFO`/`BINFO` extended search info (see the encoding invariants) is an addition.
- `result: <r>` with only `1-0`/`0-1`/`1/2-1/2`/`*`; the reference's `{<reason>}` text is not sent (`protocol.ts`).
- `DELAYAFTERMOVE`/`DELAYAFTERGAME` default to 0.
- Give-up after 5 s (reference: ~16 s) drops any line, including `CHAT` (the reference keeps resending CHAT and
  removes the client after 11 sends); a client never ACKing is removed by the idle reaper only.
- `RESULTTABLE`/`GAMELIST` replies are numbered to registered clients and rendered from the tournament PGN.
- Unknown `PING` gets the `MSG: … no longer connected` notice instead of `PONG`.
- `MENU` lines are passed through verbatim, but node-tlcv's `onMenu` (`game-service.ts`) splits the line on spaces and slices
  `NAME="…"` per token, so a `NAME` with spaces is mangled. Use names without spaces until node-tlcv is fixed
  (see `docs/gaps.md`).

## Admin & abuse

Replies are private, plain `CHAT: [SERVER] <text>` datagrams to the requester.

- `ADMIN:<secret>` (a direct datagram, plain or numbered; case- and whitespace-tolerant) authorizes
  that `ip:port` for `SECURITY`, `BOOT:<x>` and `SRBOOT:<x>`. Replies: `Admin access granted` / `Admin access denied` /
  `Admin login locked, try later` (5 failures per `ip:port` per 10 min; other ports on the same IP are unaffected) /
  `Admin commands are disabled` (no `ADMINPASS`). Before `LOGON` it gets `MSG_NOT_CONNECTED`.
  There is no CHAT-borne admin path: a `CHAT:` whose text (after an optional `(name) `) starts with `ADMIN:` is dropped
  (never relayed, no reply), so a pasted secret is not broadcast. Grants end on LOGOFF, reap, BOOT or re-LOGON.
- `SECURITY`: one plain `SECUSER: <name>:<ip>` per client. `BOOT:<x>`: `<x>` is `ip:port`, an IP (every client on it)
  or a name; the victim gets `MSG: You have been booted!`, then the LOGOFF path (`DELUSER`, `CHAT: [SERVER] - <name> has left!`).
  `BOOT:<own ip>` boots the requester too. `SRBOOT` also bans the IP (ring of 100, in memory) and refuses the requester's own IP.
  No match: `No such user: <x>`. Unauthorized: `Not authorized`.
- Banned source IPs (`BANNED=` and SRBOOT) are dropped silently before the ACK, as in the reference.
  A per-IP token bucket (burst 30, 10/s; ACKs are free) drops excess datagrams silently, which also caps
  the unknown-client notice reflection (small request, ~68-byte reply) per source IP.
- `MAXCLIENTS`: a new LOGON beyond the limit gets `MSG: Connection refused.  The server is full.` (once per dest per 60 s);
  re-LOGON of a known dest is always admitted. node-tlcv warns on that MSG, then gets `MSG_NOT_CONNECTED` on its PINGs and
  re-LOGONs at most once per 60 s, refused silently.
- Caveats: the secret travels in cleartext and grants are keyed by source address (spoofable); use a long random
  `ADMINPASS` (16+ chars, printable ASCII). A private `[SERVER]` reply to a node-tlcv dest is shown to all its web viewers.
  The desktop client cannot send `ADMIN:`, so admin is done from a script (`mock-client --control`).

## Results table & game list (`RESULTTABLE`, `GAMELIST`)

Rendered from the `--pgn` / `TOURNEYPGN` registry (`src/results/crosstable.ts`); without it the replies are "not configured" lines.
Delivery is **numbered** to registered clients (plain to unregistered requesters, as the reference does): `CTRESET`, then `CT:<line>` (no space after the colon).

- **Layout** (node-tlcv's `services/result-parser.ts` is positional; no line has leading whitespace): `RANK ENGINE GAMES POINTS 1 2 3...` header, dash separator, rows `N.  name  games  points  cells`, blank, `Total games = N`, blank, `Most recent games played...`, separator, `Game No.  White  Black  Result` and game rows.
- H2H cells are `1`/`=`/`0` in game order from the row player's view, `**` on the diagonal, `.` if unplayed. **Columns follow sorted standings order** (points desc, name asc); header labels are the ranks. Name and cell widths are dynamic; names have whitespace runs collapsed (node-tlcv splits game rows on 3+ spaces).
- `*` games are listed but not counted in the standings or `Total games`.
- **Game section is newest first** (max 300): node-tlcv sets `currentGameNumber = games[0].gameNumber + 1` (`game-service.ts` onCT), which names its saved PGNs `<N>_<white>_vs_<black>.pgn`. The PGN registry must hold game N before node-tlcv's post-result re-request (the pipeline waits for the PGN entry before emitting `result`). Without `--pgn`/`TOURNEYPGN`, node-tlcv's numbering stays at 1 and games overwrite each other, so treat it as required.
- If a `CT:` line is given up, the whole dump is re-sent (deferred, coalesced, at most 3 times), starting with a fresh `CTRESET`.
- `GL:` line: `GL:` + number (`#####`) + white (40) + black (40) + result (8), fixed width, newest first, max 300, not trimmed. A lost `GL:` line is not re-sent (no reset command). No games: `MSG:PGN file not found!  Sorry, the server cannot provide you with a list of games.`
- Latency: a 300-row dump is about 320 stop-and-wait items (about 50 ms on loopback, about 16 s at 50 ms RTT). If remote viewers matter, lower the `recent` argument of `renderCrosstable`.

## Restart: catch up to live, numbering dump, ids

- No client state survives a restart (`STATEFILE` is ignored with a warning). The server scans the log, catches up
  silently from the start of each board's game in progress (`src/state/start.ts`, `scanBoards`) and goes live. A
  client of the previous process gets the `MSG: … no longer connected` notice on its next datagram and re-LOGONs
  (node-tlcv ≤10 s, desktop ≤20 s), then gets the join snapshot. Games that finished while the server was down are
  never sent (node-tlcv does not save them).
- Per-client ids restart at 1 on every process start. node-tlcv accepts id 1 as a restart; the desktop TLCV drops a
  body only if its id is in its ring of the last 100 ids, so a restart is safe once it has received more than 100
  numbered messages from the previous session.
- node-tlcv saves a game's PGN on `result` under `currentGameNumber`, set by a 100 ms debounce timer after the last
  `CT:` line (cancelled by `CTRESET`), and asks for `RESULTTABLE` only at start-up and after a result, not after a
  re-LOGON. Every LOGON therefore gets, before its snapshot, `CTRESET` + the `CT:` lines of a `recent = 1` crosstable
  (newest finished game = g-1, so `currentGameNumber = g`; `src/state/numbering.ts`), and the last of those lines
  carries `holdMs = 300` in the sender: nothing numbered is sent for 300 ms after its ACK.

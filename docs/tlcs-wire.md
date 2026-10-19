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
    50 ms–2 s, doubling per retransmit of one item; an ACK of a retransmitted item lifts the next RTO by at most 2x, since it is ambiguous under Karn). Queued PV/clock items are replaced by a newer one only while no numbered item is queued after them, so a PV is never delivered behind the move it precedes. Give-up after 30 s (not 10 s: at 25% loss each way a 10 s give-up restarts a ~500-message replay that can itself give up): a *game* item is
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
  and `rawSendTo(dest)` splits a token. A client silent past `clientTimeoutMs` (default 70 s, covers
  the desktop's 20 s PING) is reaped — idle-timeout only, *never* on a reliable ACK
  timeout. The reaper broadcasts `DELUSER` + `CHAT: [SERVER] - Lost connection with <n>`.

- **Session commands** (`tlcs/commands.ts`, `SessionCommands`):
  - `LOGON:` (old viewer) → plain `MSG:Connection refused…`. `LOGONv15:<name>`: name stripped of
    control chars and `:<>`, clamped to 30, empty → `Anonymous`, deduped `name 1`… (own slot
    excluded, so a same-`ip:port` re-logon keeps its name). Burst to the newcomer: plain
    `LOGON SUCCESSFUL`; numbered `FEATURE: PING`; `resync` (SITE, players, setup, SANs, last
    FEN/FMR, clocks/PV); `DELUSER: <old>` (renaming re-logon only); `ADDUSER:` self then others;
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

## Deliberate deviations from the reference server

Everything else follows `docs/tlcs-server-spec.md`; these differ on purpose (all accepted by node-tlcv and the desktop TLCV):

- `<N>` without the space (both clients parse either; input accepts both).
- Per-client ids and queues, not one global sequence; ids restart at 1 on every process start (see "Restart").
- Replies go to the datagram's source `ip:port`, not `clientIP:<broadcast port>`.
- `SITE: <text>` with a space after the colon.
- The mover's final PV is sent before its `FEN`/`xMOVE`.
- `result: <r>` with only `1-0`/`0-1`/`1/2-1/2`/`*`; the reference's `{<reason>}` text is not sent (`protocol.ts`).
- `DELAYAFTERMOVE`/`DELAYAFTERGAME` default to 0.
- Give-up resyncs the client with a replay of the current game instead of skipping the message.
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

## Restart: numbering dumps and ids

- Per-client ids restart at 1 on every process start. node-tlcv accepts id 1 as a restart; the desktop TLCV drops a
  body only if its id is in its ring of the last 100 ids, so a restart is safe once it has received more than 100
  numbered messages from the previous session.
- node-tlcv saves a game's PGN on `result` under `currentGameNumber`, set by a 100 ms debounce timer after the last
  `CT:` line (cancelled by `CTRESET`). Before each replayed game a restored client therefore gets `CTRESET` +
  the `CT:` lines of a `recent = 1` crosstable (newest finished game = g-1, so `currentGameNumber = g`), and the
  last of those lines carries `holdMs = 300` in the sender: nothing numbered is sent for 300 ms after its ACK.

# TLCS Rebuild Specification

A specification for rebuilding **Tom's Live Chess Server (TLCS)**: the UDP broadcast server that the desktop
TLCV viewer and node-tlcv connect to. The original source is lost; this spec is derived from static reverse
engineering of the last published build, plus what the official viewer and node-tlcv expect.

Status: draft, 2026-10-16.

## 1. Sources and Confidence

| Artifact | Identity | Role |
| --- | --- | --- |
| `server.zip` (Wayback snapshot 2006-12-19 of `home.pacific.net.au/~tommyinoz/server.zip`) | sha256 `607629164afb9826adde7cca3215c66da2d9d56f1bdfd43821131117f58543fc` | Distribution |
| `tlc_server16a.exe` ("Version 1.6a", PowerBASIC Console Compiler) | sha256 `8d10d311b5f59e3dc1d9286aadd0877f172118099acce2b9e2d8b2ed84d37588` | **Reference server** |
| `server.ini` (sample in the zip) | — | Reference config |
| `chess_viewer.exe` 2.01.0003 (TLCV v2.1c) | sha256 `28513524586fd63da28610852ae0da3cbf21f2fea6605e26ca0e40a848081609` | Reference client |
| [`../node-tlcv/docs/official-client.md`](../../node-tlcv/docs/official-client.md) | — | Client-side protocol notes |

All behavior below was read from disassembly; nothing was executed. Statements are **observed** unless
marked *(inferred)* or *(unverified)*. Function addresses in `tlc_server16a.exe` are given so claims can be
re-checked. Note that PowerBASIC relocates its literal pool at startup (`0x4136c6`, moving `0x2164` bytes from
`0x41b028` to `0x41b558`), so string references only resolve against that relocated image.

## 2. Goals

1. **Wire-compatible** with the unmodified desktop TLCV 2.1c client and with node-tlcv.
2. **Behaviorally faithful** where a client can observe the difference (formats, ordering guarantees, logon
   burst, keepalive), and **better** where the original was fragile (section 9).
3. **Pluggable input**: the original only understood a WinBoard debug log. The rebuild treats that as one
   source adapter among several (WinBoard, myracle, fastchess, raw UCI).
4. Operable in 2026: config file, metrics, structured logs, persistence across restarts.

Non-goals: emailing PGNs (`gbmail.exe`, `MAILSERVER=`/`RETURNADD=`, `EMAIL:`/`SEND:`), the console UI, ICS
relay mode (until its behavior is traced; see §11).

## 3. Architecture

```
  log file(s) ──tail──▶ SourceAdapter ──events──▶ GameEngine (board, SAN, FEN, clocks, PVs)
                                                        │
                                                        ▼
                         Broadcaster (per-client queues, numbering, ACK, retransmit, coalescing)
                                                        │ UDP
                                                        ▼
                                    viewers (desktop TLCV, node-tlcv, …)
```

uci-to-tlcs already implements this shape (`src/source`, `src/game`, `src/tlcs`). The recommended path is to
grow it into the full server (§10) rather than start a new codebase.

## 4. Transport

### 4.1 Addressing

- One UDP socket bound to `PORT` (default **16000**). It receives client datagrams and sends everything.
- **Reference behavior:** every send goes to `clientIP:PORT`. The client's source port is ignored, and clients
  are identified by **IP only** (`RecvAndAck` `0x4083cf`, `RawSend` `0x4080e2`).
- **Rebuild MUST** send to `clientIP:PORT` by default, so clients that bind the broadcast port keep working.
- **Rebuild SHOULD** key clients by `ip:port` and offer a per-server option to reply to the source port
  (uci-to-tlcs's behavior). Clients that send from the broadcast port see no difference.
- Loopback (`127.0.0.1`) is reserved in the reference for a file bridge (`in.dat`/`out.dat`). The rebuild MAY
  drop the bridge but MUST NOT treat loopback specially otherwise.

### 4.2 Framing

- One datagram = one message. ANSI/Latin-1 text, no terminator, no newline. Empty datagrams are ignored.
- A **numbered** message is `"<" + STR$(id) + ">" + body`. PowerBASIC `STR$` prefixes non-negative numbers with
  a space, so the reference sends `< 42>FEN: …`. **Deliberate deviation: uci-to-tlcs emits `<42>FEN: …` with
  no space** (simpler; node-tlcv's `split('>')` and the desktop client's `Val()` both parse either form).
  The rebuild MUST accept `<42>` and `< 42>` on input.
- An **ACK** is `"ACK:" + STR$(id)` → `ACK: 42`. Accept any amount of whitespace after the colon on input
  (node-tlcv sends `ACK:  42`).

### 4.3 Receiving numbered messages (`0x4083cf`)

For a datagram whose first character is `<`:

1. `p = INSTR(2, msg, ">")`. Continue only if `p > 2`.
2. `id = VAL(MID$(msg, 2, p - 2))`. Continue only if `id > 0`.
3. Reply `ACK: <id>`, unnumbered, to the sender. Every copy is ACKed, including duplicates.
4. `body = MID$(msg, p + 1)`.
5. **Dedupe:** the reference keeps a ring of the last **100** `(id, ip)` pairs. A repeat yields an empty body.
   Rebuild MUST dedupe per client; SHOULD use a larger window or per-client high-water mark plus a recent set.

### 4.4 Sending numbered messages (`SafeSend` `0x4122f5`)

Reference:

| Property | Reference | Rebuild |
| --- | --- | --- |
| Id source | One **global** counter for all clients, incremented per (message × client); never reset while running | MUST be strictly increasing per client and MUST NOT reset on re-LOGON. SHOULD be per-client and persisted across restarts (§9.2) |
| Queue | 1000 slots `{id, body (fixed 100 chars), ip, lastSent, tries, acked}`, many in flight at once | Per-client queue, delivered **in id order** (§9.3), no truncation |
| ACK match | `ACK:` body → `VAL(MID$(body,5))` → mark slot acked (`0x412577`) | Match on `(client, id)` |
| Resend pass | Runs every 11th idle main-loop iteration; resends at most 6 slots per pass (`0x412657`) | Timer-driven, per client |

**Reference retransmit schedule** (times are lower bounds; the pass runs only when the loop is idle):

| Send # | When | Rule |
| --- | --- | --- |
| 1 | t = 0 | — |
| 2 | > 2 s after #1 | — |
| 3 | > 2 s after #2 | after this send, next check is pushed +4 s |
| 4 | ~ t + 10 s | — |
| give up | ~ t + 16 s | non-`CHAT` message is dropped. If the client has also been silent > 60 s it is removed and `CHAT: [SERVER]- Lost connection with <name>` is broadcast |
| `CHAT` only | keeps resending ~every 6 s | after 11 sends the client is removed (regardless of activity), and the slot keeps resending |

The `CHAT` path is a bug (it repeatedly removes the client and never clears the slot); see §9.4.

**Overload fallback (reference):** the server counts slots sent more than once and still unacked. While that
count is **> 20**, every numbered send degrades to an unnumbered send and every broadcast goes out raw to all
clients; PV flushes are suppressed (`0x411823` top, `0x4032fe`). Rebuild MUST NOT copy this global switch
(§9.3).

### 4.5 Client table (reference)

Up to **500** clients `{ip, name (30 chars), lastHeard}` (`0x41bc24`). `lastHeard` is refreshed by **any**
datagram from that IP. The table is kept compacted; broadcasts iterate until the first empty slot.

## 5. Session Protocol

### 5.1 Client → server

Matched in this order by the dispatcher (`ClientCmd` `0x411823`). Exact match unless a prefix length is given.

| Message | Match | Reference handling | Rebuild |
| --- | --- | --- | --- |
| `LOGON:…` | 6-char prefix | Plain `MSG:Connection refused.  The broadcast server does not support the version of the viewer you are using.` | Same |
| `LOGONv15:<name>` | 9-char prefix | Logon (§5.2) | Same |
| `LOGOFF` | exact | Remove client by IP; broadcast `DELUSER: <name>` and `CHAT: [SERVER] - <name> has left!` | Remove by client key |
| `RESULTTABLE` | exact | Plain `CTRESET` then `CT:` lines built from `TOURNEYPGN` (§7.3) | Same, but numbered or paced (§9.6) |
| `GAMELIST` | exact | Plain `GL:` lines from `TOURNEYPGN`, or a `MSG:` error | Same |
| `CHANGE:<newname>` | 7-char prefix | Rename; broadcast `DELUSER:`, `ADDUSER:`, `CHAT:[SERVER] - Alias changed from <old> to <new>` | Same |
| `CHAT: <who>` / `<time>` / `<ver>` / `<stats>` / `<q>` | exact | Plain, private `CHAT:[SERVER] …` replies (user count, date/time, `Version 1.6a`, counters, queue sizes) | Same; `<ver>` reports the rebuild version |
| `VOTE: <text>` | — | No handler found in the reference (the desktop client can send it) | Accept and ignore, or implement polls |
| `CHAT:<text>` | contains `CHAT:`, starts with it | From a known client: numbered broadcast `CHAT: [<name>] - <text>`. From an unknown IP: plain `MSG: You are no longer connected to the server.  Please re-connect.` | Same |
| `EMAIL:<addr>` / `SEND:…` | 6 / 5-char prefix | Email PGN | Non-goal: reply `MSG:` "not supported" |
| `PING` | exact | Numbered `PONG` to sender. **No login check** | Answer, but see §9.1 |
| `ACK: <id>` | 4-char prefix | Mark queued message acked | Same |
| `SECURITY` | exact | Admin list → `SECUSER:` lines | Authenticated admin only (§9.8); `SECUSER: <name>:<ip>`, one datagram per client (RE `0x412f99`) |
| `BOOT:<user>` / `SRBOOT:<user>` | 5 / 7-char prefix | Admin kick | Authenticated admin only; target is `ip:port`, IP or name; victim gets `MSG: You have been booted!`, then LOGOFF path; SRBOOT also bans the IP |

### 5.2 Logon (`0x4087ce`)

1. Name = text after `LOGONv15:`. Empty → `Anonymous`. If the name is taken, append `STR$(n)` (`name 1`, …).
2. Slot = first slot whose IP is empty or equals the sender's IP (so a re-logon from the same IP reuses it).
3. Plain `LOGON SUCCESSFUL` to the client.
4. Numbered, to the client, in this order:
   1. `WPLAYER: <white>`
   2. `BPLAYER: <black>`
   3. `SITE:<site>`
   4. `FEN: <game start FEN>`
   5. `FEATURE: PING`
   6. the last `WMOVE:`/`BMOVE:` message, if any
   7. `FEN: <current FEN>`
   8. one more stored message *(unverified; global `0x41b490`)*
5. Numbered broadcast `ADDUSER: <name>` to all clients, including the new one.
6. For each other client: numbered `ADDUSER: <their name>` to the new client, and numbered
   `CHAT: [Server] <new name> has arrived!` to that client.
7. Numbered, to the client: each configured `MENU …` line (up to 10).

Rebuild MUST keep steps 3–7 and their order. The desktop client ignores everything before `LOGON SUCCESSFUL`
and enables its keepalive only after `FEATURE: PING`.

### 5.3 Keepalive

- Clients that saw `FEATURE: PING` send `PING` (desktop: numbered, every 20 s; node-tlcv: plain, every 10 s).
- Reference removes a client only when a retransmit gives up **and** the client has been silent > 60 s, or via
  the `CHAT` bug. Rebuild MUST reap clients silent for longer than `CLIENT_TIMEOUT` (default 70 s, which covers
  the desktop client's 20 s PING with margin) and MUST NOT reap on ACK timeout alone.

## 6. Server → Client Messages

| Message | Delivery | Format | Source |
| --- | --- | --- | --- |
| `WPLAYER: <name>` / `BPLAYER: <name>` | numbered, all | Name from engine `feature myname=` or the launch command line | §7.2 |
| `SITE:<text>` | numbered, all | **Reference has no space** after the colon. Rebuild MUST send `SITE: <text>` (§9.5) | `SITE=` |
| `FEN: <board> <stm> <castling>` | numbered, all | **Three fields only**; the desktop client compares the start position against exactly `rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq` | Server's own board |
| `WMOVE: <n>. <san>` / `BMOVE: <n>. ... <san>` | numbered, all | SAN from the server's own board | Engine `move` |
| `FMR: <n>` | numbered, all | Fifty-move counter *(reference value derivation unverified; it divides a ply counter by 2)* | Server's own board |
| `WTIME: <cs> otim <cs>` / `BTIME: …` | **unnumbered**, all | Centiseconds as sent to the engine. Prefix = color of the engine about to move. **`otim` is required** by the desktop client | `time` + `otim` |
| `WPV: <depth> <score> <cs> <nodes> <pv…>` / `BPV: …` | **unnumbered**, all, **coalesced** | Engine's own output; score in the engine's own point of view (no White-POV flip) | Engine thinking line |
| `result <res> {<reason>}` | numbered, all | Passed through from WinBoard's `result` command | `>first : result` |
| `level <args>` | numbered, all | Passed through | `>first : level` |
| `ADDUSER: <n>` / `DELUSER: <n>` | numbered | — | Logon / logoff |
| `CHAT: …` | numbered (relay) / plain (server replies) | — | — |
| `MENU ID=<n> WIDTH=<w> HEIGHT=<h> NAME="<name>" URL="<url>"` | numbered, at logon | Verbatim `server.ini` line; NAME/URL may contain spaces | `MENU ` |
| `FEATURE: PING` | numbered, at logon | — | — |
| `CTRESET`, `CT:<line>` | plain, requester | Crosstable text | `RESULTTABLE` |
| `GL:<line>` | plain, requester | Game list | `GAMELIST` |
| `MSG: <text>` / `MSG:<text>` | plain | Modal popup in the desktop client | various |
| `LOGON SUCCESSFUL` | plain | — | Logon |
| `PONG` | numbered, sender | — | `PING` |
| `ACK: <id>` | plain | — | Every numbered client message |

### 6.1 Ordering guarantees

Within one client's stream, the reference produces, per move:

1. `xTIME` as soon as the `otim` line is read.
2. `xPV` coalesced: each thinking line overwrites a per-color slot; slots flush only when the reader reaches end
   of file.
3. `FEN`, then `xMOVE`, then `FMR`, as soon as the move line is read, then pause `DELAYAFTERMOVE`.

Consequence: the engine's last PV usually arrives **after** its move. node-tlcv has a special "trailing PV"
patch for this. Rebuild SHOULD flush the moving side's pending PV **before** `FEN`/`xMOVE` (§9.7); this is
compatible with both clients.

Retransmissions arrive out of order relative to newer messages. Clients must expect late ids.

## 7. Input: Source Adapters

### 7.1 Tailing contract (all file sources)

From the reference main loop (`0x402e90`):

- Poll: open the file, read its length, read new bytes from the last offset. CR is ignored, LF ends a line.
- A NUL byte means the writer hasn't flushed; stop and retry next poll.
- **Truncation** (length < offset) means a new session: reset game state, broadcast a start `FEN`, reread from
  offset 0 with broadcasting disabled.
- **Startup catch-up:** read the existing file from offset 0 with broadcasting **disabled** (state is tracked,
  nothing is sent). On reaching EOF, send one numbered burst to all clients (`WPLAYER`, `BPLAYER`, `SITE`, last
  move, `FEN`) and enable broadcasting.
- Rebuild MUST implement truncation and catch-up. It SHOULD also detect rotation (inode change) and SHOULD offer
  `--from-end`.

### 7.2 WinBoard debug log (reference adapter)

`>first :`/`>second:` = GUI → engine, `<first :`/`<second:` = engine → GUI. Lines may carry a numeric
timestamp prefix *(handling not fully traced)*.

| Line | Action |
| --- | --- |
| `StartChildProcess (dir=…) <cmd>` | Engine N launched; default display name from the command (`Human` is special-cased) |
| `<first : feature … myname="X"` | Engine display name → re-broadcast `WPLAYER`/`BPLAYER` |
| `>first : white` / `black`; `>first : go` / `>second: go` | Assign colors to engines; re-broadcast players |
| `>first : new` | New game: reset board, broadcast start `FEN` |
| `>first : level …` | Broadcast `level …` |
| `>first : time N` then `>first : otim M` (or `second`) | Broadcast `xTIME: N otim M` for that engine's color |
| `<first : <d> <score> <cs> <nodes> <pv>` (post format) | Store as that engine color's `xPV` |
| `<first : move <coord>` | Apply to board; emit `FEN`, `xMOVE`, `FMR`. Unknown move → log error, keep running |
| `>first : result <res> {…}` | Broadcast `result …` |
| `>first : quit` / `>second : quit` | Clear player names |
| `>first : force/post/hard/easy/xboard/ping/computer/ics`, `: usermove` | Ignored for broadcast |

Other formats the reference normalizes into WinBoard form before matching (`0x40d131`, `0x40dfbd`):
`1:`/`2:` prefixed logs, UCI output (`info depth … score cp … time … nodes … pv`, `bestmove`, `ucinewgame`),
`WHITE<<`/`BLACK>>` markers, and French "Démarre module N" banners.

### 7.3 Other adapters

The rebuild SHOULD ship: WinBoard (above), myracle `.debug`, fastchess `-log … engine=true`, raw UCI. These are
all present in uci-to-tlcs except WinBoard.

Every adapter produces the same event stream: `players`, `newGame{startFen}`, `clock{color,cs,otherCs}`,
`pv{color,depth,cp|mate,cs,nodes,pv[]}`, `move{color,uci|san}`, `result{res,reason}`, `level{text}`.

## 8. Configuration

The rebuild MUST read a reference-style `server.ini` (exact, case-sensitive column-0 key prefixes; there is no
real comment syntax: unmatched lines, including those starting with `'`, are ignored; see §8.1) and MAY additionally read a modern config file.

| Key | Default | Meaning | Rebuild |
| --- | --- | --- | --- |
| `PATH=` | — | Log file to tail | Same; `FORMAT=` extension below |
| `PORT=` | 16000 | Listen and broadcast port | Same |
| `SITE=` | — | Event name | Same |
| `DELAY=` | 100 | UDP receive timeout passed to UDP OPEN (`0x402d93`) | Poll interval |
| `DELAYAFTERMOVE=` | 300 | Pause after a move in ms | SHOULD default to 0 (§9.7) |
| `DELAYAFTERGAME=` | 1000 | Used after a result | Pause before the next game's burst |
| `ICSMODE=1` | off | ICS relay mode *(effect not traced)* | Ignored, logged as unsupported |
| `SAVEDEBUG=1` | off | Copy each game's log to `Debug-<white>_vs_<black>….log` | Same |
| `MENU ID=n …` | — | Up to 10 viewer menu entries | Same |
| `TOURNEYPGN=` | — | PGN for `RESULTTABLE`/`GAMELIST` | Same, plus a built-in results store (§9.6) |
| `MAILSERVER=`, `RETURNADD=` | — | Email | Ignored |
| `FORMAT=` | auto | Log producer: `auto`, `raw`, `fastchess` (`winboard`, `myracle`, `uci` are possible future values) | Rebuild extension |
| `FENSETUPMOVE=` | 1 | — | Non-startpos games: synthetic `(setup)` move so node-tlcv loads the FEN (`--fen-setup-move`) | Rebuild extension |
| `BIND=` | 0.0.0.0 | Local bind address | Rebuild extension |
| `STATEFILE=` | — | Persisted state file | Rebuild extension |
| `CLIENTTIMEOUT=` | 70 | Idle-client reap timeout, seconds | Rebuild extension |
| `ADMINPASS=` | — | Admin password | Rebuild extension |
| `MAXCLIENTS=` | 0 | Max clients, 0 = unlimited | Rebuild extension |
| `BANNED=` | — | Source IPs dropped silently (comma/space separated, repeatable) | Rebuild extension |

### 8.1 server.ini parsing (reference, RE)

Static reading of `tlc_server16a.exe`. O = observed, I = inferred, U = unverified.

**Helpers.** `0x419974` string `=` (`repe cmpsb` over min length, then length compare: byte-exact,
case-sensitive) O; `0x418ed4` `MID$` I; `0x4196de` `VAL` then `fistp` (lenient: leading blanks skipped, junk
gives 0) I; `0x4153d1` OPEN I; `0x414bf8` LINE INPUT O.

**Loop.** Init sub `0x4012bf`, loop `0x4024f1`..`0x402a05`: `OPEN "server.ini"` (relative to the CWD),
`WHILE NOT EOF: LINE INPUT L$`, then every test below runs in order with no `ELSE`, so a later duplicate
overwrites (last wins) O.

| Test on `L$` | Action | Addr |
| --- | --- | --- |
| `LEFT$(,5)="PATH="` | PATH = rest of line, verbatim | `0x40255f` |
| `"PORT="` | PORT = VAL(rest) | `0x4025c8` |
| `"SITE="` | SITE = rest, verbatim | `0x402632` |
| `"DELAY="` | DELAY = VAL | `0x40269b` |
| `"DELAYAFTERMOVE="` | VAL | `0x402705` |
| `"DELAYAFTERGAME="` | VAL | `0x40276f` |
| `"MAILSERVER="`, `"RETURNADD="` | rest | `0x4027d9`, `0x402842` |
| `"ICSMODE=1"` | ICSMODE = 1 (prefix literal: `ICSMODE=10` also sets it, nothing sets 0) | `0x4028ab` |
| `"SAVEDEBUG=1"` | SAVEDEBUG = 1 (same quirk) | `0x4028e4` |
| `"MENU "` | see below | `0x40291d` |

**Defaults** (O, `0x4012d5`..`0x4024e7`): PORT 16000, PATH "", SITE "Tom's live chess viewer", DELAY 100,
DELAYAFTERMOVE 300, DELAYAFTERGAME 1000, ICSMODE 0, SAVEDEBUG 0, MENU(1..10) "".

**Matching consequences** (O): keys are exact column-0 prefixes: `port=`, ` PORT=`, `PORT =` never match. No
trimming of key or value. There is no comment syntax: `'` lines, blank lines and unknown keys are all silently
unmatched.

**MENU** (`0x402932`..`0x402a00`, O): `p = INSTR(1,L,"ID=")` (ignore if `p<=1`); `q = INSTR(p,L," ")` (ignore if
none, so a space must follow the id); `id = VAL(MID$(L,p+3,q-p-2))` (ignore unless 1..10);
`MENU(id) = L` (whole line, verbatim, last duplicate wins). At logon (`0x40913e`..`0x4091b2`) the non-empty
entries are sent numbered, in ascending id order.

**After the loop** (`0x402a0a`..`0x402b1e`, O): `server.log` gets `Path=`, `Port=`, `Site=`, `Delay=`,
`Delay after move=`, `Delay after game=`. UDP OPEN is called with PORT and DELAY (`0x402d87`..`0x402d99`).
`ICSMODE=1` prints "ICS Mode" (`0x402dd8`).

**TOURNEYPGN** (`0x40e50e` RESULTTABLE handler; same at `0x410610`, `0x411043`, O): not read at startup. On
every request `server.ini` is reopened and scanned for `TOURNEYPGN=`, and the **first** match wins (`jmp
0x40e5d3`). Empty gives `CT:Sorry, this server is not configured to send the results table.` Edits therefore
apply live.

**Line ends / file** (O): CR ends a line and one following LF is swallowed; a bare LF is not a terminator;
Ctrl-Z (`0x1A`) ends input; the last line need not be terminated (I). A missing `server.ini` has no error trap
(U: defaults).

**Paths** (I): opened as given, relative to the CWD (in practice the ini's directory).

**Rebuild behaviour** (deviations from the above):
- D1: CR, CRLF and bare LF all end a line (Linux-written inis).
- D2: unmatched, unknown-key and invalid-MENU lines are ignored but logged as warnings; `'` and blank lines
  stay silent.
- D3: numbers are strict: trimmed digits, in range (PORT 1..65535), else startup fails naming the line, key and
  value. The reference's `VAL` would accept `PORT=16000x` and turn `PORT=abc` into 0.
- D4: `MENU ... ID=n` needs no trailing space after `n`.
- D5: missing keys use uci-to-tlcs defaults: PORT 16066, SITE `uci-to-tlcs`, DELAYAFTERMOVE 0, DELAYAFTERGAME 0
  (DELAY stays 100).
- D6: TOURNEYPGN is read once at startup and the last duplicate wins.
- D7: `SAVEDEBUG=0` turns the flag off, last wins.
- D8: CLI flags override the ini; relative ini paths resolve against the ini's directory; `--ini` naming a
  missing file is a hard error.
- D9: FORMAT, BIND, STATEFILE, CLIENTTIMEOUT, ADMINPASS and MAXCLIENTS are extensions.
- D10: ICSMODE, MAILSERVER and RETURNADD are parsed and warned about, then ignored.

## 9. Improvements over the Reference

Each item is compatible with both clients unless stated.

### 9.1 Recoverable sessions

- **Problem:** `PING` is answered without a login check, so a client the server has forgotten (restart, kick,
  same-IP `LOGOFF`) keeps getting `PONG` and nothing else. The "no longer connected" notice is only sent in reply
  to `CHAT`.
- **Rebuild:** answer `PING` from an unknown client with plain `MSG: You are no longer connected to the server.
  Please re-connect.` instead of `PONG`. node-tlcv re-logs in on that notice; the desktop client shows it.

### 9.2 Ids and persistence

- Per-client, strictly increasing ids, never reset on re-LOGON.
- Persist the id high-water mark and finished-games store across restarts. After a restart, start above the last
  persisted id so existing clients don't mistake new messages for duplicates.
- **Rebuild (shipped):** ids are not persisted. Each process restarts per-client ids at 1 (node-tlcv accepts that via
  `isIdRestart`; the desktop client is safe once it has seen more than 100 ids). Results come from `TOURNEYPGN`, and
  `STATEFILE` persists the connected clients plus their resume game.

### 9.3 Per-client ordered delivery and flow control (replaces overload fallback)

- **Each client MUST receive its numbered messages in id order.** A message is not sent until every earlier
  message to that client is ACKed or superseded (stop-and-wait, or a window that never lets a resend land behind
  a newer id).
  - The reference violates this: many messages are in flight under one counter, so a resend arrives behind newer
    ids and node-tlcv discards it as out of order (after ACKing it).
  - uci-to-tlcs's stop-and-wait sender already satisfies it, but with one global queue (next point).
- One slow client MUST NOT stall delivery to the others. Queues and in-flight state are per client.
- No global "send everything raw" switch.
- Per-client queue cap. When a client is behind, coalesce: replace any queued `FEN`/`xMOVE`/`FMR` for that
  client with a fresh snapshot (players + current `FEN` + last move) rather than dropping state.
- PVs and clocks are never queued for retransmit; only the latest per color is sent.

### 9.4 Retransmit policy

- Exponential backoff (e.g. 0.5 s, 1 s, 2 s, 4 s, 8 s), uniform for all message types.
- On give-up: discard that client's pending game-state messages and send a resync snapshot under new, higher
  ids. Never skip ahead and leave the client missing a move. Remove the client only if it is also past
  `CLIENT_TIMEOUT`.
- No 100-character truncation; no `CHAT` special case.

### 9.5 Format fixes

- `SITE: <text>` with a space. The desktop client reads from character 6 and drops the first letter otherwise.
- Clamp names to a documented maximum and strip `:` `<` `>` and control characters.

### 9.6 Results and game list

- Maintain a results store from `result` events (game number, white, black, result, PGN), persisted.
- Answer `RESULTTABLE` from it (falling back to `TOURNEYPGN`), in the crosstable format node-tlcv's
  `result-parser.ts` reads. Pace the dump, or send it numbered, so lines aren't lost.

### 9.7 PV ordering

- Flush the moving side's pending PV before emitting `FEN`/`xMOVE`, so the final PV precedes the move.
- Drop `DELAYAFTERMOVE` (default 0); it only existed to throttle the 2006 loop.

### 9.8 Admin and abuse

- `SECURITY`, `BOOT:`, `SRBOOT:` require an admin secret (e.g. `ADMIN:<secret>` first) or are disabled.
- Per-IP rate limit and max clients; optional ban list (the reference has an IP ban table at `0x41be68`).
- RE findings (`dis3.txt`): the reference has **no auth**. Dispatcher: `SECURITY` exact (`0x412f99`), `BOOT:` 5-char prefix (`0x413051`), `SRBOOT:` 7-char prefix (`0x413151`). BOOT matches `Trim(Mid(msg,6))` against the client's IP text (first slot only), sends plain `MSG: You have been booted!` (`0x413114`), then runs DelUser (`0x409488`). No match is silent. SRBOOT also appends the IP to a ring of 100 (`[0x41be68]` counter, wraps to 1). The ban check (`0x4084b6..0x40850c`) runs before the numbered/ACK handling (`0x408533`): banned datagrams are dropped un-ACKed.
- Rebuild: `ADMIN:<secret>` (direct datagram only), per-`ip:port` grant and lockout; see `docs/tlcs-wire.md`.

### 9.9 Operations

- Prometheus metrics: clients, queue depth, retransmits, give-ups, resyncs, messages by type.
- Structured logs instead of `server.log`.
- Optionally several broadcasts (one per port) in one process.

## 10. Plan: Evolving uci-to-tlcs

Where uci-to-tlcs stands against this spec (as of `8dc7903`).

### 10.1 Already aligned

- Source adapter → game state → server pipeline, with the server's own board.
- `FEN` → `xMOVE` → `FMR`, numbered; PVs and clocks unnumbered; 3-field FEN; centiseconds; engine-POV scores.
- Plain `LOGON SUCCESSFUL` followed by a numbered snapshot; truncation restarts the tail.
- **Better than the reference:** clients keyed by `ip:port`; strictly in-order numbered delivery (§9.3);
  `SITE: ` with a space (§9.5); both clocks on every `go`.
- **Shipped since:** the full session protocol (names, chat, `CHANGE`, `MENU`, `FEATURE: PING`, 70 s reaper), admin / ban /
  `MAXCLIENTS` / rate limit, structured logs and Prometheus metrics, the PGN-backed `RESULTTABLE`/`GAMELIST`, and restart
  recovery with persisted clients, silent catch-up and numbered replay.
- **Extension:** `WINFO`/`BINFO` extended search info (seldepth, wdl, nps, hashfull, tbhits) beside `WPV`/`BPV`
  (`docs/tlcs-wire.md`).

### 10.2 Gaps

| Spec item | uci-to-tlcs today | Status |
| --- | --- | --- |
| §4.1 addressing | Replies to the source `ip:port`; no `clientIP:PORT` mode | Out of scope |
| §4.2 framing | Sends `<N>` without the space; accepts both on input (deliberate deviation) | Done (#14) |
| §4.3 numbered client messages | Strips `< id>`, ACKs every copy, dedupes per source | Done (#14) |
| §4.4 numbering | Per-client stop-and-wait queues, adaptive RTO, 30 s give-up with replay resync (fixes gap **J**). Deviations: give-up 30 s not 10 s; ambiguous-ACK RTO bump capped at 2x | Done (#14) |
| §5.1 commands | `LOGONv15`, `LOGON:` refusal, `LOGOFF`, `CHANGE:`, `PING`, `CHAT` + `<who>`… queries, `VOTE`, `EMAIL`/`SEND`, `RESULTTABLE`, `GAMELIST`, `ACK`; admin `ADMIN`/`SECURITY`/`BOOT`/`SRBOOT` | Done (session #15, admin #16) |
| §5.2 logon | Reference order: `LOGON SUCCESSFUL`, `FEATURE: PING`, replay of the current game, full user list, `MENU` | Done (#15) |
| §5.3 keepalive | 70 s idle reap (`CLIENTTIMEOUT`); `FEATURE: PING` keeps the desktop client alive | Done (#15) |
| §6 `MENU`, `level` | `MENU` from the ini, `level` from the time-control metadata | Done (`MENU` #15, `level` #10) |
| §6 formats | `CHAT: [<user>] - <text>`, `CT:<line>`; `result: <r>` (no reason text; `protocol.ts`) | Done, with the `result` deviation |
| §7.1 restart | `STATEFILE` resume: silent, synchronous catch-up, then live; numbered replay per client | Done (#19) |
| §7.2 adapters | fastchess and raw UCI only | WinBoard/xboard adapter: out of scope |
| §9.1 | Unknown `PING` gets the `MSG` notice instead of `PONG` | Done (#15) |
| §9.6 | `RESULTTABLE`/`GAMELIST` rendered from the `TOURNEYPGN` registry | Done (#18) |
| §9.8 admin and abuse | `ADMINPASS`, ban list, `MAXCLIENTS`, per-IP rate limit | Done (#16) |
| §9.9 operations | Prometheus `/metrics` (`METRICSPORT`), JSON logs (`LOGFORMAT`) | Done (#17) |

### 10.3 Remaining

All of the above is shipped except the WinBoard adapter and the strict addressing mode; see `docs/gaps.md` for
the limitations and the node-tlcv follow-ups.

## 11. Open Questions

- Exact spacing inside reference `xTIME` lines, and how `FMR` is derived.
- What reference `ICSMODE` changes.
- Logon burst item 8 (global `0x41b490`).
- Exact `CHAT:` relay text offset (whether a leading space is kept).
- Whether to make §9.1 opt-in for strict compatibility testing.

## 12. Acceptance Tests

1. **Golden replay:** covered by the unit tests (`test/`), which replay recorded fastchess/raw logs through the pipeline.
2. **Desktop client:** TLCV 2.1c under Wine connects, shows players, board, clocks, PVs, chat, user list,
   menus, results table; keepalive stays green for 10 minutes. **Not run**; only emulated by `mock-client --mode desktop`.
3. **node-tlcv:** connects in classic and ephemeral modes; survives server restart (re-logon via §9.1); survives
   20 % injected packet loss with no lost moves (via resync). **Done:** the acceptance run of 2026-10-19
   (`docs/e2e-testing.md`, "Acceptance run").
4. **Loss and reorder:** with a lossy proxy, every client converges on the current FEN within one retransmit
   cycle. **Done** with the lossy mock (20 % drop, 5 % reorder) in the same run.
5. **Compatibility switches:** with improvements disabled, output matches the reference formats in §6.
   **Not implemented.**

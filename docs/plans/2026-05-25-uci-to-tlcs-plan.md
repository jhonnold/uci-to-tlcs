---
ingested: 2026-06-04
source_type: plan
author: claude_code (drafted), Jay Honnold (direction + approval)
synthesis: done
---

# uci-to-tlcs — Plan (v1 — initial design)

**Project:** uci-to-tlcs — a TLCS-compatible UDP broadcast server that
reconstructs a chess game from a raw UCI engine transcript and streams it so
node-tlcv (a TLCS client) can watch it live. The inverse of node-tlcv.
**Source:** approved plan, 2026-05-25. Implemented and pushed the same day.

## Context

There is **no TLCS spec available**. The wire contract is defined empirically by
what node-tlcv *accepts*, reverse-engineered from its source:

- `src/game-service.ts` — the command parser → the encoder spec, read backwards.
- `src/transport/udp-transport.ts` — ID-wrapping / ACK / ordering rules.
- `src/broadcast.ts` — what the client sends (LOGON/PING/RESULTTABLE/CHAT/LOGOFF).
- `src/kibitzer/uci-parser.ts` — UCI `info` parsing + score normalization, reused.

Goal: "aligns with node-tlcv", not a byte-for-byte TLCS clone.

## Confirmed decisions

- **Input:** raw UCI transcript (no fastchess/cutechess tags). Side-to-move is
  inferred from the board, not from any per-line engine tag.
- **Driving:** live-tail in real time — emit TLCS messages as lines are appended.
- **Stack:** TypeScript / Node (ESM), reusing `chess.js`. UDP via `node:dgram`.
  Tests via built-in `node:test`. Verified against the UCI spec (DOBRO gist
  `2592c6dad754ba67e6dcaec8c90165bf`).
- **Scope:** single broadcast on one UDP port.

### Non-goals (v1)

- Full crosstable/results emulation (RESULTTABLE answered minimally).
- Full move-history replay to mid-game joiners (they get the current FEN only).
- Resign/adjudication results (only board-derived game-over: mate/stalemate/draw —
  pure UCI carries no resign signal).
- Multiple concurrent games/ports.

## Architecture

One-directional pipeline mirroring node-tlcv's own shape:

```
UCI transcript ──tail──▶ UciParser ──events──▶ GameState (chess.js)
                                                   │ emits TLCS messages
                                                   ▼
                                              TlcsServer (dgram)
                                              ├─ ReliableSender (ID-wrap + ACK)
                                              └─ client registry / handshake
                                                   ▼ UDP to clientIP:<port>
                                                 node-tlcv
```

Key modules: `src/uci/{parser,info}.ts`, `src/game/game-state.ts`,
`src/tlcs/{protocol,reliable-sender,server}.ts`, `src/tail.ts`, `src/pipeline.ts`
(parser→game→sink, socket-free so it's unit-testable), `src/main.ts`,
`scripts/mock-client.ts`.

## UCI → TLCS encoding map (the crux — units are the trap)

| TLCS out | Wire format | Conversion from UCI |
|---|---|---|
| `SITE` / `WPLAYER` / `BPLAYER` | `SITE: <text>`, `WPLAYER: <name>` | from CLI `--site/--white/--black`; both players ⇒ node-tlcv "game started" |
| `FEN` | `FEN: <board> <stm> <castling>` | **truncated** — first 3 FEN fields only; node-tlcv supplies ep/clock/move# |
| `FMR` | `FMR: <halfmoveClock>` | chess.js FEN field 5 |
| `WMOVE`/`BMOVE` | `WMOVE: <fullMoveNo>. <SAN>` | SAN is one token; black uses `n...` (node-tlcv reads only the integer) |
| `WTIME`/`BTIME` | `WTIME: <cs> otim <cs>` | UCI clocks are **ms → ÷10 = centiseconds**; node-tlcv ×10 back |
| `WPV`/`BPV` | `WPV: <depth> <scoreCp> <timeCs> <nodes> <SAN pv…>` | **score normalized to White POV**; time ms÷10; PV coords→SAN; **only `multipv 1`** |
| `result:` | `result: 1-0\|0-1\|1/2-1/2` | board-derived game-over; lowercase command |
| `PONG` / `LOGON SUCCESSFUL` | bare | replies to `PING` / `LOGONv15` |

**Score POV:** UCI `score cp` is side-to-move-relative → `scoreWhite = turn==='w' ? cp : -cp`.
`score mate y` is mate in *y moves* (not plies), negative when being mated → map to
a large signed cp (`sign(y)·(100000-|y|)`), then White-normalize. `lowerbound`/
`upperbound` parse fine (value still follows `cp`).

**PV coords → SAN:** invert node-tlcv's `playoutPV` — load current position into a
throwaway `Chess`, apply each coord with `{ strict: false }`, collect `.san`, stop at
first failure.

**Per-move order:** on `go` → `WTIME`/`BTIME`; on each `info` → `WPV`/`BPV`; on
`bestmove` → `FEN`, then `WMOVE`/`BMOVE`, then `FMR`. node-tlcv discards PV for the
non-thinking color, so only the moving side's PV is emitted.

## Reliability & ordering

node-tlcv ACKs `<NNN>MSG` with `ACK: NNN` and **drops any id `< lastMessage`**. So
reliable messages must ship with strictly increasing ids, in order. Design: a
**stop-and-wait reliable queue** with a single global monotonic counter.

- **Reliable (ID-wrapped):** FEN, WMOVE/BMOVE, FMR, WPLAYER/BPLAYER, SITE, result.
- **Unwrapped (fire-and-forget):** WPV/BPV, WTIME/BTIME, PONG, LOGON SUCCESSFUL, CT.
- Next id never assigned until current message is ACKed by all targets; resend ~750 ms,
  ≤4 tries, then advance so a dropped client can't stall.
- Reliable traffic ~3 msgs/move — throughput cost irrelevant. PV/clock floods use
  the unwrapped channel.

## Client lifecycle & the local-bind gotcha

The server binds `node:dgram` to the broadcast port and **always streams to
`clientIP:<broadcastPort>`** — TLCS ignores the client's source port (see
tlcv-udp-broadcast-protocol). On `LOGONv15:<user>` it registers the client IP,
replies `LOGON SUCCESSFUL`, and **unicasts a snapshot** (SITE, players, current FEN,
FMR, clocks, latest WPV/BPV) so late joiners catch up; existing viewers aren't re-sent
(avoids re-firing "game started"). Handles PING→PONG, ACK, RESULTTABLE (minimal
`CTRESET`+`CT:`), CHAT relay, LOGOFF→DELUSER.

**The gotcha:** a TLCS client binds the *same* UDP port it sends to, so the server and
a client cannot share a port on one host (`EADDRINUSE`). Two ways around it for testing:
loopback aliases (server `--bind 127.0.0.1`, client `--bind 127.0.0.2`, same port —
distinct addresses are OK on Linux), or two containers (real node-tlcv binds wildcard
`0.0.0.0`, so it needs its own IP — mirrors production).

## Verification

1. **Unit tests** (`node:test`): parser, `parseInfoLine`, score/PV/FEN/move conversions,
   and a full `fixtures/sample-game.uci` run asserting ordered emissions.
2. **Mock client** (`scripts/mock-client.ts`): emulates node-tlcv (LOGON/PING/ACK,
   pretty-prints decoded messages) over loopback aliases.
3. **Faithful e2e** (`docker-compose.test.yml`): real node-tlcv in a second container
   pointed at `uci-to-tlcs:16066`; confirm players/board/evals/clocks render and no
   `Unable to process <cmd>!` warnings appear.

## Outcome

Built and pushed the same day — commit `6738322` on `main` of
`jhonnold/uci-to-tlcs` (gitea remote). 17/17 unit tests pass; the live UDP path
was verified against the mock client (snapshot on connect + live move stream, strictly
increasing ids, all ACKed, no out-of-order warnings). The two-container e2e against real
node-tlcv was wired but not executed.

## Open questions / future enhancements

- Mid-game full history replay to late joiners (per-client backlog stream).
- Real crosstable synthesis for the results tab.
- Resign/adjudication via a transcript sentinel line or CLI override.
- Multiple games/ports (generalize the single-broadcast server).
- Upstream doc nit: node-tlcv `CLAUDE.md:52` annotates `XTIME: <ms>` but the code treats
  the wire value as centiseconds (`×10`).

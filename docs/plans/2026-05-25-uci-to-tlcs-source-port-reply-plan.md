---
ingested: 2026-05-25
source_type: plan
synthesis: done
---

# Plan: Reply to the client's source port (support ephemeral-port clients)

Approved plan, implemented and merged the same session (2026-05-25). Adds a
deliberate, backward-compatible divergence from strict TLCS to the
[[uci-to-tlcs]] server.

## Context / problem

The [[uci-to-tlcs]] server originally sent every outbound datagram to
`clientIP:<broadcastPort>` and discarded the datagram's source port — mirroring
classic TLCS (see [[tlcv-udp-broadcast-protocol]]). That blocks any client that
binds an **ephemeral** port: the server replies to the broadcast port, which the
ephemeral client isn't listening on, so it receives nothing. This was the
dead-end of the earlier `UDP_EPHEMERAL_BIND` experiment on the *client*
([[node-tlcv]]) side — it failed because the *server* ignored the source port.

**Goal:** make the server reply to the datagram's actual source `ip:port`. If a
LOGON arrives from `40000` to broadcast port `16010`, reply to `40000`.

## Why it's backward compatible (verified)

Real TLCS clients send LOGON *from* the broadcast port, so source port ==
broadcast port and replying to the source port is identical for them. Confirmed
in `../node-tlcv`:

- `src/transport/udp-transport.ts:30` — `this.socket.bind(port)` binds the
  broadcast port; the socket therefore sends from it (source port = broadcast
  port).
- `src/broadcast.ts:13,43` — node-tlcv PINGs every `PING_INTERVAL_MS = 10000`
  (10s); a reliable liveness signal the reaper keys on.
- `src/broadcast.ts:42` — node-tlcv sends `LOGONv15` once at boot and **never
  re-LOGONs**.

So only ephemeral/non-compliant clients (which received nothing before) change
behavior. Payoff: ephemeral clients work, and multiple clients can share one
host on different ephemeral ports.

## Key design decisions

- **Reply destination = source `ip:port`** of the received datagram
  (`rinfo.port`), for every channel (reliable, unwrapped, direct replies).
- **Registry keyed by `ip:port`** ("dest" token). `udp4` ⇒ IPv4 addresses, so
  `lastIndexOf(':')` splits a dest back into ip + port. Keying by ip:port (vs
  IP-only) is what lets two ephemeral clients on one host be distinct and makes
  ACK matching exact. (Chosen over the minimal "one client per IP" option.)
- **No new CLI flag / always on** — identical for compliant clients, so safe as
  the default. An optional `clientTimeoutMs` (+ `reapIntervalMs`) was added to
  `ServerOptions` only so tests can use a short reaper timeout; `main.ts` keeps
  the defaults.
- **Idle reaper, NOT failure-reaper.** Reap on sustained silence (no datagram
  for `clientTimeoutMs`, default 30s ≈ three missed 10s PINGs) — *not* on a
  single reliable-ACK timeout. Rationale: node-tlcv LOGONs once and never
  re-registers, so falsely dropping a live-but-lossy client would be
  **unrecoverable**. A live client PINGs every 10s and is never reaped.
- **Accepted trade-off:** a client that dies mid-game can cause up to ~30s of
  intermittent reliable-channel delay (the stop-and-wait queue waits on its
  missing ACKs) before the reaper removes it. Bounded and self-healing, and it
  never drops a live client.

## Implementation (files)

- **`src/tlcs/server.ts`** (core): registry re-keyed by an `ip:port` `destKey`;
  `ClientInfo` gains `port` + `lastSeen`. Split the transport seam into
  `rawSend(payload, ip, port)` (low-level, now targets the source port) and
  `rawSendTo(payload, dest)` (splits a token). `onMessage` reads `rinfo.port`,
  bumps `lastSeen`, threads dest/port through every handler. Added the
  PING-driven `reapStale()` timer (drops silent clients, emits `DELUSER`), plus
  `address()` and `start(onReady?)` for testability.
- **`src/tlcs/reliable-sender.ts`**: cosmetic rename `ip`→`dest` (it was already
  multi-target and matched ACKs by opaque token — no behavior change).
- **`scripts/mock-client.ts`**: new `--ephemeral` flag binds an OS-assigned port
  (no loopback alias needed) and still receives.
- **Docs**: `CLAUDE.md` and `README.md` updated; the long-standing "server
  deliberately ignores source port" gotcha is now reversed.

## Testing / verification

- New `test/server.test.ts` drives real loopback `node:dgram` sockets (the only
  way to assert wire addressing) and proves three things: (1) an ephemeral
  client receives the reply, (2) two clients on one host both get moves,
  (3) a silent client is reaped (live client receives `DELUSER`).
- Results: `npm run typecheck` clean; `npm test` **20/20 pass** (17 existing + 3
  new); `npm run build` exit 0.
- The two-container e2e is unaffected (real node-tlcv binds the broadcast port).

## Out of scope

- A failure-reaper (drop a client after one reliable ACK timeout) — intentionally
  excluded; unsafe given node-tlcv never re-LOGONs.

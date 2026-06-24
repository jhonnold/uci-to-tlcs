---
ingested: 2026-06-04
source_type: plan
synthesis: done
---

# uci-to-tlcs ↔ node-tlcv single-host e2e with no Docker (real fastchess game) + retire Docker scaffolding

Approved plan from 2026-05-25 (executed same day). A two-phase runbook: (1) drive a **real engine game** through [[uci-to-tlcs]] into real [[node-tlcv]] on a single host using node-tlcv's new ephemeral mode (no Docker); (2) if it passes, retire the now-redundant Docker e2e scaffolding.

## Context / why

Until now a faithful e2e against real node-tlcv needed **two Docker containers** (`docker-compose.test.yml`) to dodge a same-host UDP clash: strict TLCS requires the client to *bind the broadcast port*, but the bridge also binds it, so both can't run on one loopback host (`EADDRINUSE`). node-tlcv now supports an opt-in **ephemeral** connection mode (`{ "connection": "127.0.0.1:16066", "ephemeral": true }`, `src/transport/udp-transport.ts:27-39`, `src/config/config-store.ts:6-12`): it `socket.bind()`s an OS-assigned local port instead of the broadcast port and relies on the bridge's source-port reply (uci-to-tlcs commit `687586c`). With that, both processes coexist on `127.0.0.1` and Docker is unnecessary. See [[tlcv-udp-broadcast-protocol]], [[2026-05-25-node-tlcv-ephemeral-local-port]], [[2026-05-25-uci-to-tlcs-source-port-reply-plan]].

## Prerequisites (verified on host)

- fastchess 1.8.0 on PATH (`/usr/local/bin/fastchess`).
- Engines (Linux ELF): Stockfish `~/.openelo/engines/sf_dev-20260307-b3a810a1`, Berserk `~/.openelo/engines/berserk_20250622`.
- node-tlcv at `~/projects/node-tlcv` (`npm run dev-server`, `.env` gives `PORT`=8080 + `TLCV_PASSWORD`; web UI needs no auth). uci-to-tlcs at `~/projects/uci-to-tlcs`.

## Phase 1 — runbook (broadcast port 16066 throughout)

1. **Repoint node-tlcv** (back up first; its `config/config.json` may carry a local edit — restore *that* exact state, not HEAD):
   `{ "connections": [ { "connection": "127.0.0.1:16066", "ephemeral": true } ] }`.
2. **Bridge first** (must listen before node-tlcv boots — LOGON race): fresh empty transcript `: > /tmp/live.uci`, then
   `LOG_LEVEL=debug npm start -- --log /tmp/live.uci --port 16066 --bind 127.0.0.1 --white Stockfish --black Berserk`.
   Wait for `TLCS server listening on 127.0.0.1:16066`.
3. **node-tlcv second**: `npm run dev-server`. Confirm `Listening @ 0.0.0.0:<ephemeral≠16066>` and the bridge logging `LOGON tlcv.net@127.0.0.1:<ephemeral>`.
4. **Real game + live feed** — strip fastchess's tagged log to raw UCI:
   - `tail -F /tmp/fc.log | sed -u -E 's/.*(<--- |---> )//' >> /tmp/live.uci`
   - `fastchess -engine cmd=<sf> name=Stockfish -engine cmd=<berserk> name=Berserk -each tc=10+0.1 -rounds 1 -games 1 -pgnout file=/tmp/fc/out.pgn -log file=/tmp/fc.log level=trace engine=true realtime=true`
   - Real `tc=` (not `st=`/`movetime`) ⇒ ticking clocks; no fastchess adjudication ⇒ board-terminal `result:` (pure UCI has no resign signal).

**Verification**: browser `http://127.0.0.1:8080/16066` (board/clocks/PV), `curl …/16066/pgn` (SAN incl. `O-O`), `curl …/broadcasts` → `[16066]`, zero "Unable to process"/out-of-order warnings, board-terminal `result:`.

## Phase 2 — retire redundant Docker e2e (only if Phase 1 passes)

Delete `docker-compose.test.yml`, `Dockerfile`, `e2e/config.json` (all Docker-test-only — the Dockerfile CMD targeted the fixture with `--site DockerTest`). Rewrite the "Faithful e2e" sections of `README.md` and `CLAUDE.md` to the single-host ephemeral flow. Commit on `chore/retire-docker-e2e` after `npm test` + `npm run typecheck` green.

## Cleanup

Stop processes; restore node-tlcv `config/config.json` from backup (its pre-existing local state); remove `/tmp` scratch. Both repos pristine.

## Outcome (2026-05-25, executed)

- **Phase 1 passed.** node-tlcv bound ephemeral `0.0.0.0:41163` (≠16066); bridge logged `LOGON tlcv.net@127.0.0.1:41163`. A **76-move Stockfish-vs-Berserk** game streamed end-to-end with correct SAN incl. `O-O`; ended by 3-fold repetition → `result: 1/2-1/2` (board-terminal, not adjudication); **zero** "Unable to process"/out-of-order warnings; `/16066/pgn` + `/broadcasts` correct. Closes the long-standing gap that uci-to-tlcs had never been driven by a real engine match. (The "No one viewing broadcast, skipping low-priority" INFO lines are normal with no browser socket — only WPV/BPV eval is skipped; moves still process.)
- **Phase 2 done.** `docker-compose.test.yml`, `Dockerfile`, `e2e/config.json` deleted; README/CLAUDE rewritten; `npm test` 20/20, typecheck clean; committed `508f2af` on `chore/retire-docker-e2e`, fast-forwarded into `main`, pushed to [[gitea]], branch deleted. The Docker two-container e2e path no longer exists.

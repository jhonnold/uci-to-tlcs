# Testing the live path

What to reach for: exercising the bridge against a real or mock client before a
protocol/transport change ships.

- **Local**: `scripts/mock-client.ts --ephemeral` binds an OS-assigned port and still
  receives (we reply to the source port), so no loopback alias is needed. To exercise
  the strict same-port client instead, drop `--ephemeral` and use an alias (server
  `--bind 127.0.0.1`, client `--bind 127.0.0.2`, same port).
- **Faithful e2e, single host (no Docker)**: real node-tlcv now supports an *ephemeral*
  connection mode, so it coexists with the bridge on one host. Point its
  `config/config.json` at the bridge —
  `{ "connections": [ { "connection": "127.0.0.1:16066", "ephemeral": true } ] }` — so it
  binds an OS port instead of the broadcast port (no same-host `EADDRINUSE`) and relies on
  our source-port reply. Start the bridge first (`--bind 127.0.0.1 --port 16066
  --format fastchess`), then `npm run dev-server` in `../node-tlcv`, then drive real
  game(s) with fastchess — the bridge tails the engine log **directly** (no `sed`):
  `fastchess -engine cmd=<sf> -engine cmd=<berserk> -each tc=10+0.1 -rounds 4 -games 2 -repeat -concurrency 1 -log file=/tmp/fc.log engine=true realtime=true`
  with `--log /tmp/fc.log --format fastchess`. Watch at `http://127.0.0.1:8080/16066`
  (or `curl …/16066/pgn`). Use a real `tc=` (not `st=`/`movetime`) for ticking clocks,
  `-concurrency 1` so games don't interleave, and no adjudication so games end on the
  board. (`--format raw` + `tail -F … | sed -u -E 's/.*(<--- |---> )//' >> /tmp/live.uci`
  is the old pre-stripped path.) README has the full runbook.
- **LOGON-race**: node-tlcv sends `LOGONv15` once at boot and never retries. Bring the
  bridge up **before** node-tlcv, or it sits connected-but-unregistered (PINGs PONGed,
  0 moves).

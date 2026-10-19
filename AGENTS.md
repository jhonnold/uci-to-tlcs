# AGENTS.md

`uci-to-tlcs` reconstructs chess games from a **UCI engine log** (one log may hold
many games/matchups) and broadcasts them over UDP in a **TLCS-compatible** protocol,
so node-tlcv (and the desktop TLCV) can watch live. It is the inverse of node-tlcv: a
minimal TLCS *server*. See `README.md` for the full CLI, the UCI→TLCS encoding table,
the data flow, and scope.

## Commands

```bash
npm test          # unit tests (test/*.test.ts: parser, encoder, pipeline, server, restart, results, admin, mock client...) via node:test
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
npm start -- --log <path> [opts]   # run from source via tsx
npm run dev       # tsx watch
npm run mock-client -- --server 127.0.0.1 --port <p> [--mode desktop] ...   # node-tlcv / desktop TLCV stand-in
npm run e2e-check -- --fastchess games.pgn [--pgns dir] [--transcript f.jsonl]   # compare node-tlcv PGNs / mock transcripts
npx tsx scripts/standings-check.ts --fastchess-out fc.stdout --pgn games.pgn ...   # crosstable / game list vs fastchess
```

## Where to look

Details live in `docs/`, loaded only when relevant:

- **`docs/architecture.md`** — the pipeline shape, the seam between `source/` adapters ·
  `pipeline.ts`/`game-state.ts` · `tlcs/` (server, commands, admin, reliable sender) and the
  startup/restart orchestration in `app.ts` (`results/`, `state/`), plus the ESM/NodeNext `.js`
  import convention. Reach for it when touching the pipeline, adding a log producer, or fixing an
  import-extension build break.
- **`docs/tlcs-wire.md`** — the reverse-engineered wire protocol: two send channels,
  source-`ip:port` replies, session/admin commands, RESULTTABLE/GAMELIST, restart numbering,
  FEN/time/score/PV encoding invariants, the node-tlcv new-game emit-order contract and the
  deliberate deviations from the reference. Reach for it before changing any wire format.
- **`docs/pipeline.md`** — move emission (two deduped paths), PGN-authoritative results
  (board/`*` fallback), multi-game segmentation + name→colour binding, and restart catch-up.
  Reach for it when a move, result, or game boundary is wrong.
- **`docs/e2e-testing.md`** — the full fastchess → uci-to-tlcs → node-tlcv e2e runbook
  (configure, run, wait, check logs & PGNs), the mock-client local path, the LOGON-race, and
  the restart/churn acceptance scenario with its pass/fail gates. Reach for it before shipping a
  protocol/transport change, or to verify a move/result/name/clock bug end-to-end.
- **`docs/gaps.md`** — status of every known gap vs. the node-tlcv/desktop contract, the known
  limitations and the node-tlcv follow-ups. Reach for it before claiming parity or picking next work.
- **`docs/tlcs-server-spec.md`** — rebuild spec reverse-engineered from the original
  TLCS 1.6a server binary: transport, numbering/retransmit, logon burst, every command,
  WinBoard log tailing, `server.ini`, improvements, and the shipped-status table (§10).
  Reach for it when matching real-server behavior.
- **`README.md`** — quick start, full CLI options, `server.ini` keys, the UCI→TLCS encoding table,
  restart persistence and scope. `server.ini.example` is the annotated starting config.
- **`../node-tlcv/src/`** — the wire contract's source of truth (`game-service.ts`,
  `kibitzer/uci-parser.ts`, `udp-transport.ts`); there is no official spec, but
  `docs/tlcs-server-spec.md` documents what the original server does.
- `docs/plans/` is historical design notes, superseded by the docs above.

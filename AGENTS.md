# AGENTS.md

`uci-to-tlcs` reconstructs chess games from a **UCI engine log** (one log may hold
many games/matchups) and broadcasts them over UDP in a **TLCS-compatible** protocol,
so node-tlcv (and the desktop TLCV) can watch live. It is the inverse of node-tlcv: a
minimal TLCS *server*. See `README.md` for the full CLI, the UCI→TLCS encoding table,
the data flow, and scope.

## Commands

```bash
npm test          # unit tests (parser, encoder, pipeline) via node:test
npm run typecheck # tsc --noEmit
npm run build     # tsc → dist/
npm start -- --log <path> --pgn <path> [opts]   # run from source via tsx
npm run dev       # tsx watch
```

## Where to look

Details live in `docs/`, loaded only when relevant:

- **`docs/architecture.md`** — the pipeline shape, the three-concern split
  (`source/` adapters · `pipeline.ts`/`game-state.ts` · `tlcs/server.ts`), and the
  ESM/NodeNext `.js` import convention. Reach for it when touching the pipeline,
  adding a log producer, or fixing an import-extension build break.
- **`docs/tlcs-wire.md`** — the reverse-engineered wire protocol: two send channels,
  source-`ip:port` replies, FEN/time/score/PV encoding invariants, and the node-tlcv
  new-game emit-order contract. Reach for it before changing any wire format.
- **`docs/pipeline.md`** — move emission (two deduped paths), board-derived results,
  and multi-game segmentation + name→colour binding. Reach for it when a move, result,
  or game boundary is wrong.
- **`docs/e2e-testing.md`** — the full fastchess → uci-to-tlcs → node-tlcv e2e runbook
  (configure, run, wait, check logs & PGNs), the mock-client local path, and the
  LOGON-race. Reach for it before shipping a protocol/transport change, or to verify a
  move/result/name/clock bug end-to-end.
- **`README.md`** — full CLI options, the UCI→TLCS encoding table, and scope.
- **`../node-tlcv/src/`** — the wire contract's source of truth (`game-service.ts`,
  `kibitzer/uci-parser.ts`, `udp-transport.ts`); there is no official spec.

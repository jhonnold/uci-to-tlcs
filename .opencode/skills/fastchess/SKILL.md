---
name: fastchess
description: Drive fastchess to orchestrate engine games and emit a UCI engine log for the uci-to-tlcs e2e flow, or compose any fastchess match/SPRT command. Use when setting up or debugging an e2e run, or building a fastchess invocation (engines, time control, openings, output).
license: MIT
compatibility: opencode
metadata:
  tags: "fastchess, engine, e2e, uci, chess"
  source: "fastchess man.md (Disservin/fastchess) + uci-to-tlcs docs/e2e-testing.md"
---

# Fastchess

Drive **fastchess** to orchestrate engine games and emit a UCI engine log that
`uci-to-tlcs` tails for the e2e flow. Assumes `fastchess` and the engines are
already on `PATH`. The full runbook (configure → run → wait → check logs) is in
`docs/e2e-testing.md`; this skill is the fastchess half.

## The e2e command

```bash
fastchess \
  -engine name=BerserkA cmd=BerserkA \
  -engine name=BerserkB cmd=BerserkB \
  -engine name=BerserkC cmd=BerserkC \
  -engine name=BerserkD cmd=BerserkD \
  -each tc=10+0.1 option.Hash=32 option.Threads=1 \
  -rounds 3 -games 1 -concurrency 1 \
  -log file=/tmp/fc.log engine=true realtime=true
```

Why each flag:

- **single-token `name=`/`cmd=`** — the `uci-to-tlcs` fastchess adapter's name
  regex is `(\S+)`; a multi-token name (`Berserk A`) drops every engine line →
  0 moves (gaps.md I).
- **`-concurrency 1`** — games don't interleave, so the single-board pipeline
  segments them cleanly (gaps.md C).
- **real `tc=` (not `st=`/`movetime`)** — ticking clocks emit `go wtime/btime`
  lines that drive WTIME/BTIME.
- **no adjudication** (`-resign`/`-draw`/`-tb` off) — games end on the board
  (mate/stalemate/3fold/insufficient/50-move), which the bridge derives;
  adjudicated results can't be reconstructed (gaps.md B).
- **`-log file=… engine=true realtime=true`** — `engine=true` captures the UCI
  stream (moves + `go` + score/PV); `realtime=true` flushes so the bridge tails
  it live.
- **`option.X=Y` prefix** — UCI options must be prefixed `option.`; a bare
  unknown key throws. Use `cmd=` (not `path=`); the engine's cwd is its `dir=`.

## Gotchas

- fastchess autosaves `config.json` to its **cwd** — run it from a scratch dir,
  or it drops a `config.json` into whatever directory it's launched from.
- Defaults are 2 games / `-repeat`; override `-games`/`-rounds`/`-concurrency`
  explicitly for e2e.
- `-pgnout` writes fastchess's *own* PGN — separate from node-tlcv's
  reconstructed PGNs under `PGNS_DIR`.

## Full flag reference

[references/fastchess-man.md](./references/fastchess-man.md) — the vendored man
page (all options: tournament, engine config, adjudication, openings, output,
persistence, debugging). Upstream:
https://github.com/Disservin/fastchess/blob/master/man.md

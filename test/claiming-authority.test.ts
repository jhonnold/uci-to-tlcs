import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ClaimingAuthority } from '../src/results/claiming.js';
import type { FinishedGame } from '../src/results/registry.js';
import { GameRegistry } from '../src/results/registry.js';
import { Pipeline, type BroadcastSink, type GameHint } from '../src/pipeline.js';
import { Demux } from '../src/demux.js';
import { FastchessSource } from '../src/source/fastchess-source.js';

class FakeReg {
  games: FinishedGame[] = [];
  refreshes = 0;
  add(o: Partial<FinishedGame>): FinishedGame {
    const g: FinishedGame = { number: this.games.length + 1, white: 'A', black: 'B', result: '1-0', headers: {}, ...o };
    this.games.push(g);
    return g;
  }
  lookup(n: number) {
    return this.games[n - 1];
  }
  refresh() {
    this.refreshes++;
  }
}

type HintOpts = Partial<Omit<GameHint, 'sans'>> & { sans?: string[] };
const hint = (o: HintOpts = {}): GameHint => {
  const { sans = [], ...rest } = o;
  return { white: 'A', black: 'B', startFen: null, plies: sans.length, ...rest, sans: () => sans };
};

test('no hint: entry n, exactly as the plain registry', () => {
  const r = new FakeReg();
  r.add({});
  r.add({ white: 'X' });
  const a = new ClaimingAuthority(r);
  assert.equal(a.lookup(2)?.number, 2);
  assert.equal(a.lookup(3), undefined);
});

test('entry n wins when consistent with the hint', () => {
  const r = new FakeReg();
  r.add({ plyCount: 2, moves: ['e4', 'e5'] });
  r.add({ plyCount: 2, moves: ['e4', 'e5'] });
  const a = new ClaimingAuthority(r);
  assert.equal(a.lookup(2, hint({ sans: ['e4', 'e5'] }))?.number, 2);
});

test('finish order != start order: the consistent unclaimed entry is found', () => {
  const r = new FakeReg();
  r.add({ white: 'C', black: 'A', plyCount: 3, moves: ['d4', 'd5', 'c4'] }); // finished first
  r.add({ plyCount: 2, moves: ['e4', 'e5'] });
  const a = new ClaimingAuthority(r);
  // the A-B game's pipeline thinks it is game 1
  assert.equal(a.lookup(1, hint({ sans: ['e4', 'e5'] }))?.number, 2);
});

test('same pairing, same colours, concurrently: SANs separate them', () => {
  const r = new FakeReg();
  r.add({ plyCount: 2, moves: ['d4', 'd5'] });
  r.add({ plyCount: 2, moves: ['e4', 'e5'] });
  const a = new ClaimingAuthority(r);
  assert.equal(a.lookup(1, hint({ sans: ['e4', 'e5'] }))?.number, 2);
  assert.equal(a.lookup(2, hint({ sans: ['d4', 'd5'] }))?.number, 1);
});

test('a game in progress (fewer plies than PlyCount) is consistent without the SAN check', () => {
  const r = new FakeReg();
  r.add({ plyCount: 40, moves: Array(40).fill('x') });
  const a = new ClaimingAuthority(r);
  let asked = 0;
  const h: GameHint = { white: 'A', black: 'B', startFen: null, plies: 10, sans: () => (asked++, []) };
  assert.equal(a.lookup(1, h)?.number, 1);
  assert.equal(asked, 0, 'SANs are only built once the plies reach PlyCount');
});

test('colours, start FEN and overrun are checked', () => {
  const r = new FakeReg();
  r.add({ white: 'B', black: 'A', plyCount: 2, moves: ['e4', 'e5'] });
  r.add({ plyCount: 2, fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1', moves: ['Kd2', 'Kd7'] });
  r.add({ plyCount: 2, moves: ['e4', 'e5'] });
  const a = new ClaimingAuthority(r);
  a.setConcurrent();
  assert.equal(a.lookup(1, hint({ sans: ['e4', 'e5'] }))?.number, 3);
  assert.equal(a.lookup(1, hint({ startFen: '4k3/8/8/8/8/8/8/4K3 w - - 5 9', sans: ['Kd2', 'Kd7'] }))?.number, 2);
  // more plies than PlyCount: still consistent iff its first PlyCount SANs match
  assert.equal(a.lookup(3, hint({ sans: ['e4', 'e5', 'Nf3'] }))?.number, 3);
  assert.equal(a.lookup(3, hint({ sans: ['d4', 'e5', 'Nf3'] })), undefined);
});

test('claimed entries are skipped; entry n of another game is never handed out under concurrency', () => {
  const r = new FakeReg();
  const g1 = r.add({ plyCount: 2, moves: ['e4', 'e5'] });
  const a = new ClaimingAuthority(r);
  a.claim(g1);
  assert.equal(a.lookup(1, hint({ sans: ['e4', 'e5'] })), undefined);
  r.add({ plyCount: 2, moves: ['d4', 'd5'] });
  // single board: an inconsistent entry n is still returned (today's misaligned-PGN behaviour)
  assert.equal(a.lookup(2, hint({ sans: ['c4', 'c5'] }))?.number, 2);
  a.setConcurrent();
  assert.equal(a.lookup(2, hint({ sans: ['c4', 'c5'] })), undefined);
});

test('PGN without SANs (other notation): names + FEN + PlyCount decide', () => {
  const r = new FakeReg();
  r.add({ white: 'C', plyCount: 2 });
  r.add({ plyCount: 3 });
  r.add({ plyCount: 2 });
  const a = new ClaimingAuthority(r);
  a.setConcurrent();
  assert.equal(a.lookup(1, hint({ sans: ['e4', 'e5'] }))?.number, 3);
});

test('a reset PGN (truncated) clears the claims', () => {
  const r = new FakeReg();
  const g = r.add({ plyCount: 2, moves: ['e4', 'e5'] });
  const a = new ClaimingAuthority(r);
  a.claim(g);
  r.refresh = () => void (r.games = []); // the registry saw the file shrink
  a.refresh();
  r.add({ plyCount: 2, moves: ['e4', 'e5'] });
  assert.equal(a.lookup(1, hint({ sans: ['e4', 'e5'] }))?.number, 1);
});

// ---------------------------------------------------------- real concurrent fixture

class Res implements BroadcastSink {
  out: Array<{ players: string; result?: string; n?: number; pgn?: boolean }> = [];
  setSite() {}
  setPlayers(w: string, b: string) {
    this.out.push({ players: `${w}|${b}` });
  }
  emitInitialPosition() {}
  emitMove() {}
  emitClocks() {}
  emitPv() {}
  emitResult(r: string, n?: number, pgn?: boolean) {
    Object.assign(this.out[this.out.length - 1], { result: r, n, pgn });
  }
}

test('concurrent fixture: every game gets its own PGN entry, each entry claimed once', () => {
  const path = (f: string) => fileURLToPath(new URL(`../fixtures/${f}`, import.meta.url));
  const reg = new GameRegistry(path('fastchess-concurrent.pgn'));
  reg.refresh();
  const auth = new ClaimingAuthority(reg);
  const sinks: Res[] = [];
  const demux = new Demux(
    (id) => {
      sinks[id] = new Res();
      return new Pipeline(sinks[id], { white: 'W', black: 'B', site: 's' }, { authority: auth, firstGameNumber: 1, pvIntervalMs: 0 });
    },
    { onBoardAdded: () => auth.setConcurrent() },
  );
  const src = new FastchessSource();
  for (const l of readFileSync(path('fastchess-concurrent.log'), 'utf8').split('\n')) {
    const n = src.normalize(l);
    if (n) demux.handleLine(n);
  }
  const all = sinks.flatMap((s) => s?.out ?? []);
  assert.equal(all.length, 6);
  for (const g of all) {
    assert.equal(g.pgn, true, `${g.players}: result from the PGN`);
    const e = reg.games[g.n! - 1];
    assert.equal(`${e.white}|${e.black}`, g.players);
    assert.equal(e.result, g.result);
  }
  assert.deepEqual(all.map((g) => g.n).sort(), [1, 2, 3, 4, 5, 6]);
});

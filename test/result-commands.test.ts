import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResultService, type ResultTransport } from '../src/results/result-commands.js';
import type { GameRegistry } from '../src/results/registry.js';

type Opts = { onGiveUp?: (dest: string) => void };
interface Rec { kind: 'enq' | 'raw'; dest: string; body: string; opts?: Opts }

function fake(known = true, onEnqueue?: (n: number, o: Opts | undefined) => void) {
  const rec: Rec[] = [];
  let depth = 0;
  let n = 0;
  const state = { known, reentered: false };
  const t = {
    enqueue(dest: string | null, body: string, opts: Opts = {}) {
      if (depth > 0) state.reentered = true;
      depth++;
      rec.push({ kind: 'enq', dest: dest!, body, opts });
      onEnqueue?.(++n, opts);
      depth--;
    },
    sendRaw(dest: string, body: string) {
      rec.push({ kind: 'raw', dest, body });
    },
    getClient: () => (state.known ? ({} as never) : undefined),
  } as unknown as ResultTransport;
  return { t, rec, state };
}

function reg(n = 3) {
  const r = {
    refreshed: 0,
    games: Array.from({ length: n }, (_, i) => ({ number: i + 1, white: 'A', black: 'B', result: '1-0' })),
    refresh() {
      this.refreshed++;
    },
  };
  return r as typeof r & GameRegistry;
}

const flush = () => new Promise<void>((r) => setImmediate(r));
const D = '1.2.3.4:5';

test('RESULTTABLE to a known client: CTRESET then CT: lines via enqueue, registry refreshed', () => {
  const f = fake(true);
  const r = reg();
  new ResultService(f.t, r).onResultTable(D);
  assert.equal(f.rec[0].body, 'CTRESET');
  assert(f.rec.length > 3 && f.rec.slice(1).every((x) => x.body.startsWith('CT:') && !x.body.startsWith('CT: ')));
  assert(f.rec.every((x) => x.kind === 'enq'));
  assert.equal(r.refreshed, 1);
});

test('RESULTTABLE to an unknown requester goes plain', () => {
  const f = fake(false);
  new ResultService(f.t, reg()).onResultTable(D);
  assert(f.rec.length > 3 && f.rec.every((x) => x.kind === 'raw'));
  assert.equal(f.rec[0].body, 'CTRESET');
});

test('no registry: not-configured replies', () => {
  const f = fake(true);
  const s = new ResultService(f.t);
  s.onResultTable(D);
  assert.deepEqual(f.rec.map((x) => x.body), ['CTRESET', 'CT:Sorry, this server is not configured to send the results table.']);
  f.rec.length = 0;
  s.onGameList(D);
  assert.equal(f.rec.length, 1);
  assert.match(f.rec[0].body, /^MSG:Sorry, the server is not configured/);
});

test('GAMELIST: one MSG when empty, N GL lines otherwise', () => {
  const f = fake(true);
  new ResultService(f.t, reg(0)).onGameList(D);
  assert.equal(f.rec.length, 1);
  assert.match(f.rec[0].body, /^MSG:PGN file not found!/);
  const g = fake(true);
  new ResultService(g.t, reg(4)).onGameList(D);
  assert.equal(g.rec.length, 4);
  assert(g.rec.every((x) => x.body.startsWith('GL:')));
});

test('give-up: duplicate calls coalesce into one deferred re-send starting with CTRESET', async () => {
  const f = fake(true);
  new ResultService(f.t, reg()).onResultTable(D);
  const count = f.rec.length;
  const cb = f.rec[3].opts!.onGiveUp!;
  cb(D);
  f.rec[5].opts!.onGiveUp!(D);
  cb(D);
  assert.equal(f.rec.length, count, 'nothing re-sent before the flush');
  await flush();
  assert.equal(f.rec.length, count * 2);
  assert.equal(f.rec[count].body, 'CTRESET');
});

test('give-up synchronously inside enqueue: contiguous dump, no re-entrancy, dumps in order', async () => {
  const f = fake(true, (n, o) => {
    if (n === 5 && !fired) {
      fired = true;
      o!.onGiveUp!(D);
    }
  });
  let fired = false;
  const s = new ResultService(f.t, reg());
  s.onResultTable(D);
  const first = f.rec.length;
  assert.equal(f.rec.filter((x) => x.body === 'CTRESET').length, 1, 'no new CTRESET inside the first dump');
  await flush();
  assert.equal(f.rec.length, first * 2);
  assert.equal(f.state.reentered, false);
  const idx = f.rec.map((x) => x.opts!.onGiveUp);
  const dumps = [...new Set(idx)];
  const seq = idx.map((c) => dumps.indexOf(c));
  assert.deepEqual(seq, [...seq].sort((a, b) => a - b));
});

test('give-up ignored when superseded by a newer request or the client left before the flush', async () => {
  const f = fake(true);
  const s = new ResultService(f.t, reg());
  s.onResultTable(D);
  const count = f.rec.length;
  f.rec[2].opts!.onGiveUp!(D);
  s.onResultTable(D);
  await flush();
  assert.equal(f.rec.length, count * 2, 'only the new dump, no extra re-send');

  const g = fake(true);
  const s2 = new ResultService(g.t, reg());
  s2.onResultTable(D);
  const c2 = g.rec.length;
  g.rec[2].opts!.onGiveUp!(D);
  g.state.known = false;
  await flush();
  assert.equal(g.rec.length, c2);
});

test('give-up from a superseded dump is ignored', async () => {
  const f = fake(true);
  const s = new ResultService(f.t, reg());
  s.onResultTable(D);
  const old = f.rec[1].opts!.onGiveUp!;
  s.onResultTable(D);
  const count = f.rec.length;
  old(D);
  await flush();
  assert.equal(f.rec.length, count);
});

test('a fourth consecutive give-up stops re-sending', async () => {
  const f = fake(true);
  new ResultService(f.t, reg()).onResultTable(D);
  let dumps = 1;
  for (let i = 0; i < 4; i++) {
    f.rec[f.rec.length - 1].opts!.onGiveUp!(D);
    await flush();
    if (f.rec.filter((x) => x.body === 'CTRESET').length > dumps) dumps++;
  }
  assert.equal(dumps, 4, 'original + 3 re-sends');
});

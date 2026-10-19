import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadState, saveState, type PersistedState } from '../src/state/state-file.js';
import { StateStore } from '../src/state/progress.js';
import { logger } from '../src/util/logger.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'state-'));

function capture() {
  const lines: string[] = [];
  const orig = { ...logger };
  for (const l of ['debug', 'info', 'warn', 'error'] as const) logger[l] = (m: string) => void lines.push(`${l}: ${m}`);
  return { lines, done: () => Object.assign(logger, orig) };
}

const S = (clients: PersistedState['clients'], savedAt = Date.now()): PersistedState => ({ version: 1, savedAt, logIno: 7, clients });

test('save -> load round trip; no .tmp remains', () => {
  const f = path.join(dir(), 's.json');
  const st = S([{ ip: '127.0.0.1', port: 5000, user: 'a', next: 3 }, { ip: '127.0.0.1', port: 5001, user: 'b' }]);
  saveState(f, st);
  assert.equal(existsSync(f + '.tmp'), false);
  assert.deepEqual(loadState(f), { clients: st.clients, logIno: 7 });
});

test('a leftover garbage .tmp does not affect the load', () => {
  const f = path.join(dir(), 's.json');
  saveState(f, S([{ ip: '1.2.3.4', port: 9, user: 'x' }]));
  writeFileSync(f + '.tmp', '{garbage');
  assert.equal(loadState(f)?.clients.length, 1);
});

test('a crash before rename leaves the previous file loadable', () => {
  const f = path.join(dir(), 's.json');
  saveState(f, S([{ ip: '1.2.3.4', port: 9, user: 'old' }]));
  writeFileSync(f + '.tmp', JSON.stringify(S([{ ip: '1.2.3.4', port: 9, user: 'new' }])));
  assert.equal(loadState(f)?.clients[0].user, 'old');
});

test('corrupt JSON, version 2, stale and ENOENT all give null with one log line', () => {
  const d = dir();
  const cap = capture();
  try {
    writeFileSync(path.join(d, 'c.json'), '{nope');
    assert.equal(loadState(path.join(d, 'c.json')), null);
    writeFileSync(path.join(d, 'v.json'), JSON.stringify({ ...S([]), version: 2 }));
    assert.equal(loadState(path.join(d, 'v.json')), null);
    saveState(path.join(d, 'old.json'), S([], Date.now() - 11 * 60_000));
    assert.equal(loadState(path.join(d, 'old.json')), null);
    assert.equal(loadState(path.join(d, 'missing.json')), null);
  } finally {
    cap.done();
  }
  assert.equal(cap.lines.length, 4);
  assert.match(cap.lines[0], /warn: state: ignoring .*c\.json/);
  assert.match(cap.lines[2], /stale/);
  assert.match(cap.lines[3], /no state file/);
});

test('an invalid client entry is skipped, the others kept', () => {
  const f = path.join(dir(), 's.json');
  const bad = { ...S([]), clients: [{ ip: '', port: 1, user: 'a' }, { ip: '1.1.1.1', port: 70000, user: 'b' }, { ip: '1.1.1.1', port: 2, user: 'ok', next: 0 }, { ip: '1.1.1.1', port: 3, user: 'good', next: 2 }] };
  writeFileSync(f, JSON.stringify(bad));
  const cap = capture();
  const r = loadState(f);
  cap.done();
  assert.deepEqual(r?.clients, [{ ip: '1.1.1.1', port: 3, user: 'good', next: 2 }]);
  assert.equal(cap.lines.filter((l) => /invalid client/.test(l)).length, 3);
});

// ---------------------------------------------------------------- StateStore

function mkStore(loaded: Parameters<typeof loadState>[0] extends never ? never : { clients: PersistedState['clients']; logIno?: number } | null = null) {
  const f = path.join(dir(), 's.json');
  const list: Array<{ dest: string; ip: string; port: number; user: string }> = [
    { dest: '127.0.0.1:5000', ip: '127.0.0.1', port: 5000, user: 'a' },
    { dest: '127.0.0.1:5001', ip: '127.0.0.1', port: 5001, user: 'b' },
  ];
  const store = new StateStore(f, { clientList: () => list }, loaded);
  const read = () => JSON.parse(readFileSync(f, 'utf8')) as PersistedState;
  return { store, list, f, read };
}

test('StateStore: game ACK sets next=g, result ACK sets g+1, monotonic', () => {
  const { store, read } = mkStore();
  store.markReady();
  store.mapEpoch(10, 3);
  store.mapEpoch(11, 4);
  store.onAcked('127.0.0.1:5000', 10, false);
  assert.equal(read().clients[0].next, 3);
  store.onAcked('127.0.0.1:5000', 10, true);
  assert.equal(read().clients[0].next, 4);
  store.onAcked('127.0.0.1:5000', 10, false); // lower: ignored
  assert.equal(read().clients[0].next, 4);
  store.onAcked('127.0.0.1:5000', 99, false); // unknown epoch: ignored
  assert.equal(read().clients[0].next, 4);
  store.close(false);
});

test('StateStore: nothing is written before markReady; writes only on change', () => {
  const { store, f } = mkStore();
  store.mapEpoch(1, 1);
  store.onAcked('127.0.0.1:5000', 1, false);
  store.save();
  assert.equal(existsSync(f), false);
  store.markReady();
  assert.equal(existsSync(f), true);
  const m = readFileSync(f, 'utf8');
  store.onAcked('127.0.0.1:5000', 1, false); // same value: no change
  assert.equal(readFileSync(f, 'utf8'), m);
  store.close(false);
});

test('StateStore: resetProgress clears, prune drops removed dests', () => {
  const { store, list, read } = mkStore({ clients: [{ ip: '127.0.0.1', port: 5000, user: 'a', next: 2 }, { ip: '127.0.0.1', port: 5001, user: 'b', next: 2 }] });
  store.markReady();
  assert.equal(read().clients[1].next, 2);
  list.pop();
  store.save();
  assert.equal(read().clients.length, 1);
  assert.equal(store.nextOf('127.0.0.1:5001'), undefined);
  store.resetProgress();
  assert.equal(read().clients[0].next, undefined);
  store.close(false);
});

test('StateStore: a different log inode voids the restored next values', () => {
  const { store } = mkStore({ clients: [{ ip: '127.0.0.1', port: 5000, user: 'a', next: 2 }], logIno: 5 });
  store.setLogIno(6);
  assert.equal(store.restored()[0].next, undefined);
  const same = mkStore({ clients: [{ ip: '127.0.0.1', port: 5000, user: 'a', next: 2 }], logIno: 5 });
  same.store.setLogIno(5);
  assert.equal(same.store.restored()[0].next, 2);
});

import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { PacedSink } from '../src/paced-sink.js';
import type { BroadcastSink } from '../src/pipeline.js';
import { parseInfoLine } from '../src/uci/info.js';

function fake() {
  const calls: string[] = [];
  const inner: BroadcastSink = {
    setSite: () => calls.push('site'),
    setPlayers: () => calls.push('players'),
    emitInitialPosition: () => calls.push('init'),
    emitMove: (a) => calls.push('move:' + a.san),
    emitClocks: () => calls.push('clocks'),
    emitPv: () => calls.push('pv'),
    emitResult: (r) => calls.push('result:' + r),
    emitLevel: () => calls.push('level'),
  };
  return { calls, inner };
}
const mv = (san: string) => ({ fenTruncated: 'x', color: 'w' as const, fullMoveNumber: 1, san, fmr: 0 });

test('not live: synchronous', () => {
  const { calls, inner } = fake();
  const p = new PacedSink(inner, { delayAfterMoveMs: 300, delayAfterGameMs: 500 });
  p.emitMove(mv('e4'));
  p.emitClocks(1, 1);
  assert.deepEqual(calls, ['move:e4', 'clocks']);
});

test('live: a move holds the queue for delayAfterMove, order preserved', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { calls, inner } = fake();
    const p = new PacedSink(inner, { delayAfterMoveMs: 300, delayAfterGameMs: 0 });
    p.setLive();
    p.emitMove(mv('e4'));
    p.emitClocks(1, 1);
    p.emitMove(mv('e5'));
    assert.deepEqual(calls, ['move:e4']);
    mock.timers.tick(299);
    assert.deepEqual(calls, ['move:e4']);
    mock.timers.tick(1);
    assert.deepEqual(calls, ['move:e4', 'clocks', 'move:e5']);
    mock.timers.tick(300);
    p.emitPv('w', 1, 1, 1, 1, [], parseInfoLine('info depth 1 score cp 1 nodes 1 time 10 pv')!);
    assert.deepEqual(calls, ['move:e4', 'clocks', 'move:e5', 'pv']);
  } finally {
    mock.timers.reset();
  }
});

test('a result holds for delayAfterGame', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { calls, inner } = fake();
    const p = new PacedSink(inner, { delayAfterMoveMs: 0, delayAfterGameMs: 1000 });
    p.setLive();
    p.emitResult('1-0');
    p.setPlayers('a', 'b');
    assert.deepEqual(calls, ['result:1-0']);
    mock.timers.tick(1000);
    assert.deepEqual(calls, ['result:1-0', 'players']);
  } finally {
    mock.timers.reset();
  }
});

test('zero delays: synchronous even when live', () => {
  const { calls, inner } = fake();
  const p = new PacedSink(inner, { delayAfterMoveMs: 0, delayAfterGameMs: 0 });
  p.setLive();
  p.emitMove(mv('e4'));
  p.emitLevel('0 1 0');
  assert.deepEqual(calls, ['move:e4', 'level']);
});

test('backlog over 1000 queued sends warns exactly once', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const warn = mock.method(console, 'error', () => {});
  try {
    const { inner } = fake();
    const p = new PacedSink(inner, { delayAfterMoveMs: 10, delayAfterGameMs: 0 });
    p.setLive();
    for (let i = 0; i < 1100; i++) p.emitMove(mv('m' + i));
    const warned = warn.mock.calls.filter((c) => String(c.arguments[0]).includes('pacing backlog')).length;
    assert.equal(warned, 1);
  } finally {
    warn.mock.restore();
    mock.timers.reset();
  }
});

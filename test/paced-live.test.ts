import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PacedSink } from '../src/paced-sink.js';
import type { BroadcastSink } from '../src/pipeline.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('setLive(false) while holding drops queued jobs and clears the timer; later sends pass through', async () => {
  const log: string[] = [];
  const inner = {
    setSite() {}, setPlayers: (w: string) => void log.push('players ' + w), emitInitialPosition() {}, emitClocks() {}, emitPv() {},
    emitMove: (a: { san: string }) => void log.push('move ' + a.san), emitResult() {},
  } as unknown as BroadcastSink;
  const p = new PacedSink(inner, { delayAfterMoveMs: 80, delayAfterGameMs: 0 });
  p.setLive(true);
  const mv = (san: string) => p.emitMove({ fenTruncated: 'f', color: 'w', fullMoveNumber: 1, san, fmr: 0 });
  mv('e4'); // sent, then holds
  mv('e5'); // queued
  mv('Nf3'); // queued
  assert.deepEqual(log, ['move e4']);
  p.setLive(false);
  await sleep(150);
  assert.deepEqual(log, ['move e4'], 'queued jobs were dropped');
  p.emitMove({ fenTruncated: 'f', color: 'w', fullMoveNumber: 1, san: 'd4', fmr: 0 });
  assert.deepEqual(log, ['move e4', 'move d4'], 'pass-through when not live');
});

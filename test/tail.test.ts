import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync, truncateSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileTailer } from '../src/tail.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => path.join(mkdtempSync(path.join(tmpdir(), 'tail-')), 'a.log');

test('start: <offset> reads only from the offset', async () => {
  const f = tmp();
  writeFileSync(f, 'one\ntwo\nthree\n');
  const lines: string[] = [];
  const t = new FileTailer(f, (l) => lines.push(l), { start: 4 });
  t.start();
  await sleep(400);
  appendFileSync(f, 'four\n');
  await sleep(400);
  t.close();
  assert.deepEqual(lines, ['two', 'three', 'four']);
});

test("start: 'end' reads nothing that already exists", async () => {
  const f = tmp();
  writeFileSync(f, 'one\ntwo\n');
  const lines: string[] = [];
  const t = new FileTailer(f, (l) => lines.push(l), { start: 'end' });
  t.start();
  await sleep(300);
  appendFileSync(f, 'three\n');
  await sleep(400);
  t.close();
  assert.deepEqual(lines, ['three']);
});

test('a partial trailing line is held until completed', async () => {
  const f = tmp();
  writeFileSync(f, 'one\ntw');
  const lines: string[] = [];
  const t = new FileTailer(f, (l) => lines.push(l), { start: 0 });
  t.start();
  await sleep(300);
  assert.deepEqual(lines, ['one']);
  appendFileSync(f, 'o\n');
  await sleep(400);
  t.close();
  assert.deepEqual(lines, ['one', 'two']);
});

test('truncation: onReset is called once and lines come from the returned offset', async () => {
  const f = tmp();
  writeFileSync(f, 'aaaa\nbbbb\ncccc\n');
  const lines: string[] = [];
  let resets = 0;
  const t = new FileTailer(f, (l) => lines.push(l), { start: 0, onReset: () => (resets++, 0) });
  t.start();
  await sleep(400);
  truncateSync(f, 0);
  appendFileSync(f, 'x\n');
  await sleep(600);
  t.close();
  assert.equal(resets, 1);
  assert.deepEqual(lines, ['aaaa', 'bbbb', 'cccc', 'x']);
});

test('rotation (inode change) calls onReset even when the new file is larger', async () => {
  const f = tmp();
  writeFileSync(f, 'old1\n');
  const lines: string[] = [];
  let resets = 0;
  const t = new FileTailer(f, (l) => lines.push(l), { start: 0, onReset: () => (resets++, 8) });
  t.start();
  await sleep(400);
  renameSync(f, f + '.1');
  writeFileSync(f, 'skipped\nnew-line-one\nnew-line-two\n'); // returned offset 8 skips 'skipped'
  await sleep(700);
  t.close();
  assert.equal(resets, 1);
  assert.deepEqual(lines, ['old1', 'new-line-one', 'new-line-two']);
  assert.ok(statSync(f).size > 8);
});

test('vanish then reappear calls onReset', async () => {
  const f = tmp();
  writeFileSync(f, 'one\n');
  const lines: string[] = [];
  let resets = 0;
  const t = new FileTailer(f, (l) => lines.push(l), { start: 0, onReset: () => (resets++, 0) });
  t.start();
  await sleep(400);
  rmSync(f);
  await sleep(500);
  writeFileSync(f, 'two\n');
  await sleep(700);
  t.close();
  assert.equal(resets, 1);
  assert.deepEqual(lines, ['one', 'two']);
});

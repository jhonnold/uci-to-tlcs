import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileTailer } from '../src/tail.js';

test('onCaughtUp fires exactly once after the initial read', async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'tail-')), 'a.log');
  writeFileSync(f, 'one\ntwo\n');
  const lines: string[] = [];
  let caught = 0;
  let linesAtCaught = -1;
  const t = new FileTailer(f, (l) => lines.push(l), true, () => {
    caught++;
    linesAtCaught = lines.length;
  });
  t.start();
  await new Promise((r) => setTimeout(r, 500));
  appendFileSync(f, 'three\n');
  await new Promise((r) => setTimeout(r, 500));
  t.close();
  assert.equal(caught, 1);
  assert.equal(linesAtCaught, 2);
  assert.deepEqual(lines, ['one', 'two', 'three']);
});

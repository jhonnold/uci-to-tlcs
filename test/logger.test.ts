import { test } from 'node:test';
import assert from 'node:assert/strict';

import { logger, setLogFormat } from '../src/util/logger.js';

test('logger: human default, json via setLogFormat, stream split kept', () => {
  const out: string[] = [];
  const err: string[] = [];
  const orig = { log: console.log, error: console.error };
  console.log = (l: string) => void out.push(l);
  console.error = (l: string) => void err.push(l);
  try {
    logger.info('hello');
    assert.match(out[0], /^\d{4}-.*Z \[info\] hello$/);
    setLogFormat('json');
    logger.info('hello');
    logger.warn('careful');
    const j = JSON.parse(out[1]);
    assert.deepEqual(Object.keys(j), ['ts', 'level', 'msg']);
    assert.equal(j.level, 'info');
    assert.equal(j.msg, 'hello');
    assert.equal(JSON.parse(err[0]).level, 'warn');
  } finally {
    setLogFormat('human');
    console.log = orig.log;
    console.error = orig.error;
  }
});

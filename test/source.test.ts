import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RawUciSource } from '../src/source/raw-source.js';
import { FastchessSource } from '../src/source/fastchess-source.js';
import { makeSource } from '../src/source/index.js';

// ------------------------------------------------------------------ RawUciSource

test('RawUciSource: passes through the bare line, no identity/direction', () => {
  const s = new RawUciSource();
  assert.deepEqual(s.normalize('position startpos moves e2e4'), { uci: 'position startpos moves e2e4' });
  assert.deepEqual(s.normalize('  bestmove e2e4  '), { uci: 'bestmove e2e4' });
  assert.equal(s.normalize(''), null);
  assert.equal(s.normalize('   '), null);
});

// ---------------------------------------------------------------- FastchessSource

test('FastchessSource: extracts engineId + direction + payload (in vs out)', () => {
  const s = new FastchessSource();
  assert.deepEqual(
    s.normalize('[Engine] [15:14:19.224585] <     139834165294784>  EngA <--- go wtime 410 btime 410'),
    { uci: 'go wtime 410 btime 410', engineId: 'EngA', direction: 'in', channel: '139834165294784' },
  );
  assert.deepEqual(
    s.normalize('[Engine] [15:14:19.224961] <     139834165294784>  EngB ---> bestmove e2e3 ponder a7a6'),
    { uci: 'bestmove e2e3 ponder a7a6', engineId: 'EngB', direction: 'out', channel: '139834165294784' },
  );
});

test('FastchessSource: multi-token (space) names are captured whole', () => {
  const s = new FastchessSource();
  assert.deepEqual(
    s.normalize('[Engine] [15:14:19.224585] <     139834165294784>  Berserk A <--- go wtime 410 btime 410'),
    { uci: 'go wtime 410 btime 410', engineId: 'Berserk A', direction: 'in', channel: '139834165294784' },
  );
  assert.deepEqual(
    s.normalize(
      '[Engine] [15:14:19.224961] <     139834165294784>  Berserk 14 v2-rc.1 a4994ff ---> bestmove e2e3 ponder a7a6',
    ),
    { uci: 'bestmove e2e3 ponder a7a6', engineId: 'Berserk 14 v2-rc.1 a4994ff', direction: 'out', channel: '139834165294784' },
  );
});

test('FastchessSource: strips fastchess <stderr> annotation, keeps the real name', () => {
  const s = new FastchessSource();
  assert.deepEqual(
    s.normalize(
      '[Engine] [15:14:19.231926] <     139834165294784>  <stderr> Berserk A ---> Process exited normally with status 0',
    ),
    { uci: 'Process exited normally with status 0', engineId: 'Berserk A', direction: 'out', channel: '139834165294784' },
  );
});

test('FastchessSource: channel is the worker-thread id (absent when the prefix is blank)', () => {
  const s = new FastchessSource();
  assert.equal(s.normalize('[Engine] [23:33:13.805544] <     139966496556736>  Berserk A <--- ucinewgame')?.channel, '139966496556736');
  assert.equal(s.normalize('[Engine] [23:33:13.806441] <     139966513342144>  Berserk A <--- ucinewgame')?.channel, '139966513342144');
  // the same engine name on two threads: identity is (channel, name), not name alone
  assert.notEqual(
    s.normalize('[Engine] [0] <  7>  Berserk A ---> bestmove e2e4')?.channel,
    s.normalize('[Engine] [0] <  8>  Berserk A ---> bestmove e2e4')?.channel,
  );
  const blank = s.normalize('[Engine] [0] <    >  EngA <--- uci');
  assert.equal(blank?.engineId, 'EngA');
  assert.equal(blank?.channel, undefined);
  assert.equal('channel' in (blank ?? {}), false);
});

test('FastchessSource: drops banners and diagnostic dumps', () => {
  const s = new FastchessSource();
  assert.equal(s.normalize('[INFO  ] [15:14:18.831197] <                    > fastchess --- Starting tournament...'), null);
  assert.equal(s.normalize('[WARN  ] [15:14:19.231926] <                    > fastchess --- Warning; Bestmove ...'), null);
  assert.equal(s.normalize('Info; info depth 4 multipv 1 score cp 479 pv a1b1'), null);
  assert.equal(s.normalize('Position; startpos'), null);
  assert.equal(s.normalize('Moves; e2e3 c7c5 g1f3'), null);
  assert.equal(s.normalize(''), null);
});

test('FastchessSource.matches: discriminates tagged lines from bare UCI/banners', () => {
  assert.equal(FastchessSource.matches('[Engine] [00:00:00.0] <  1>  EngA <--- uci'), true);
  // multi-token name still reads as a tagged line (this is what the old regex missed)
  assert.equal(FastchessSource.matches('[Engine] [00:00:00.0] <  1>  Berserk A ---> bestmove e2e4'), true);
  assert.equal(FastchessSource.matches('position startpos'), false);
  assert.equal(FastchessSource.matches('[INFO  ] [00:00:00.0] <    > fastchess --- hi'), false);
});

// ------------------------------------------------------------------- auto sniff

test('makeSource(auto): selects fastchess after skipping leading banners', () => {
  const s = makeSource('auto');
  // banner: undecided, dropped while sniffing
  assert.equal(s.normalize('[INFO  ] [00:00:00.0] <    > fastchess --- Starting tournament...'), null);
  // first engine-tagged line: selects fastchess AND is forwarded
  assert.deepEqual(s.normalize('[Engine] [00:00:00.0] <  1>  EngA <--- uci'), {
    uci: 'uci',
    engineId: 'EngA',
    direction: 'in',
    channel: '1',
  });
  // stays fastchess thereafter
  assert.deepEqual(s.normalize('[Engine] [00:00:00.0] <  1>  EngA ---> bestmove e2e4'), {
    uci: 'bestmove e2e4',
    engineId: 'EngA',
    direction: 'out',
    channel: '1',
  });
});

test('makeSource(auto): selects raw for a bare UCI transcript', () => {
  const s = makeSource('auto');
  assert.deepEqual(s.normalize('id name Berserk'), { uci: 'id name Berserk' });
  assert.deepEqual(s.normalize('position startpos moves e2e4'), { uci: 'position startpos moves e2e4' });
});

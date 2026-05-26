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
    { uci: 'go wtime 410 btime 410', engineId: 'EngA', direction: 'in' },
  );
  assert.deepEqual(
    s.normalize('[Engine] [15:14:19.224961] <     139834165294784>  EngB ---> bestmove e2e3 ponder a7a6'),
    { uci: 'bestmove e2e3 ponder a7a6', engineId: 'EngB', direction: 'out' },
  );
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
  });
  // stays fastchess thereafter
  assert.deepEqual(s.normalize('[Engine] [00:00:00.0] <  1>  EngA ---> bestmove e2e4'), {
    uci: 'bestmove e2e4',
    engineId: 'EngA',
    direction: 'out',
  });
});

test('makeSource(auto): selects raw for a bare UCI transcript', () => {
  const s = makeSource('auto');
  assert.deepEqual(s.normalize('id name Berserk'), { uci: 'id name Berserk' });
  assert.deepEqual(s.normalize('position startpos moves e2e4'), { uci: 'position startpos moves e2e4' });
});

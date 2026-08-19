import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parsePgnGames, loadPgnGames, mergeGames, type PgnGame } from '../src/pgn.js';

const TWO_GAMES = `[Event "Test"]
[Site "test"]
[White "EngA"]
[Black "EngB"]
[Result "1-0"]

1. e4 e5 2. Nf3 1-0
`;

const THREE_GAMES = `${TWO_GAMES}
[Event "Test"]
[Site "test"]
[White "EngB"]
[Black "EngA"]
[Result "1/2-1/2"]

1. d4 d5 2. c4 e6 1/2-1/2
`;

test('parsePgnGames: parses games in file order with results', () => {
  assert.deepEqual(parsePgnGames(THREE_GAMES), [
    { number: 1, white: 'EngA', black: 'EngB', result: '1-0' },
    { number: 2, white: 'EngB', black: 'EngA', result: '1/2-1/2' },
  ]);
});

test('parsePgnGames: missing or unrecognised Result becomes *', () => {
  const noResult = `[White "EngA"]
[Black "EngB"]

1. e4 e5
`;
  assert.deepEqual(parsePgnGames(noResult), [{ number: 1, white: 'EngA', black: 'EngB', result: '*' }]);

  const oddResult = `[White "EngA"]
[Black "EngB"]
[Result "1-0+resign"]

1. e4 1-0
`;
  assert.deepEqual(parsePgnGames(oddResult), [{ number: 1, white: 'EngA', black: 'EngB', result: '*' }]);
});

test('parsePgnGames: empty text and header-less blocks yield no games', () => {
  assert.deepEqual(parsePgnGames(''), []);
  assert.deepEqual(parsePgnGames('just some move text\n1. e4 e5\n'), []);
});

test('loadPgnGames: missing file warns and yields []', () => {
  assert.deepEqual(loadPgnGames(join(tmpdir(), 'no-such-file-uci-tlcs.pgn')), []);
});

test('loadPgnGames: reads a real file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uci-tlcs-pgn-'));
  try {
    const path = join(dir, 'games.pgn');
    writeFileSync(path, THREE_GAMES);
    assert.equal(loadPgnGames(path).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeGames: file wins collisions, live fills missing numbers, sorted', () => {
  const file: PgnGame[] = [
    { number: 1, white: 'EngA', black: 'EngB', result: '1-0' },
    { number: 2, white: 'EngB', black: 'EngA', result: '1/2-1/2' },
  ];
  const live: PgnGame[] = [
    // Collides with file game 2 — file's 1/2-1/2 wins over the synthesized *.
    { number: 2, white: 'EngB', black: 'EngA', result: '*' },
    { number: 3, white: 'EngA', black: 'EngB', result: '0-1' },
  ];
  assert.deepEqual(mergeGames(file, live), [
    { number: 1, white: 'EngA', black: 'EngB', result: '1-0' },
    { number: 2, white: 'EngB', black: 'EngA', result: '1/2-1/2' },
    { number: 3, white: 'EngA', black: 'EngB', result: '0-1' },
  ]);
});

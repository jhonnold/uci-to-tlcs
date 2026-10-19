import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderCrosstable, renderGameList, standings, type ResultGame } from '../src/results/crosstable.js';
import * as P from '../src/tlcs/protocol.js';
import { nodeTlcvIngest, parseGames, parseResults } from './fixtures/node-tlcv-result-parser.js';

const ingest = (games: ResultGame[], recent?: number) =>
  nodeTlcvIngest(['CTRESET', ...renderCrosstable(games, recent).map(P.ct)]);

function mk(spec: Array<[string, string, string]>): ResultGame[] {
  return spec.map(([white, black, result], i) => ({ number: i + 1, white, black, result }));
}

const NAMES = ['BerserkA', 'Berserk B', 'Engine 13', 'X'];
// Double round robin of 4; first-seen order (BerserkA...) differs from points order.
const RR = mk([
  ['BerserkA', 'Berserk B', '0-1'],
  ['Engine 13', 'X', '1-0'],
  ['BerserkA', 'Engine 13', '1/2-1/2'],
  ['Berserk B', 'X', '0-1'],
  ['BerserkA', 'X', '0-1'],
  ['Berserk B', 'Engine 13', '1/2-1/2'],
  ['Berserk B', 'BerserkA', '1/2-1/2'],
  ['X', 'Engine 13', '1-0'],
  ['Engine 13', 'BerserkA', '1-0'],
  ['X', 'Berserk B', '1/2-1/2'],
  ['X', 'BerserkA', '1-0'],
  ['Engine 13', 'Berserk B', '0-1'],
]);

test('crosstable: 4-engine double round robin round-trips through node-tlcv parser, sorted column order', () => {
  const exp = standings(RR);
  const { results, games, currentGameNumber } = ingest(RR);
  assert.equal(results.totalGames, 12);
  assert.deepEqual(results.standings.map((s) => s.rank), [1, 2, 3, 4]);
  assert.notDeepEqual(exp.map((s) => s.name), NAMES, 'points order differs from first-seen order');
  results.standings.forEach((row, i) => {
    assert.equal(row.name, exp[i].name);
    assert.equal(row.games, exp[i].games);
    assert.equal(row.points, exp[i].points);
    assert.equal(row.h2h.length, 4);
    results.standings.forEach((col, j) => {
      const cell = row.h2h[j];
      if (i === j) return assert.equal(cell.results, '**');
      const want = exp[i].h2h.get(col.name)!;
      assert.equal(cell.results, want, `${row.name} vs ${col.name}`);
      assert.equal(cell.wins, [...want].filter((c) => c === '1').length);
      assert.equal(cell.draws, [...want].filter((c) => c === '=').length);
      assert.equal(cell.losses, [...want].filter((c) => c === '0').length);
    });
  });
  assert.equal(games.length, 12);
  assert.deepEqual(games.map((g) => g.gameNumber), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
  const byNo = new Map(RR.map((g) => [g.number, g]));
  for (const g of games) {
    const src = byNo.get(g.gameNumber)!;
    assert.deepEqual([g.white, g.black, g.result], [src.white, src.black, src.result]);
  }
  assert.equal(currentGameNumber, 13);
});

test('crosstable: ties order by name, ranks sequential', () => {
  const r = ingest(mk([['Zed', 'Amy', '1/2-1/2'], ['Bob', 'Cat', '1/2-1/2']]));
  assert.deepEqual(r.results.standings.map((s) => s.name), ['Amy', 'Bob', 'Cat', 'Zed']);
  assert.deepEqual(r.results.standings.map((s) => s.rank), [1, 2, 3, 4]);
});

test('crosstable: pairs that never met get "." cells', () => {
  const r = ingest(mk([['A', 'B', '1-0'], ['C', 'D', '1-0'], ['A', 'C', '0-1']]));
  const a = r.results.standings.find((s) => s.name === 'A')!;
  const names = r.results.standings.map((s) => s.name);
  assert.equal(a.h2h[names.indexOf('D')].results, '.');
  assert.equal(a.h2h[names.indexOf('B')].results, '1');
});

test('crosstable: 8 games per pair widens cells; parsed exactly', () => {
  const g: ResultGame[] = [];
  for (let i = 0; i < 8; i++) g.push({ number: i + 1, white: i % 2 ? 'B' : 'A', black: i % 2 ? 'A' : 'B', result: i % 3 === 0 ? '1/2-1/2' : i % 2 ? '0-1' : '1-0' });
  const r = ingest(g);
  const exp = standings(g);
  const names = r.results.standings.map((s) => s.name);
  assert.equal(r.results.standings[0].h2h[1].results.length, 8);
  assert.equal(r.results.standings[0].h2h[1].results, exp[0].h2h.get(names[1]));
  assert.equal(r.results.standings[1].h2h[0].results, exp[1].h2h.get(names[0]));
});

test('crosstable: 60-char names survive in standings; GL truncates to 40', () => {
  const long = 'L'.repeat(60);
  const g = mk([[long, 'S', '1-0']]);
  const r = ingest(g);
  assert.equal(r.results.standings[0].name, long);
  assert.equal(r.games[0].white, long);
  const gl = renderGameList(g)[0];
  assert.equal(gl.length, 5 + 40 + 40 + 8);
  assert.equal(gl.slice(5, 45), 'L'.repeat(40));
});

test('crosstable: "*" game is not counted but is listed and advances currentGameNumber', () => {
  const g = mk([['A', 'B', '1-0'], ['B', 'A', '*']]);
  const r = ingest(g);
  assert.equal(r.results.totalGames, 1);
  assert.equal(r.results.standings[0].games, 1);
  assert.equal(r.games.length, 2);
  assert.equal(r.games[0].result, '*');
  assert.equal(r.currentGameNumber, 3);
});

test('crosstable: zero games', () => {
  const r = ingest([]);
  assert.deepEqual(r.results, { standings: [], totalGames: 0 });
  assert.deepEqual(r.games, []);
  assert.equal(r.currentGameNumber, 1);
});

test('crosstable: lines carry no leading whitespace; untrimmed (desktop) parse equals trimmed', () => {
  const lines = renderCrosstable(RR);
  for (const l of lines) assert.equal(l, l.trimStart());
  const raw = lines.join('\n') + '\n';
  assert.deepEqual(parseResults(raw), ingest(RR).results);
  assert.deepEqual(parseGames(raw), ingest(RR).games);
});

test('crosstable: only the newest 300 games are listed; standings count all', () => {
  const g: ResultGame[] = [];
  for (let i = 0; i < 350; i++) g.push({ number: i + 1, white: 'A', black: 'B', result: '1-0' });
  const r = ingest(g);
  assert.equal(r.games.length, 300);
  assert.equal(r.games[0].gameNumber, 350);
  assert.equal(r.games[299].gameNumber, 51);
  assert.equal(r.results.totalGames, 350);
  assert.equal(r.results.standings[0].games, 350);
});

test('game list: fixed-width GL lines, newest first, whitespace collapsed', () => {
  const g = mk([['A   spaced', 'B', '1-0'], ['C', 'D', '1/2-1/2']]);
  const lines = renderGameList(g).map(P.gl);
  assert.equal(lines.length, 2);
  for (const l of lines) {
    assert.match(l, /^GL:[ \d]{4}\d.{40}.{40}.{8}$/);
    assert.equal(l.length, 3 + 5 + 40 + 40 + 8);
  }
  assert.equal(lines[0].slice(3, 8), '    2');
  assert.equal(lines[1].slice(8, 48).trimEnd(), 'A spaced');
});

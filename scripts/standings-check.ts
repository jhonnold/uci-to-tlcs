// Compare node-tlcv's results table / game list (saved JSON, or raw CT bodies from a probe) against
// fastchess stdout and the tournament PGN. Exit 0 pass, 1 mismatch, 2 usage/IO error.
//
//   tsx scripts/standings-check.ts --fastchess-out fc.stdout --pgn games.pgn
//     [--standings-json f] [--games-json f] [--ct probe.txt]
//
// fastchess ranks by Elo, so rank ORDER is never compared with it: only the (name, games, points) set,
// plus points non-increasing by our rank.

import { readFileSync } from 'node:fs';
import { parsePgn } from './lib/pgn.js';
import { nodeTlcvIngest, stripEngineSuffix, type ParsedResults } from '../test/fixtures/node-tlcv-result-parser.js';

function die(msg: string): never {
  console.error(`standings-check: ${msg}`);
  process.exit(2);
}

const a = process.argv.slice(2);
const o: Record<string, string> = {};
for (let i = 0; i < a.length; i += 2) {
  if (!a[i].startsWith('--') || a[i + 1] === undefined) die(`bad args near ${a[i]}`);
  o[a[i].slice(2)] = a[i + 1];
}
if (!o['fastchess-out'] || !o.pgn) die('usage: --fastchess-out <f> --pgn <f> [--standings-json f --games-json f] [--ct f]');
if (!(o['standings-json'] && o['games-json']) && !o.ct) die('need --standings-json + --games-json and/or --ct');

const read = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch (e) {
    return die(`cannot read ${p}: ${e}`);
  }
};

// ---- fastchess: last standings block
const fcLines = read(o['fastchess-out']).split('\n');
let start = -1;
fcLines.forEach((l, i) => {
  if (/^Rank\s+Name/.test(l)) start = i;
});
if (start < 0) die('no "Rank Name" header in fastchess output');
const ROW = /^\s*(\d+)\s+(.+?)\s+\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+([\d.]+)%\s+[\d.]+%(?:\s+\[.*\])?\s*$/;
const fc = new Map<string, { games: number; points: number }>();
for (let i = start + 1; i < fcLines.length && !/^-{10}/.test(fcLines[i]); i++) {
  const m = ROW.exec(fcLines[i]);
  if (!m) continue;
  const games = Number(m[3]);
  fc.set(stripEngineSuffix(m[2].trim()), { games, points: Math.round((games * Number(m[4]) * 2) / 100) / 2 });
}
if (fc.size === 0) die('no rows parsed from the fastchess standings block');

// ---- PGN
const pgn = parsePgn(read(o.pgn)).map((g) => ({
  no: g.index,
  white: stripEngineSuffix(g.headers.White ?? ''),
  black: stripEngineSuffix(g.headers.Black ?? ''),
  result: g.headers.Result ?? '*',
}));
const decided = pgn.filter((g) => g.result !== '*');
const tally = new Map<string, [number, number, number]>();
const bump = (r: string, c: string, k: 0 | 1 | 2) => {
  const t = tally.get(`${r}|${c}`) ?? [0, 0, 0];
  t[k]++;
  tally.set(`${r}|${c}`, t);
};
for (const g of decided) {
  const k = g.result === '1-0' ? 0 : g.result === '0-1' ? 2 : 1;
  bump(g.white, g.black, k);
  bump(g.black, g.white, (2 - k) as 0 | 1 | 2);
}

interface View {
  label: string;
  results: ParsedResults;
  games: Array<{ gameNumber: number; white: string; black: string; result: string }>;
}
const views: View[] = [];
if (o['standings-json'] && o['games-json']) {
  views.push({
    label: 'node-tlcv live',
    results: JSON.parse(read(o['standings-json'])),
    games: JSON.parse(read(o['games-json'])),
  });
}
if (o.ct) {
  const bodies = read(o.ct).split('\n').filter((l) => /^(CT:|CTRESET)/.test(l));
  const r = nodeTlcvIngest(bodies);
  views.push({ label: 'probe CT', results: r.results, games: r.games });
}

const problems: string[] = [];
const bad = (s: string) => problems.push(s);
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

for (const v of views) {
  const L = v.label;
  const st = v.results.standings;
  // (a)
  const mine = new Map(st.map((s) => [s.name, { games: s.games, points: s.points }]));
  if (mine.size !== fc.size || [...fc].some(([n, x]) => !same(mine.get(n), x))) {
    bad(`${L} (a): standings differ\n  ours:      ${JSON.stringify([...mine])}\n  fastchess: ${JSON.stringify([...fc])}`);
  }
  for (let i = 1; i < st.length; i++) if (st[i].points > st[i - 1].points) bad(`${L} (a): points increase at rank ${st[i].rank}`);
  // (b)
  if (v.results.totalGames !== decided.length) bad(`${L} (b): totalGames ${v.results.totalGames} != PGN ${decided.length}`);
  // (c)
  for (const [i, row] of st.entries()) {
    if (row.h2h.length !== st.length) bad(`${L} (c): ${row.name} has ${row.h2h.length} cells, want ${st.length}`);
    st.forEach((col, j) => {
      const c = row.h2h[j];
      if (!c) return;
      if (i === j) {
        if (c.results !== '**') bad(`${L} (c): diagonal ${row.name} is "${c.results}"`);
        return;
      }
      const t = tally.get(`${row.name}|${col.name}`) ?? [0, 0, 0];
      if (c.wins !== t[0] || c.draws !== t[1] || c.losses !== t[2]) {
        bad(`${L} (c): ${row.name} vs ${col.name}: got ${c.wins}/${c.draws}/${c.losses}, PGN ${t.join('/')}`);
      }
    });
  }
  // (d)
  const proj = v.games
    .map((g) => ({ gameNumber: g.gameNumber, white: g.white, black: g.black, result: g.result }))
    .sort((x, y) => x.gameNumber - y.gameNumber);
  const want = pgn.map((g) => ({ gameNumber: g.no, white: g.white, black: g.black, result: g.result }));
  if (!same(proj, want)) bad(`${L} (d): games differ (got ${proj.length}, PGN ${want.length})\n  got:  ${JSON.stringify(proj)}\n  want: ${JSON.stringify(want)}`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`standings-check: FAIL (${problems.length})`);
  process.exit(1);
}
console.log(`standings-check: OK (${views.map((v) => v.label).join(', ')}; ${fc.size} players, ${decided.length} decided / ${pgn.length} games)`);

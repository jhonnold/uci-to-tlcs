import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normSan, parsePgn } from '../scripts/lib/pgn.js';
import { checkTranscript, compareGames, isFailure } from '../scripts/lib/e2e-compare.js';
import type { TranscriptRecord } from '../scripts/lib/transcript.js';

const FC = `[Event "Fastchess"]\r
[White "Berserk A"]\r
[Black "Berserk B"]\r
[Result "1-0"]\r
[Termination "checkmate"]\r
\r
1. e4 {+0.31/12 0.20s} e5 {-0.1/10 0.1s} 2. Nf3 $1 (2. Bc4 Nf6) Nc6+ 3. Bb5 a6 1-0\r
\r
[Event "Fastchess"]\r
[White "Berserk B"]\r
[Black "Berserk A"]\r
[Result "1/2-1/2"]\r
\r
1. d4 d5 2. c4 e6 1/2-1/2\r
`;
const NT = `[White "Berserk A"]
[Black "Berserk B"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0

[White "Berserk B"]
[Black "Berserk A"]
[Result "1/2-1/2"]

1. d4 d5 2. c4 e6 1/2-1/2
`;

const failures = (fc: string, nt: string, o = {}) => compareGames(parsePgn(fc), parsePgn(nt), o).filter(isFailure);

test('pgn parser: fastchess style and chess.js style', () => {
  const g = parsePgn(FC);
  assert.equal(g.length, 2);
  assert.equal(g[0].headers.White, 'Berserk A');
  assert.deepEqual(g[0].sans, ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
  assert.deepEqual(g[1].sans, ['d4', 'd5', 'c4', 'e6']);
  assert.equal(parsePgn(NT).length, 2);
});

test('normSan', () => {
  assert.equal(normSan('Nf3+'), 'Nf3');
  assert.equal(normSan('e8=Q#'), 'e8=Q');
  assert.equal(normSan('0-0'), 'O-O');
  assert.equal(normSan('0-0-0+'), 'O-O-O');
});

test('compareGames', () => {
  assert.deepEqual(failures(FC, NT), []);

  const res = failures(FC, NT.replace('[Result "1-0"]', '[Result "0-1"]'));
  assert.equal(res.length, 1);
  assert.equal(res[0].field, 'result');

  const mv = failures(FC, NT.replace('Nc6', 'Nf6'));
  assert.equal(mv.length, 1);
  assert.match(mv[0].msg, /ply 4: exp Nc6 got Nf6/);

  const both = failures(
    FC.replace(/e5 \{[^}]*\} 2\. Nf3 \$1 \(2\. Bc4 Nf6\) Nc6\+ 3\. Bb5 a6/, 'e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 b5 5. Bb3 Nf6 6. O-O Be7'),
    NT.replace('[Result "1-0"]', '[Result "0-1"]').replace('3. Bb5 a6', '3. Bb5 a6 4. Ba4 b5 5. Bb3 Nd4 6. O-O Be7'),
  );
  assert.deepEqual(both.map((f) => f.field), ['result', 'moves']);
  assert.match(both[1].msg, /ply 10:/);

  const second = NT.split('\n\n[White')[0];
  assert.ok(failures(FC, second).some((f) => f.kind === 'MISSING'));
  assert.ok(failures(FC, second).some((f) => f.kind === 'COUNT'));
  assert.ok(failures(second, NT).some((f) => f.kind === 'EXTRA'));

  const star = NT.replace('[Result "1-0"]', '[Result "*"]');
  assert.ok(failures(FC, star).some((f) => f.kind === 'STAR'));
  assert.ok(!failures(FC, star, { allowStar: true }).some((f) => f.kind === 'STAR'));

  const swapped = NT.replace('[White "Berserk A"]\n[Black "Berserk B"]', '[White "Berserk B"]\n[Black "Berserk A"]');
  const kinds = failures(FC, swapped).map((f) => f.kind);
  assert.ok(kinds.includes('MISSING') && kinds.includes('EXTRA'));
});

let t = 0;
const inn = (body: string, id: number | undefined, verdict = 'accepted'): TranscriptRecord => ({
  ts: '', t: t++, mode: 'node-tlcv', user: 'u', session: 1, dir: 'in', raw: body, body, id, verdict,
});
const ev = (event: string): TranscriptRecord => ({ ts: '', t: t++, mode: 'node-tlcv', user: 'u', session: 1, dir: 'event', event });

test('checkTranscript', () => {
  const clean = [ev('logon'), inn('FEN: x', 1), inn('WMOVE: 1. e4', 2), inn('BMOVE: 1... e5', 3)];
  assert.deepEqual(checkTranscript(clean), []);

  // unique id lost (out-of-order never accepted)
  assert.equal(checkTranscript([ev('logon'), inn('FEN: x', 5), inn('WMOVE: 1. e4', 3, 'out-of-order')]).length, 1);
  // retransmit of an accepted id is fine
  assert.deepEqual(checkTranscript([ev('logon'), inn('FEN: x', 1), inn('WMOVE: 1. e4', 1, 'out-of-order')]), []);
  // move before FEN
  assert.equal(checkTranscript([ev('logon'), inn('WMOVE: 1. e4', 1)]).length, 1);
  // restart epoch accepted, ids may drop; FEN required again
  const restart = [ev('logon'), inn('FEN: x', 200), inn('FEN: y', 1, 'restart'), inn('WMOVE: 1. e4', 2)];
  assert.deepEqual(checkTranscript(restart), []);
  assert.equal(checkTranscript([ev('logon'), inn('FEN: x', 200), inn('WMOVE: a', 1, 'restart')]).length, 1);
  // contiguous gap
  const gap = [ev('logon'), inn('FEN: x', 1), inn('WMOVE: 1. e4', 3)];
  assert.deepEqual(checkTranscript(gap), []);
  assert.equal(checkTranscript(gap, { expectContiguous: true }).length, 1);
  // ignored verdicts
  const noise = [ev('logon'), inn('WMOVE: bogus', 9, 'gated'), inn('WMOVE: bogus', 9, 'duplicate'), inn('WMOVE: x', undefined, 'injected-drop'), inn('FEN: x', 1)];
  assert.deepEqual(checkTranscript(noise), []);
  // giveup events never produce findings
  assert.deepEqual(checkTranscript([ev('logon'), ev('ping-giveup'), inn('FEN: x', 1)]), []);
});

test('checkTranscript results against fastchess', () => {
  const fc = parsePgn(FC);
  const ok = [ev('logon'), inn('FEN: x', 1), inn('WPLAYER: Berserk A', 2), inn('BPLAYER: Berserk B', 3), inn('result: 1-0', 4)];
  assert.deepEqual(checkTranscript(ok, { fc }), []);
  const bad = [...ok.slice(0, 4), inn('result: 0-1', 4)];
  assert.equal(checkTranscript(bad, { fc }).length, 1);
});

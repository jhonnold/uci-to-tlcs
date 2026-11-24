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

test('pgn parser: black-to-move start with a lone ellipsis', () => {
  const [g] = parsePgn('[White "A"]\n[Black "B"]\n\n1. ... d6 2. e4 e5 *\n');
  assert.deepEqual(g.sans, ['d6', 'e4', 'e5']);
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

// ------------------------------------------------------------------ TLCS-MG transcripts

const FC1 = parsePgn(FC);
const START = 'FEN: rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq';
/** Board `b`'s full game 2 of FC (Berserk B vs Berserk A, 1. d4 d5 2. c4 e6, 1/2-1/2), wrapped. */
const boardGame = (b: number, ids: () => number, gameno = 2, sans = ['1. d4', '1... d5', '2. c4', '2... e6']) => [
  inn(`BOARD ${b} WPLAYER: Berserk B`, ids()),
  inn(`BOARD ${b} BPLAYER: Berserk A`, ids()),
  inn(`BOARD ${b} ${START}`, ids()),
  ...sans.map((s) => inn(`BOARD ${b} ${s.includes('...') ? 'BMOVE' : 'WMOVE'}: ${s}`, ids())),
  inn(`BOARD ${b} GAMENO: ${gameno}`, ids()),
  inn(`BOARD ${b} result: 1/2-1/2`, ids()),
];
const counter = () => {
  let i = 0;
  return () => ++i;
};

test('checkTranscript multigame: per-board moves and GAMENO checked against fastchess', () => {
  const id = counter();
  const ok = [ev('logon'), inn('MULTIGAME: 1', id()), inn('BOARDS: 1 2', id()), ...boardGame(2, id)];
  assert.deepEqual(checkTranscript(ok, { fc: FC1 }), []);

  const id2 = counter();
  const wrongNo = [ev('logon'), inn('MULTIGAME: 1', id2()), ...boardGame(2, id2, 1)];
  assert.equal(checkTranscript(wrongNo, { fc: FC1 }).length, 1, 'GAMENO 1 is the other game');

  const id3 = counter();
  const wrongMoves = [ev('logon'), inn('MULTIGAME: 1', id3()), ...boardGame(2, id3, 2, ['1. d4', '1... d5', '2. c4', '2... c6'])];
  assert.match(checkTranscript(wrongMoves, { fc: FC1 })[0].msg, /moves/);
});

test('checkTranscript multigame: boards interleave without tripping the FEN-before-move rule', () => {
  const id = counter();
  const a = boardGame(1, id);
  const b = boardGame(2, id);
  const mixed = [ev('logon'), inn('MULTIGAME: 1', 0)];
  for (let i = 0; i < a.length; i++) mixed.push(a[i], b[i]);
  mixed.forEach((r, i) => (r.id = i === 0 ? undefined : i)); // ids in arrival order
  const out = checkTranscript(mixed, { fc: FC1 });
  // both boards report game 2: the second is a duplicate claim
  assert.equal(out.length, 1);
  assert.match(out[0].msg, /GAMENO 2/);
  assert.ok(!out.some((f) => /before any FEN/.test(f.msg)));
});

test('checkTranscript multigame: a bare game line after the opt-in reply is a finding', () => {
  const id = counter();
  const recs = [ev('logon'), inn('MULTIGAME: 1', id()), inn('WMOVE: 1. e4', id())];
  assert.match(checkTranscript(recs)[0].msg, /bare game line/);
  // also the extension lines node-tlcv's command table lacks (WINFO/BINFO)
  const info = [ev('logon'), inn('MULTIGAME: 1', id()), inn('WINFO: depth 1 score cp 0 nodes 1 time 1 pv e2e4', undefined, 'unnumbered')];
  assert.match(checkTranscript(info)[0].msg, /bare game line/);
});

test('checkTranscript legacy purity: a TLCS-MG token without opting in is a finding', () => {
  const id = counter();
  for (const body of ['BOARD 2 WMOVE: 1. e4', 'BOARDS: 1 2', 'MULTIGAME: 1']) {
    const recs = [ev('logon'), inn(START, id()), inn(body, id())];
    assert.equal(checkTranscript(recs, { legacy: true }).length, 1, body);
  }
});

test('checkTranscript multigame: wrapped lines in flight across a re-LOGON are not findings', () => {
  const id = counter();
  const recs = [ev('logon'), inn('MULTIGAME: 1', id()), inn('BOARD 2 FMR: 0', id()), ev('relogon'), inn('BOARD 2 FMR: 1', id())];
  assert.deepEqual(checkTranscript(recs), []);
});

test('checkTranscript lossy client: lost moves reload from the next FEN; the tail and the final board are checked', () => {
  // game 1 of FC: 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1-0; the client lost 1... e5, 2. Nf3 and 2... Nc6 (and their FENs)
  const id = counter();
  const after = (fen: string) => inn(`BOARD 1 FEN: ${fen}`, id());
  const base = [
    ev('logon'),
    inn('MULTIGAME: 1', id()),
    inn('BOARD 1 WPLAYER: Berserk A', id()),
    inn('BOARD 1 BPLAYER: Berserk B', id()),
    inn(`BOARD 1 ${START}`, id()),
    after('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq'),
    inn('BOARD 1 WMOVE: 1. e4', id()),
  ];
  const tail = (lastFen: string) => [
    after('r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq'),
    inn('BOARD 1 WMOVE: 3. Bb5', id()), // illegal on the stale board (black to move): reload
    inn('BOARD 1 FMR: 3', id()),
    after(lastFen),
    inn('BOARD 1 BMOVE: 3... a6', id()),
    inn('BOARD 1 GAMENO: 1', id()),
    inn('BOARD 1 result: 1-0', id()),
  ];
  const good = [...base, ...tail('r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq')];
  assert.deepEqual(checkTranscript(good, { fc: FC1 }), []);

  // lost moves whose successor is legal on the stale board (1... e5 and 2. Nf3 lost, 2... Nc6
  // applies): node-tlcv's board silently diverges; the checker reports it
  const id2 = counter();
  const recs = [...base, ...tail('r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq')];
  recs.splice(recs.length - 7, 0, inn('BOARD 1 BMOVE: 2... Nc6', 0));
  const out = checkTranscript(recs.map((r) => ({ ...r, id: r.id === undefined ? undefined : id2() })), { fc: FC1 });
  assert.ok(out.some((f) => /moves differ|final board/.test(f.msg)), JSON.stringify(out));
});

test('checkTranscript join snapshot: (setup) reload mid-game, then the remaining moves', () => {
  const id = counter();
  const recs = [
    ev('logon'),
    inn('MULTIGAME: 1', id()),
    inn('BOARD 1 WPLAYER: Berserk B', id()),
    inn('BOARD 1 BPLAYER: Berserk A', id()),
    inn(`BOARD 1 ${START}`, id()),
    inn('BOARD 1 FMR: 0', id()),
    inn('BOARD 1 FEN: rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq', id()),
    inn('BOARD 1 FMR: 0', id()),
    inn('BOARD 1 FEN: rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq', id()),
    inn('BOARD 1 WMOVE: 2. (setup)', id()),
    inn('BOARD 1 FMR: 0', id()),
    inn('BOARD 1 WMOVE: 2. c4', id()),
    inn('BOARD 1 BMOVE: 2... e6', id()),
    inn('BOARD 1 GAMENO: 2', id()),
    inn('BOARD 1 result: 1/2-1/2', id()),
  ];
  assert.deepEqual(checkTranscript(recs, { fc: FC1 }), []);
});

test('compareGames --allow-partial: a node-tlcv game that starts at a mid-game [FEN] passes when it is the tail', () => {
  const fc = `[White "Berserk B"]\n[Black "Berserk A"]\n[Result "1/2-1/2"]\n\n1. d4 d5 2. c4 e6 1/2-1/2\n`;
  const partial = (fen: string, moves: string) =>
    `[White "Berserk B"]\n[Black "Berserk A"]\n[Result "1/2-1/2"]\n[SetUp "1"]\n[FEN "${fen}"]\n\n${moves} 1/2-1/2\n`;
  const after2 = 'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq - 0 2';
  assert.equal(failures(fc, partial(after2, '2. c4 e6')).length, 1, 'without the flag: moves differ');
  const ok = compareGames(parsePgn(fc), parsePgn(partial(after2, '2. c4 e6')), { allowPartial: true });
  assert.deepEqual(ok.filter(isFailure), []);
  assert.match(ok[0].msg, /partial OK \(from ply 3, 2 of 4 plies/);
  const wrongFen = compareGames(parsePgn(fc), parsePgn(partial('rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 2', '2. c4 e6')), { allowPartial: true });
  assert.equal(wrongFen.filter(isFailure).length, 1);
});


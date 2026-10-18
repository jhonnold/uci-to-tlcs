import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PgnStreamParser, type PgnGame } from '../src/results/pgn-parser.js';
import { PgnFileReader } from '../src/results/pgn-reader.js';
import { GameRegistry } from '../src/results/registry.js';
import { ByteLineReader } from '../src/results/line-reader.js';
import { logger } from '../src/util/logger.js';

const fixture = readFileSync(new URL('../fixtures/fastchess-adjudicated.pgn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(join(tmpdir(), 'pgn-'));

function parseAll(text: string): PgnGame[] {
  const p = new PgnStreamParser();
  const out: PgnGame[] = [];
  for (const l of text.split('\n')) {
    const g = p.push(l);
    if (g) out.push(g);
  }
  return out;
}

function captureWarn(): { msgs: string[]; restore: () => void } {
  const orig = logger.warn;
  const msgs: string[] = [];
  logger.warn = (m: string) => void msgs.push(m);
  return { msgs, restore: () => void (logger.warn = orig) };
}

test('fixture: two entries with exact headers', () => {
  const g = parseAll(fixture);
  assert.equal(g.length, 2);
  assert.deepEqual(
    g.map((x) => [x.white, x.black, x.result, x.termination, x.plyCount]),
    [
      ['BerserkA', 'Berserk B', '1-0', 'adjudication', 70],
      ['Berserk B', 'BerserkA', '0-1', 'adjudication', 63],
    ],
  );
});

for (const chunk of [1, 97, 4096]) {
  test(`chunked reads (chunkSize=${chunk}) equal one-shot parse`, () => {
    const dir = tmp();
    const f = join(dir, 'g.pgn');
    writeFileSync(f, fixture);
    const r = new PgnFileReader(f, chunk);
    const { added } = r.refresh();
    assert.deepEqual(added, parseAll(fixture));
  });
}

test('random cut points written in successive appends', () => {
  const dir = tmp();
  const f = join(dir, 'g.pgn');
  writeFileSync(f, '');
  const r = new PgnFileReader(f, 13);
  const bytes = Buffer.from(fixture);
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const got: PgnGame[] = [];
  for (let i = 0; i < bytes.length; ) {
    const n = 1 + Math.floor(rnd() * 400);
    appendFileSync(f, bytes.subarray(i, i + n));
    i += n;
    got.push(...r.refresh().added);
  }
  assert.deepEqual(got, parseAll(fixture));
});

test('entry is not emitted before its termination token is written', () => {
  const dir = tmp();
  const f = join(dir, 'g.pgn');
  const first = fixture.slice(0, fixture.indexOf('[Event ', 10));
  const cut = first.lastIndexOf('1-0');
  writeFileSync(f, first.slice(0, cut));
  const r = new PgnFileReader(f);
  assert.equal(r.refresh().added.length, 0);
  appendFileSync(f, '1-0');
  assert.equal(r.refresh().added.length, 0, 'token without newline is only a partial line');
  appendFileSync(f, '\n');
  assert.equal(r.refresh().added.length, 1);
});

test('header-only partial entry does not complete early', () => {
  const p = new PgnStreamParser();
  for (const l of ['[Event "x"]', '[White "a"]', '[Black "b"]', '[Result "1-0"]', '']) assert.equal(p.push(l), undefined);
  assert.equal(p.push('1. e4 e5 {x} 1-0')?.result, '1-0');
});

test('multi-byte header across every chunk boundary decodes exactly', () => {
  const text = fixture.replace('[White "BerserkA"]', '[White "Bérsérk ✓"]');
  const dir = tmp();
  const f = join(dir, 'g.pgn');
  writeFileSync(f, text);
  for (const chunk of [1, 2, 3, 5, 64]) {
    const g = new PgnFileReader(f, chunk).refresh().added;
    assert.equal(g[0].white, 'Bérsérk ✓', `chunk ${chunk}`);
    assert.ok(!g[0].white.includes('�'));
  }
});

test('comments do not terminate; token after a comment does', () => {
  const doc = [
    '[Event "e"]',
    '[White "a"]',
    '[Black "b"]',
    '[Result "0-1"]',
    '',
    '1. e4 { eval 1-0 } e5 {multi',
    'line 1-0 still } 2. Nf3 ; 1-0 here',
    'Nc6 {-1.20/9 0.01s} 0-1',
    '',
  ].join('\n');
  const g = parseAll(doc);
  assert.equal(g.length, 1);
  assert.equal(g[0].result, '0-1');
});

test('movetext with eval comment then 1-0 terminates; 10. is not a token match', () => {
  const g = parseAll('[Event "e"]\n[Result "1-0"]\n\n10. Kxf1 {-1.20/9 0.01s} 1-0\n');
  assert.equal(g.length, 1);
});

test('escaped quote, CRLF, missing trailing blank line', () => {
  const doc = '[Event "e"]\r\n[White "a \\"q\\" \\\\"]\r\n[Black "b"]\r\n[Result "1/2-1/2"]\r\n\r\n1. e4 e5 1/2-1/2';
  const dir = tmp();
  const f = join(dir, 'g.pgn');
  writeFileSync(f, doc + '\r\n');
  const g = new PgnFileReader(f).refresh().added;
  assert.equal(g.length, 1);
  assert.equal(g[0].white, 'a "q" \\');
  assert.equal(g[0].result, '1/2-1/2');
});

test('new [Event before termination finalizes from Result header, with warning', () => {
  const w = captureWarn();
  try {
    const doc = '[Event "e"]\n[White "a"]\n[Black "b"]\n[Result "1-0"]\n\n1. e4 e5\n[Event "f"]\n[White "c"]\n[Black "d"]\n[Result "0-1"]\n\n1. d4 0-1\n';
    const g = parseAll(doc);
    assert.deepEqual(g.map((x) => [x.white, x.result]), [['a', '1-0'], ['c', '0-1']]);
    assert.equal(w.msgs.length, 1);
  } finally {
    w.restore();
  }
});

test('truncation: registry resets and re-reads from 0', () => {
  const w = captureWarn();
  try {
    const dir = tmp();
    const f = join(dir, 'g.pgn');
    writeFileSync(f, fixture);
    const reg = new GameRegistry(f, 128);
    reg.refresh();
    assert.equal(reg.finishedCount(), 2);
    assert.equal(reg.lookup(2)?.white, 'Berserk B');
    const firstEnd = fixture.indexOf('[Event ', 10);
    truncateSync(f, 0);
    writeFileSync(f, fixture.slice(0, firstEnd));
    reg.refresh();
    assert.equal(reg.finishedCount(), 1);
    assert.equal(reg.lookup(1)?.result, '1-0');
    assert.equal(reg.lookup(2), undefined);
  } finally {
    w.restore();
  }
});

test('missing file: zero entries, no throw; entries appear once created', () => {
  const dir = tmp();
  const f = join(dir, 'later.pgn');
  const reg = new GameRegistry(f);
  reg.refresh();
  assert.equal(reg.finishedCount(), 0);
  writeFileSync(f, fixture);
  reg.refresh();
  assert.equal(reg.finishedCount(), 2);
  assert.equal(reg.lookup(1)?.number, 1);
});

test('ByteLineReader: byte offsets with CRLF and multi-byte', () => {
  const dir = tmp();
  const f = join(dir, 'x.txt');
  const text = 'ab\r\nbé✓\r\nlast';
  writeFileSync(f, text);
  const r = new ByteLineReader(f, 2);
  const got: [string, number][] = [];
  r.readAvailable((l, o) => got.push([l, o]));
  assert.deepEqual(got, [['ab', 0], ['bé✓', 4]]);
  assert.equal(r.lineEnd, Buffer.byteLength('ab\r\nbé✓\r\n'));
  assert.equal(r.offset, Buffer.byteLength(text));
});

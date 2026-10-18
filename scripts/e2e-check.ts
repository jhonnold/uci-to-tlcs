// Compare node-tlcv's saved PGNs and/or mock transcripts against fastchess's games.pgn.
// Exit 0 pass, 1 mismatch, 2 usage/IO error.
//
//   tsx scripts/e2e-check.ts --fastchess games.pgn [--pgns dir] [--transcript f.jsonl ...]
//     [--allow-star] [--strict-numbers] [--expect-contiguous] [--json]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parsePgn, type PgnGame } from './lib/pgn.js';
import { checkTranscript, compareGames, isFailure, type Finding } from './lib/e2e-compare.js';
import { readTranscript } from './lib/transcript.js';

function die(msg: string): never {
  console.error(`e2e-check: ${msg}`);
  process.exit(2);
}

function findPgns(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...findPgns(p));
    else if (e.endsWith('.pgn')) out.push(p);
  }
  return out.sort();
}

const a = process.argv.slice(2);
let fastchess = '';
let pgns = '';
const transcripts: string[] = [];
const flags = { allowStar: false, strictNumbers: false, expectContiguous: false, json: false };
for (let i = 0; i < a.length; i++) {
  switch (a[i]) {
    case '--fastchess': fastchess = a[++i] ?? ''; break;
    case '--pgns': pgns = a[++i] ?? ''; break;
    case '--transcript': transcripts.push(a[++i] ?? ''); break;
    case '--allow-star': flags.allowStar = true; break;
    case '--strict-numbers': flags.strictNumbers = true; break;
    case '--expect-contiguous': flags.expectContiguous = true; break;
    case '--json': flags.json = true; break;
    default: die(`unknown option ${a[i]}`);
  }
}
if (!fastchess) die('--fastchess <games.pgn> is required');
if (!pgns && !transcripts.length) die('give --pgns and/or --transcript');

let fc: PgnGame[];
try {
  fc = parsePgn(readFileSync(fastchess, 'utf8'), fastchess);
} catch (e) {
  die(`cannot read ${fastchess}: ${(e as Error).message}`);
}
if (!fc.length) die(`no games in ${fastchess}`);

const findings: Finding[] = [];
if (pgns) {
  let files: string[];
  try {
    files = findPgns(pgns);
  } catch (e) {
    die(`cannot read ${pgns}: ${(e as Error).message}`);
  }
  if (!files.length) die(`no .pgn files under ${pgns}`);
  const nt = files.flatMap((f) => parsePgn(readFileSync(f, 'utf8'), f));
  findings.push(...compareGames(fc, nt, flags));
}
for (const t of transcripts) {
  let recs;
  try {
    recs = readTranscript(t);
  } catch (e) {
    die(`cannot read ${t}: ${(e as Error).message}`);
  }
  findings.push(...checkTranscript(recs, { fc, expectContiguous: flags.expectContiguous }));
}

const bad = findings.filter(isFailure);
if (flags.json) console.log(JSON.stringify({ pass: bad.length === 0, findings }, null, 2));
else {
  console.log(bad.length ? `FAIL ${bad.length} finding(s)` : `PASS (${fc.length} fastchess game(s))`);
  for (const f of findings) console.log(`${f.kind.padEnd(10)} ${f.field ? `[${f.field}] ` : ''}${f.msg}`);
}
process.exit(bad.length ? 1 : 0);

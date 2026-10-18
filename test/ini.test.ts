import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseIni } from '../src/ini.js';

const B = '/base';
const p = (t: string) => parseIni(t, B);

test('reference sample parses', () => {
  const buf = readFileSync(new URL('../fixtures/server.reference.ini', import.meta.url));
  assert.ok(buf.includes('\r\n'), 'fixture must keep CRLF');
  const { values: v, warnings } = parseIni(buf.toString('utf8'), B);
  assert.equal(v.logPath, path.resolve(B, 'c:\\winboard\\winboard.debug'));
  assert.equal(v.port, 16000);
  assert.equal(v.site, 'Please type something here.');
  assert.equal(v.tourneyPgn, undefined);
  assert.equal(v.delayMs, 100);
  assert.equal(v.delayAfterMoveMs, 50);
  assert.equal(v.delayAfterGameMs, 2000);
  assert.equal(v.saveDebug, true);
  assert.equal(v.menus, undefined);
  assert.ok(warnings.some((w) => w.includes('MAILSERVER')));
  assert.ok(warnings.some((w) => w.includes('RETURNADD')));
  assert.ok(!warnings.some((w) => w.includes('ICSMODE')));
});

test('line endings: LF, CRLF, CR and missing final newline are equivalent', () => {
  const lines = ['PORT=1234', 'SITE=s', 'DELAY=7'];
  const ref = p(lines.join('\n')).values;
  assert.equal(ref.delayMs, 7);
  for (const sep of ['\r\n', '\r', '\n']) assert.deepEqual(p(lines.join(sep) + sep).values, ref);
});

test('comments and blanks are silent', () => {
  const { values, warnings } = p("'PORT=1\n\n   \n' hi\nDELAY=5\n");
  assert.deepEqual(values, { delayMs: 5 });
  assert.deepEqual(warnings, []);
});

test('keys are case- and whitespace-sensitive', () => {
  for (const l of ['port=1', 'Port=1', ' PORT=1', 'PORT =1']) {
    const r = p(l);
    assert.equal(r.values.port, undefined, l);
    assert.equal(r.warnings.length, 1, l);
  }
});

test('last duplicate wins', () => {
  assert.equal(p('PORT=1\nPORT=2').values.port, 2);
  assert.equal(p('SITE=a\nSITE=b').values.site, 'b');
});

test('values: SITE verbatim, numbers trimmed, bad numbers throw with line number', () => {
  assert.equal(p('SITE= x y ').values.site, ' x y ');
  assert.equal(p('DELAY= 50 ').values.delayMs, 50);
  for (const l of ['PORT=abc', 'PORT=0', 'PORT=70000', 'DELAY=-1']) {
    assert.throws(() => p('SITE=a\n' + l), /line 2.*invalid/, l);
  }
});

test('flags and unsupported keys', () => {
  assert.equal(p('SAVEDEBUG=0').values.saveDebug, false);
  assert.equal(p('SAVEDEBUG=1').values.saveDebug, true);
  assert.throws(() => p('SAVEDEBUG=yes'), /SAVEDEBUG/);
  assert.equal(p('ICSMODE=1').warnings.length, 1);
  assert.equal(p('ICSMODE=0').warnings.length, 0);
});

test('MENU lines', () => {
  const m = (id: string | number, extra = '') => `MENU ID=${id} WIDTH=1 NAME="Sched ule"${extra}`;
  const r = p([m(2), m(1)].join('\n'));
  assert.deepEqual(r.values.menus, [m(1), m(2)]);
  assert.equal(p(m(10)).values.menus?.length, 1);
  for (const bad of [m(0), m(11), 'MENU WIDTH=1', 'MENU ID=x']) {
    const x = p(bad);
    assert.equal(x.values.menus, undefined, bad);
    assert.equal(x.warnings.length, 1, bad);
  }
  assert.deepEqual(p(m(3, ' a') + '\n' + m(3, ' b')).values.menus, [m(3, ' b')]);
  assert.deepEqual(p('MENU ID=3').values.menus, ['MENU ID=3']);
  const twelve = Array.from({ length: 12 }, (_, i) => m(i + 1)).join('\n');
  assert.equal(p(twelve).values.menus?.length, 10);
});

test('paths resolve against baseDir', () => {
  const v = p('PATH=fc.log\nTOURNEYPGN=/abs/g.pgn\nSTATEFILE=s.json').values;
  assert.equal(v.logPath, path.resolve(B, 'fc.log'));
  assert.equal(v.tourneyPgn, '/abs/g.pgn');
  assert.equal(v.stateFile, path.resolve(B, 's.json'));
  assert.equal(p('TOURNEYPGN=').values.tourneyPgn, undefined);
});

test('extension keys', () => {
  assert.equal(p('FORMAT=fastchess').values.format, 'fastchess');
  assert.throws(() => p('FORMAT=xboard'), /FORMAT/);
  assert.equal(p('BIND= 127.0.0.1 ').values.bindAddr, '127.0.0.1');
  assert.equal(p('CLIENTTIMEOUT=90').values.clientTimeoutMs, 90000);
  assert.equal(p('MAXCLIENTS=5').values.maxClients, 5);
  assert.equal(p('ADMINPASS=s3cr et').values.adminPass, 's3cr et');
  assert.match(p('FOO=bar').warnings[0], /unknown key FOO/);
});

test('BOM stripped, Ctrl-Z ends input', () => {
  assert.equal(p('\uFEFFPORT=5').values.port, 5);
  assert.equal(p('PORT=5\n\x1aDELAY=9').values.delayMs, undefined);
});

test('FENSETUPMOVE: 1 true, 0 and empty false, other values throw', () => {
  assert.equal(p('FENSETUPMOVE=1').values.fenSetupMove, true);
  assert.equal(p('FENSETUPMOVE=0').values.fenSetupMove, false);
  assert.equal(p('FENSETUPMOVE=').values.fenSetupMove, false);
  assert.equal(p('PORT=1').values.fenSetupMove, undefined);
  assert.throws(() => p('FENSETUPMOVE=yes'), /line 1: invalid FENSETUPMOVE/);
});

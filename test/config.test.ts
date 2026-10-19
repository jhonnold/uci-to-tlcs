import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig } from '../src/config.js';

const dir = mkdtempSync(path.join(tmpdir(), 'ini-'));
const ini = path.join(dir, 'server.ini');
writeFileSync(ini, 'PATH=g.log\r\nPORT=16100\r\nSITE=Ini Site\r\nMENU ID=1 NAME="x"\r\nTOURNEYPGN=t.pgn\r\n');

test('defaults without --ini', () => {
  assert.deepEqual(parseConfig(['--log', 'x']), {
    logPath: 'x',
    format: 'auto',
    port: 16066,
    bindAddr: '0.0.0.0',
    white: 'White',
    black: 'Black',
    site: 'uci-to-tlcs',
    fromStart: true,
    delayMs: 100,
    delayAfterMoveMs: 0,
    delayAfterGameMs: 0,
    fenSetupMove: true,
    menus: [],
    saveDebug: false,
    clientTimeoutMs: 70000,
    maxClients: 0,
    pvIntervalMs: 200,
  });
});

test('--ini loads values, resolves paths against the ini dir', () => {
  const c = parseConfig(['--ini', ini]);
  assert.equal(c.logPath, path.join(dir, 'g.log'));
  assert.equal(c.port, 16100);
  assert.equal(c.site, 'Ini Site');
  assert.equal(c.iniPath, ini);
  assert.equal(c.tourneyPgn, path.join(dir, 't.pgn'));
  assert.deepEqual(c.menus, ['MENU ID=1 NAME="x"']);
});

test('CLI overrides ini regardless of order', () => {
  for (const argv of [
    ['--ini', ini, '--port', '1234', '--site', 'CLI'],
    ['--port', '1234', '--site', 'CLI', '--ini', ini],
  ]) {
    const c = parseConfig(argv);
    assert.equal(c.port, 1234);
    assert.equal(c.site, 'CLI');
  }
  assert.equal(parseConfig(['--ini', ini, '--log', 'cli.log']).logPath, 'cli.log');
});

test('errors', () => {
  const empty = path.join(dir, 'empty.ini');
  writeFileSync(empty, 'PORT=1\n');
  assert.throws(() => parseConfig(['--ini', empty]), /Missing log path/);
  assert.throws(() => parseConfig(['--ini', path.join(dir, 'nope.ini'), '--log', 'x']), /Cannot read --ini/);
  assert.throws(() => parseConfig(['--log', 'x', '--ini']), /--ini requires a path/);
});

test('--pgn and --delay-after-*', () => {
  const c = parseConfig(['--ini', ini, '--pgn', 'rel.pgn', '--delay-after-move', '25', '--delay-after-game', '7']);
  assert.equal(c.tourneyPgn, path.resolve(process.cwd(), 'rel.pgn'));
  assert.equal(c.delayAfterMoveMs, 25);
  assert.equal(c.delayAfterGameMs, 7);
  assert.throws(() => parseConfig(['--log', 'x', '--delay-after-move', '-1']), /delay-after-move/);
});

test('--fen-setup-move overrides FENSETUPMOVE in the ini; invalid values rejected', () => {
  const off = path.join(dir, 'off.ini');
  writeFileSync(off, 'PATH=g.log\nFENSETUPMOVE=0\n');
  assert.equal(parseConfig(['--ini', off]).fenSetupMove, false);
  assert.equal(parseConfig(['--ini', off, '--fen-setup-move', '1']).fenSetupMove, true);
  assert.equal(parseConfig(['--log', 'x']).fenSetupMove, true);
  assert.throws(() => parseConfig(['--log', 'x', '--fen-setup-move', 'yes']), /fen-setup-move/);
});

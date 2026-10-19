// Parser for the reference TLCS server's `server.ini` (tlc_server16a.exe).
//
// Reference behaviour (reverse-engineered, see docs/tlcs-server-spec.md §8.1):
//   - init loop at 0x4024f1: every line is tested against exact, case-sensitive, column-0
//     `KEY=` prefixes; anything unmatched (comments, blanks, unknown keys) is silently ignored.
//   - MENU lines at 0x40291d: first `ID=n` gives the slot (1..10); the whole line is kept verbatim.
//   - LINE INPUT at 0x414bf8: CR ends a line (a following LF is swallowed), Ctrl-Z ends input.
// Deviations from the reference are listed in spec §8.1 ("Rebuild behaviour").

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isIP } from 'node:net';
import { isFormat, type Format } from './source/index.js';

export interface IniValues {
  logPath?: string;
  format?: Format;
  port?: number;
  bindAddr?: string;
  site?: string;
  delayMs?: number;
  delayAfterMoveMs?: number;
  delayAfterGameMs?: number;
  /** MENU lines, verbatim, in ascending id order. Set only if at least one is valid. */
  menus?: string[];
  tourneyPgn?: string;
  saveDebug?: boolean;
  fenSetupMove?: boolean;
  stateFile?: string;
  clientTimeoutMs?: number;
  adminPass?: string;
  maxClients?: number;
  bannedIps?: string[];
  metricsPort?: number;
  logFormat?: 'human' | 'json';
}

export interface IniResult {
  values: IniValues;
  warnings: string[];
}

const KEY_RE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

export function parseIni(text: string, baseDir: string): IniResult {
  const values: IniValues = {};
  const warnings: string[] = [];
  const menuById = new Map<number, string>();

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const eof = text.indexOf('\x1a');
  if (eof >= 0) text = text.slice(0, eof);

  const fail = (n: number, key: string, v: string): never => {
    throw new Error(`server.ini line ${n}: invalid ${key} value '${v}'`);
  };
  const int = (n: number, key: string, v: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
    const t = v.trim();
    const x = /^\d+$/.test(t) ? Number(t) : NaN;
    if (!(x >= min && x <= max)) fail(n, key, v);
    return x;
  };
  const path = (key: 'logPath' | 'tourneyPgn' | 'stateFile', v: string): void => {
    const t = v.trim();
    if (t === '') delete values[key];
    else values[key] = resolve(baseDir, t);
  };

  text.split(/\r\n|\r|\n/).forEach((L, idx) => {
    const n = idx + 1;
    if (L.trim() === '' || L.startsWith("'")) return;

    if (L.startsWith('MENU ')) {
      const p = L.indexOf('ID=');
      const digits = p < 0 ? null : /^\d+/.exec(L.slice(p + 3));
      if (!digits) {
        warnings.push(`line ${n}: MENU without ID=<n>, ignored`);
        return;
      }
      const id = Number(digits[0]);
      if (id < 1 || id > 10) {
        warnings.push(`line ${n}: MENU id out of range (1-10), ignored`);
        return;
      }
      menuById.set(id, L);
      return;
    }

    const m = KEY_RE.exec(L);
    if (!m) {
      warnings.push(`line ${n}: unrecognized, ignored: ${L}`);
      return;
    }
    const key = m[1];
    const v = m[2];
    switch (key) {
      case 'SITE':
        values.site = v;
        break;
      case 'ADMINPASS':
        values.adminPass = v;
        break;
      case 'BIND':
        values.bindAddr = v.trim();
        break;
      case 'PATH':
        path('logPath', v);
        break;
      case 'TOURNEYPGN':
        path('tourneyPgn', v);
        break;
      case 'STATEFILE':
        path('stateFile', v);
        break;
      case 'PORT':
        values.port = int(n, key, v, 1, 65535);
        break;
      case 'DELAY':
        values.delayMs = int(n, key, v, 0);
        break;
      case 'DELAYAFTERMOVE':
        values.delayAfterMoveMs = int(n, key, v, 0);
        break;
      case 'DELAYAFTERGAME':
        values.delayAfterGameMs = int(n, key, v, 0);
        break;
      case 'CLIENTTIMEOUT':
        values.clientTimeoutMs = int(n, key, v, 1) * 1000;
        break;
      case 'BANNED': {
        const ips = v.split(/[\s,]+/).filter((x) => x !== '');
        for (const ip of ips) if (!isIP(ip)) fail(n, key, v);
        values.bannedIps = [...(values.bannedIps ?? []), ...ips];
        break;
      }
      case 'MAXCLIENTS':
        values.maxClients = int(n, key, v, 0);
        break;
      case 'METRICSPORT':
        if (v.trim() === '') delete values.metricsPort;
        else values.metricsPort = int(n, key, v, 1, 65535);
        break;
      case 'LOGFORMAT': {
        const t = v.trim();
        if (t === '') delete values.logFormat;
        else if (t === 'human' || t === 'json') values.logFormat = t;
        else fail(n, key, v);
        break;
      }
      case 'SAVEDEBUG': {
        const t = v.trim();
        if (t === '1') values.saveDebug = true;
        else if (t === '0' || t === '') values.saveDebug = false;
        else fail(n, key, v);
        break;
      }
      case 'FENSETUPMOVE': {
        const t = v.trim();
        if (t === '1') values.fenSetupMove = true;
        else if (t === '0' || t === '') values.fenSetupMove = false;
        else fail(n, key, v);
        break;
      }
      case 'FORMAT': {
        const t = v.trim();
        if (!isFormat(t)) fail(n, key, v);
        values.format = t as Format;
        break;
      }
      case 'ICSMODE':
        if (v.trim() !== '' && v.trim() !== '0') warnings.push('ICSMODE is not supported, ignored');
        break;
      case 'MAILSERVER':
      case 'RETURNADD':
        if (v.trim() !== '') warnings.push(`${key} (email) is not supported, ignored`);
        break;
      default:
        warnings.push(`line ${n}: unknown key ${key}, ignored`);
    }
  });

  if (menuById.size > 0) {
    values.menus = [...menuById.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);
  }
  return { values, warnings };
}

export function loadIni(path: string): IniResult {
  const full = resolve(path);
  return parseIni(readFileSync(full, 'utf8'), dirname(full));
}

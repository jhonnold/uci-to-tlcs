import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../util/logger.js';
import type { ClientInfo } from './server.js'; // type-only: no runtime cycle

/** The slice of {@link import('./server.js').TlcsServer} that session commands need. */
export interface SessionHost {
  enqueue(dest: string | null, body: string): void;
  sendRaw(dest: string, body: string): void;
  addClient(ip: string, port: number, user: string): boolean;
  removeClient(dest: string): ClientInfo | undefined;
  getClient(dest: string): Readonly<ClientInfo> | undefined;
  clientList(): Array<{ dest: string } & Readonly<ClientInfo>>;
  resync(dest: string): void;
  queueDepth(dest: string): number;
}

export interface SessionOptions {
  menus: string[];
  clientTimeoutMs: number;
  /** MAXCLIENTS gate: return false to refuse the LOGON before the client is registered. */
  admit?: (dest: string, isNew: boolean) => boolean;
  /** Called on every accepted LOGON, right before the resync replay (numbering dump for node-tlcv). */
  beforeResync?: (dest: string) => void;
  now?: () => number;
}

export const MAX_NAME = 30; // reference client-table name width
export const MSG_NOT_CONNECTED = 'MSG: You are no longer connected to the server.  Please re-connect.';
export const MSG_OLD_VIEWER =
  'MSG:Connection refused.  The broadcast server does not support the version of the viewer you are using.';
export const MSG_NO_EMAIL = 'MSG: Sorry, the server is not configured to send Emails.';
export const FEATURE_PING = 'FEATURE: PING';
const NOTICE_INTERVAL_MS = 60_000; // numbered-PING notice rate limit per dest
const PRIVATE = 'CHAT: [SERVER] ';

let cachedVersion: string | undefined;
/** `version` of the nearest package.json above this module (src/tlcs or dist/src/tlcs); lazy, cached, never throws. */
export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  cachedVersion = 'unknown';
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const p = join(dir, 'package.json');
      if (existsSync(p)) {
        cachedVersion = String(JSON.parse(readFileSync(p, 'utf8')).version ?? 'unknown');
        break;
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  } catch {
    /* keep 'unknown': a chat query must never throw */
  }
  return cachedVersion;
}

export function sanitizeText(raw: string): string {
  return raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/** Blank everything after an `ADMIN:` marker so the secret never reaches a log line. */
export function redactSecrets(s: string): string {
  // Tolerates control chars inside the marker: auth strips them (sanitizeText), so must redaction.
  const c = '[\\x00-\\x1f\\x7f]*';
  const re = new RegExp(`A${c}D${c}M${c}I${c}N${c}\\s*${c}:.*`, 'is');
  return s.replace(re, 'ADMIN:***');
}

export function sanitizeName(raw: string): string {
  const n = sanitizeText(raw).replace(/[:<>]/g, '').trim().slice(0, MAX_NAME).trim();
  return n || 'Anonymous';
}

export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 1; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Client→server session commands: logon burst, names, chat, keepalive, reaping. */
export class SessionCommands {
  readonly stats = {
    connects: 0,
    resultTableRequests: 0,
    emails: 0,
    chatRelays: 0,
    dropped: 0,
    startedAt: new Date(),
  };
  private lastNotice = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private host: SessionHost,
    private opts: SessionOptions,
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** @returns true when the message was consumed; false leaves it to the caller (RESULTTABLE, unknown). */
  handle(msg: string, ip: string, port: number, numbered = false): boolean {
    const dest = `${ip}:${port}`;
    const known = this.host.getClient(dest);
    if (msg.startsWith('LOGONv15')) {
      let rest = msg.slice(8);
      if (rest.startsWith(':')) rest = rest.slice(1);
      this.onLogon(ip, port, rest);
    } else if (msg.startsWith('LOGON:')) {
      this.host.sendRaw(dest, MSG_OLD_VIEWER);
    } else if (msg === 'LOGOFF') {
      if (known) {
        this.host.removeClient(dest);
        logger.info(`LOGOFF ${known.user}@${dest}`);
        this.host.enqueue(null, `DELUSER: ${known.user}`);
        this.host.enqueue(null, `CHAT: [SERVER] - ${known.user} has left!`);
      }
    } else if (msg.startsWith('CHANGE:')) {
      if (!known) this.notice(dest, false, 'CHANGE');
      else this.onChange(ip, port, known.user, msg.slice(7));
    } else if (msg === 'PING') {
      if (known) this.host.enqueue(dest, 'PONG');
      else this.notice(dest, numbered, 'PING');
    } else if (msg.startsWith('CHAT:')) {
      if (!known) this.notice(dest, false, 'CHAT');
      else this.onChat(dest, known.user, sanitizeText(msg.slice(5)));
    } else if (msg.startsWith('VOTE:')) {
      logger.debug(`VOTE from ${dest} ignored: ${redactSecrets(msg)}`);
    } else if (msg.startsWith('EMAIL:') || msg.startsWith('SEND:')) {
      this.stats.emails++;
      this.host.sendRaw(dest, MSG_NO_EMAIL);
    } else if (msg === 'RESULTTABLE') {
      this.stats.resultTableRequests++;
      return false;
    } else {
      return false;
    }
    return true;
  }

  private takenExcept(dest: string): Set<string> {
    return new Set(this.host.clientList().filter((c) => c.dest !== dest).map((c) => c.user));
  }

  private notice(dest: string, rateLimited: boolean, cmd: string): void {
    const t = this.now();
    if (rateLimited) {
      const last = this.lastNotice.get(dest);
      if (last !== undefined && t - last < NOTICE_INTERVAL_MS) {
        logger.debug(`notice to ${dest} suppressed (rate limit)`);
        return;
      }
      this.lastNotice.set(dest, t);
    }
    this.host.sendRaw(dest, MSG_NOT_CONNECTED);
    logger.info(`notice -> ${dest} (unknown ${cmd})`);
  }

  private onLogon(ip: string, port: number, rawName: string): void {
    const dest = `${ip}:${port}`;
    const prev = this.host.getClient(dest);
    const name = uniqueName(sanitizeName(rawName), this.takenExcept(dest));
    if (this.opts.admit && !this.opts.admit(dest, !prev)) return;
    this.host.addClient(ip, port, name);
    this.stats.connects++;
    this.lastNotice.delete(dest);
    logger.info(`LOGON ${name}@${dest} (${prev ? 're-logon' : 'new'}) (${this.host.clientList().length} client(s))`);

    const others = this.host.clientList().filter((c) => c.dest !== dest);
    this.host.sendRaw(dest, 'LOGON SUCCESSFUL');
    this.host.enqueue(dest, FEATURE_PING);
    this.opts.beforeResync?.(dest);
    this.host.resync(dest);
    if (prev && prev.user !== name) this.host.enqueue(dest, `DELUSER: ${prev.user}`);
    this.host.enqueue(dest, `ADDUSER: ${name}`);
    for (const o of others) this.host.enqueue(dest, `ADDUSER: ${o.user}`);
    for (const m of this.opts.menus) this.host.enqueue(dest, m);

    if (!prev) {
      for (const o of others) {
        this.host.enqueue(o.dest, `ADDUSER: ${name}`);
        this.host.enqueue(o.dest, `CHAT: [Server] ${name} has arrived!`);
      }
    } else if (prev.user !== name) {
      for (const o of others) {
        this.host.enqueue(o.dest, `DELUSER: ${prev.user}`);
        this.host.enqueue(o.dest, `ADDUSER: ${name}`);
      }
    }
  }

  private onChange(ip: string, port: number, old: string, raw: string): void {
    const dest = `${ip}:${port}`;
    const name = uniqueName(sanitizeName(raw), this.takenExcept(dest));
    if (name === old) return;
    this.host.addClient(ip, port, name);
    logger.info(`CHANGE ${old} -> ${name} @${dest}`);
    this.host.enqueue(null, `DELUSER: ${old}`);
    this.host.enqueue(null, `ADDUSER: ${name}`);
    this.host.enqueue(null, `CHAT: [SERVER] - Alias changed from ${old} to ${name}`);
  }

  private onChat(dest: string, name: string, text: string): void {
    if (!text) return;
    if (text === '<who>' || text === '<time>' || text === '<ver>' || text === '<stats>' || text === '<q>') {
      this.query(dest, text);
      return;
    }
    this.stats.chatRelays++;
    this.host.enqueue(null, `CHAT: [${name}] - ${text}`);
  }

  private query(dest: string, q: string): void {
    const say = (s: string): void => this.host.sendRaw(dest, PRIVATE + s);
    const s = this.stats;
    if (q === '<who>') say(`Users=${this.host.clientList().length}`);
    else if (q === '<time>') {
      const d = new Date(this.now());
      say(
        `Date=${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${d.getFullYear()}, ` +
          `Time=${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
      );
    } else if (q === '<ver>') say(`Version uci-to-tlcs ${packageVersion()}`);
    else if (q === '<stats>') {
      say(`connects: ${s.connects}`);
      say(`result table requests: ${s.resultTableRequests}`);
      say(`e-mails: ${s.emails}`);
      say(`Chat relay: ${s.chatRelays}`);
      say(`Server start: ${s.startedAt.toISOString()}`);
    } else {
      const total = this.host.clientList().reduce((a, c) => a + this.host.queueDepth(c.dest), 0);
      say(`Dropped=${s.dropped}`);
      say(`Re-send queue=${this.host.queueDepth(dest)}`);
      say(`Message queue=${total}`);
    }
  }

  /** Remove clients idle past clientTimeoutMs (never on ACK timeout alone) and prune the notice limiter. */
  reap(now = this.now()): void {
    for (const c of this.host.clientList()) {
      if (c.lastSeen < now - this.opts.clientTimeoutMs) {
        this.host.removeClient(c.dest);
        this.stats.dropped++;
        logger.info(`Reaped silent client ${c.user}@${c.dest} (${this.host.clientList().length} client(s))`);
        this.host.enqueue(null, `DELUSER: ${c.user}`);
        this.host.enqueue(null, `CHAT: [SERVER] - Lost connection with ${c.user}`);
      }
    }
    for (const [d, t] of this.lastNotice) if (now - t >= NOTICE_INTERVAL_MS) this.lastNotice.delete(d);
  }
}

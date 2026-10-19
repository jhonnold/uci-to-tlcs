import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { logger } from '../util/logger.js';
import { MSG_NOT_CONNECTED, redactSecrets, sanitizeText } from './commands.js';
import type { ClientInfo } from './server.js'; // type-only: no runtime cycle

/** The slice of {@link import('./server.js').TlcsServer} that admin commands need. */
export interface AdminHost {
  enqueue(dest: string | null, body: string): void;
  sendRaw(dest: string, body: string): void;
  removeClient(dest: string): ClientInfo | undefined;
  getClient(dest: string): Readonly<ClientInfo> | undefined;
  clientList(): Array<{ dest: string } & Readonly<ClientInfo>>;
}

export interface RateLimit {
  burst: number;
  perSec: number;
}

export interface AdminOptions {
  adminPass?: string;
  /** 0 = unlimited. */
  maxClients: number;
  bannedIps: string[];
  rateLimit: RateLimit;
  now?: () => number;
}

export const MSG_BOOTED = 'MSG: You have been booted!'; // reference text (0x413114)
export const MSG_FULL = 'MSG: Connection refused.  The server is full.';
export const RATE_DEFAULT: RateLimit = { burst: 30, perSec: 10 };
const PRIVATE = 'CHAT: [SERVER] ';
const BAN_RING = 100; // reference: ring of 100 IPs
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 600_000;
const NOTICE_MS = 60_000;
const ADMIN_RE = /^ADMIN\s*:/i;
/** Optional node-tlcv web prefix `(user) ` (lazy, so a user name containing `)` still matches). */
const CHAT_ADMIN_RE = /^(?:\(.{0,64}?\)\s*)?ADMIN\s*:/i;

export { redactSecrets };

const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

/** Per-key token bucket. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; t: number }>();
  constructor(
    private o: RateLimit,
    private now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.o.burst, t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.o.burst, b.tokens + ((t - b.t) / 1000) * this.o.perSec);
    b.t = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  /** Drop buckets that have fully refilled. */
  prune(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((t - b.t) / 1000) * this.o.perSec >= this.o.burst) this.buckets.delete(k);
    }
  }
}

/** Config bans (permanent) plus a runtime ring of 100 (SRBOOT), as in the reference. */
export class BanList {
  private fixed: Set<string>;
  private ring: string[] = [];
  constructor(fixed: string[]) {
    this.fixed = new Set(fixed);
  }
  has(ip: string): boolean {
    return this.fixed.has(ip) || this.ring.includes(ip);
  }
  add(ip: string): void {
    if (this.has(ip)) return;
    this.ring.push(ip);
    if (this.ring.length > BAN_RING) this.ring.shift();
  }
}

export class AdminCommands {
  private readonly expected: Buffer | null;
  private readonly now: () => number;
  private readonly bans: BanList;
  private readonly limiter: RateLimiter;
  /** All keyed by dest (`ip:port`); only rate buckets and bans use the bare IP. */
  private admins = new Set<string>();
  private failures = new Map<string, { count: number; first: number }>();
  private fullNotice = new Map<string, number>();
  private rateWarned = new Map<string, number>();

  constructor(
    private host: AdminHost,
    private opts: AdminOptions,
  ) {
    this.now = opts.now ?? Date.now;
    const pass = sanitizeText(opts.adminPass ?? '');
    this.expected = pass ? sha(pass) : null;
    this.bans = new BanList(opts.bannedIps);
    this.limiter = new RateLimiter(opts.rateLimit, this.now);
  }

  get enabled(): boolean {
    return this.expected !== null;
  }

  isBanned(ip: string): boolean {
    return this.bans.has(ip);
  }

  /** Per-IP datagram budget; warns once per minute per IP when it starts dropping. */
  allowDatagram(ip: string): boolean {
    if (this.limiter.allow(ip)) return true;
    const t = this.now();
    const last = this.rateWarned.get(ip);
    if (last === undefined || t - last >= NOTICE_MS) {
      this.rateWarned.set(ip, t);
      logger.warn(`rate limit: dropping datagrams from ${ip}`);
    }
    return false;
  }

  /** MAXCLIENTS gate for a LOGON; `isNew` is false for a re-logon of a known dest (always admitted). */
  admitLogon(dest: string, isNew: boolean): boolean {
    const max = this.opts.maxClients;
    const n = this.host.clientList().length;
    if (max > 0 && isNew && n >= max) {
      const t = this.now();
      const last = this.fullNotice.get(dest);
      if (last === undefined || t - last >= NOTICE_MS) {
        this.fullNotice.set(dest, t);
        this.host.sendRaw(dest, MSG_FULL);
      }
      logger.info(`LOGON refused (full ${n}/${max}) @${dest}`);
      return false;
    }
    return true;
  }

  /** Drop the admin grant (failure counts persist: they are keyed by dest, not by session). */
  forget(dest: string): void {
    this.admins.delete(dest);
  }

  prune(): void {
    const t = this.now();
    this.limiter.prune();
    for (const [d, f] of this.failures) if (t - f.first >= FAILURE_WINDOW_MS) this.failures.delete(d);
    for (const [d, n] of this.fullNotice) if (t - n >= NOTICE_MS) this.fullNotice.delete(d);
    for (const [d, n] of this.rateWarned) if (t - n >= NOTICE_MS) this.rateWarned.delete(d);
  }

  /** @returns true when the message was consumed here. */
  handle(msg: string, ip: string, port: number): boolean {
    const dest = `${ip}:${port}`;
    const who = (): string => {
      const c = this.host.getClient(dest);
      return c ? `${c.user}@${dest}` : `@${dest}`;
    };

    if (msg.startsWith('CHAT:') && CHAT_ADMIN_RE.test(sanitizeText(msg.slice(5)))) {
      logger.info(`CHAT dropped (admin-like) from ${who()}: ADMIN:***`);
      return true;
    }

    const t = sanitizeText(msg).trimStart();
    const say = (s: string): void => this.host.sendRaw(dest, PRIVATE + s);

    if (ADMIN_RE.test(t)) {
      this.login(dest, t.slice(t.indexOf(':') + 1), say, who);
      return true;
    }
    const isSec = t === 'SECURITY';
    const isBoot = t.startsWith('BOOT:');
    const isSr = t.startsWith('SRBOOT:');
    if (!isSec && !isBoot && !isSr) return false;

    const cmd = isSec ? 'SECURITY' : isBoot ? 'BOOT' : 'SRBOOT';
    if (!this.enabled) {
      say('Admin commands are disabled');
      return true;
    }
    if (!this.admins.has(dest) || !this.host.getClient(dest)) {
      say('Not authorized');
      logger.warn(`${cmd} refused (not admin) @${dest}`);
      return true;
    }
    if (isSec) this.security(dest, who());
    else this.boot(dest, ip, t.slice(isBoot ? 5 : 7).trim(), isSr, say, who());
    return true;
  }

  private login(dest: string, candidate: string, say: (s: string) => void, who: () => string): void {
    if (!this.expected) {
      say('Admin commands are disabled');
      return;
    }
    if (!this.host.getClient(dest)) {
      this.host.sendRaw(dest, MSG_NOT_CONNECTED);
      return;
    }
    const t = this.now();
    let f = this.failures.get(dest);
    if (f && t - f.first >= FAILURE_WINDOW_MS) {
      this.failures.delete(dest);
      f = undefined;
    }
    if (f && f.count >= MAX_FAILURES) {
      say('Admin login locked, try later');
      return;
    }
    if (timingSafeEqual(sha(candidate.trim()), this.expected)) {
      this.admins.add(dest);
      this.failures.delete(dest);
      logger.info(`ADMIN granted ${who()}`);
      say('Admin access granted');
      return;
    }
    f = f ?? { count: 0, first: t };
    f.count++;
    this.failures.set(dest, f);
    logger.warn(`ADMIN denied ${who()} (${f.count}/${MAX_FAILURES})`);
    say('Admin access denied');
  }

  private security(dest: string, who: string): void {
    const list = this.host.clientList();
    for (const c of list) this.host.sendRaw(dest, `SECUSER: ${c.user}:${c.ip}`);
    logger.info(`SECURITY by ${who} (${list.length})`);
  }

  private boot(dest: string, ip: string, arg: string, ban: boolean, say: (s: string) => void, who: string): void {
    const list = this.host.clientList();
    let targets = list.filter((c) => c.dest === arg);
    if (!targets.length && isIP(arg)) targets = list.filter((c) => c.ip === arg);
    if (!targets.length) targets = list.filter((c) => c.user === arg);
    if (!targets.length) {
      say('No such user: ' + sanitizeText(arg));
      return;
    }
    if (ban && targets.some((c) => c.ip === ip)) {
      say('Refusing to ban your own IP');
      return;
    }
    for (const c of targets) {
      this.host.sendRaw(c.dest, MSG_BOOTED);
      this.host.removeClient(c.dest);
      this.host.enqueue(null, `DELUSER: ${c.user}`);
      this.host.enqueue(null, `CHAT: [SERVER] - ${c.user} has left!`);
      logger.info(`${ban ? 'SRBOOT' : 'BOOT'} ${c.user}@${c.dest} by ${who}`);
    }
    if (ban) {
      for (const bip of new Set(targets.map((c) => c.ip))) {
        this.bans.add(bip);
        logger.info(`SRBOOT banned ${bip}`);
      }
    }
  }
}

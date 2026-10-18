// Pure (socket-free) building blocks for the mock client. Everything that needs a
// clock takes an injected `now()` so it can be unit-tested with a fake one.

import { isIdRestart, isLive, mid, parseDesktop, parseNodeTlcv, vbVal } from './tlcs-frame.js';

export type Verdict =
  | 'accepted'
  | 'restart'
  | 'out-of-order'
  | 'unnumbered'
  | 'gated'
  | 'duplicate';

export interface RecvResult {
  ack: string | null;
  verdict: Verdict;
  id?: number;
  body: string;
  /** node-tlcv: the body is live broadcast data (see PROVES_LIVENESS). */
  live: boolean;
}

/** Exact copy of node-tlcv's receive path (UdpTransport.onMessage). */
export class NodeTlcvReceiver {
  /** High-water mark. Never reset on re-LOGON, as in node-tlcv. */
  last: number | undefined;

  receive(raw: string): RecvResult {
    const f = parseNodeTlcv(raw);
    if (!f.numbered) {
      return { ack: null, verdict: 'unnumbered', body: f.body, live: isLive(f.body) };
    }
    const ack = `ACK: ${f.idString}`;
    const id = f.id as number;
    let verdict: Verdict = 'accepted';
    if (this.last && id <= this.last) {
      if (!isIdRestart(id, this.last)) return { ack, verdict: 'out-of-order', id, body: f.body, live: false };
      verdict = 'restart';
    }
    this.last = id;
    return { ack, verdict, id, body: f.body, live: isLive(f.body) };
  }
}

export interface DesktopRecv extends RecvResult {
  /** Server ACK of one of our numbered sends. */
  ackedId?: number;
  /** A FEATURE line mentioned PING. */
  featurePing?: boolean;
  /** LOGON SUCCESSFUL just opened the gate. */
  gateOpened?: boolean;
}

/** Emulates TLCV 2.1c's receive path: untrimmed, gated until LOGON SUCCESSFUL, last-100 dedup. */
export class DesktopReceiver {
  gate = false;
  private ring: number[] = [];
  static readonly RING = 100;

  resetGate(): void {
    this.gate = false;
  }

  receive(raw: string): DesktopRecv {
    const f = parseDesktop(raw);
    const body = f.body;
    let ack: string | null = null;
    let dup = false;
    if (f.numbered) {
      const id = f.id as number;
      ack = `ACK: ${id}`;
      dup = this.ring.includes(id);
      if (!dup) {
        this.ring.push(id);
        if (this.ring.length > DesktopReceiver.RING) this.ring.shift();
      }
    }
    const base = { ack, id: f.id, body, live: false };
    if (dup) return { ...base, verdict: 'duplicate' };
    if (body === 'LOGON SUCCESSFUL') {
      const opened = !this.gate;
      this.gate = true;
      return { ...base, verdict: 'accepted', gateOpened: opened };
    }
    if (!this.gate) return { ...base, verdict: 'gated' };
    const out: DesktopRecv = { ...base, verdict: f.numbered ? 'accepted' : 'unnumbered' };
    if (body.startsWith('ACK:')) out.ackedId = vbVal(mid(body, 5));
    if (body.startsWith('FEATURE:') && body.includes('PING')) out.featurePing = true;
    return out;
  }
}

/** Display field extraction with the desktop client's fixed Mid() offsets. */
export function desktopField(body: string): { name: string; value: string } | null {
  const table: Array<[string, number]> = [
    ['WPLAYER', 10],
    ['BPLAYER', 10],
    ['SITE', 6],
    ['FEN', 6],
    ['CT:', 4],
    ['GL:', 4],
    ['MSG', 5],
    ['ADDUSER', 9],
    ['DELUSER', 9],
  ];
  for (const [p, n] of table) if (body.startsWith(p)) return { name: p.replace(':', ''), value: mid(body, n) };
  return null;
}

/** Mirrors node-tlcv's Broadcast.relogin rate limit and watchdog. */
export class ReloginLimiter {
  lastDataAt: number;
  lastReloginAt = -Infinity;
  closed = false;

  constructor(
    private readonly now: () => number,
    private readonly minMs = 60_000,
    private readonly dataTimeoutMs = 600_000,
  ) {
    this.lastDataAt = now();
  }

  /** Call with the receive-time stamp taken before the datagram was handled. */
  noteData(receivedAt: number): void {
    this.lastDataAt = receivedAt;
  }

  allow(now = this.now()): boolean {
    if (this.closed) return false;
    const recovered = this.lastDataAt > this.lastReloginAt;
    if (!recovered && now - this.lastReloginAt < this.minMs) return false;
    this.lastReloginAt = now;
    return true;
  }

  watchdogDue(now = this.now()): boolean {
    return now - Math.max(this.lastDataAt, this.lastReloginAt) > this.dataTimeoutMs;
  }

  close(): void {
    this.closed = true;
  }
}

interface Slot {
  id: number;
  body: string;
  lastSent: number;
  resends: number;
}

/** Numbered, retransmitted client-side sends (desktop PING / CHAT). Wire form `< N>body`. */
export class DesktopSender {
  private nextId = 1;
  private slots = new Map<number, Slot>();
  static readonly RESEND_MS = 1000;
  static readonly MAX_RESENDS = 30;

  send(body: string, now: number): string {
    const id = this.nextId++;
    this.slots.set(id, { id, body, lastSent: now, resends: 0 });
    return `< ${id}>${body}`;
  }

  ack(id: number): void {
    this.slots.delete(id);
  }

  get pending(): number {
    return this.slots.size;
  }

  /** Resends slots older than 1 s; gives up after 30 resends. */
  tick(now: number): { resend: string[]; giveups: number[] } {
    const resend: string[] = [];
    const giveups: number[] = [];
    for (const s of [...this.slots.values()]) {
      if (now - s.lastSent <= DesktopSender.RESEND_MS) continue;
      if (s.resends >= DesktopSender.MAX_RESENDS) {
        this.slots.delete(s.id);
        giveups.push(s.id);
        continue;
      }
      s.resends++;
      s.lastSent = now;
      resend.push(`< ${s.id}>${s.body}`);
    }
    return { resend, giveups };
  }
}

export type SilenceState = 'slow' | 'very slow' | 'no response' | 'disconnect';

/** Desktop silence states at 10/30/50/70 s. */
export class SilenceMonitor {
  private last: number;
  private level = 0;
  static readonly STEPS: Array<[number, SilenceState]> = [
    [10_000, 'slow'],
    [30_000, 'very slow'],
    [50_000, 'no response'],
    [70_000, 'disconnect'],
  ];

  constructor(now: number) {
    this.last = now;
  }

  reset(now: number): void {
    this.last = now;
    this.level = 0;
  }

  /** Returns any states newly crossed since the last call. */
  check(now: number): SilenceState[] {
    const out: SilenceState[] = [];
    while (this.level < SilenceMonitor.STEPS.length && now - this.last >= SilenceMonitor.STEPS[this.level][0]) {
      out.push(SilenceMonitor.STEPS[this.level][1]);
      this.level++;
    }
    return out;
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Decision = { kind: 'pass' } | { kind: 'drop' } | { kind: 'delay'; ms: number };

/** Seeded loss/reorder injection; each direction has its own PRNG stream. */
export class LossInjector {
  private rng: Record<'in' | 'out', () => number>;
  constructor(
    private readonly drop: number,
    private readonly reorder: number,
    seed = 1,
  ) {
    this.rng = { in: mulberry32(seed), out: mulberry32(seed + 7919) };
  }

  decide(dir: 'in' | 'out', raw: string): Decision {
    if (dir === 'out' && raw.startsWith('LOGON')) return { kind: 'pass' };
    const r = this.rng[dir];
    if (this.drop > 0 && r() < this.drop) return { kind: 'drop' };
    if (this.reorder > 0 && r() < this.reorder) return { kind: 'delay', ms: 100 + Math.floor(r() * 400) };
    return { kind: 'pass' };
  }
}

export interface BindOpts {
  bind: string;
  port: number;
  ephemeral: boolean;
  localPort?: number;
}

/** --local-port > --ephemeral > legacy same-port on 127.0.0.2. */
export function resolveBind(o: BindOpts): { address: string; port: number } {
  if (o.ephemeral && o.localPort !== undefined) throw new Error('--ephemeral and --local-port are mutually exclusive');
  if (o.localPort !== undefined) return { address: o.bind || '127.0.0.1', port: o.localPort };
  if (o.ephemeral) return { address: o.bind || '127.0.0.1', port: 0 };
  return { address: o.bind || '127.0.0.2', port: o.port };
}

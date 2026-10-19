// Socket wiring around the pure mock-core pieces: one mock client session.

import { createSocket, type Socket } from 'node:dgram';
import { closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import {
  DesktopReceiver,
  DesktopSender,
  LossInjector,
  NodeTlcvReceiver,
  ReloginLimiter,
  SilenceMonitor,
  desktopField,
  resolveBind,
  type RecvResult,
} from './mock-core.js';
import { TranscriptWriter, type TranscriptRecord } from './transcript.js';

export interface SessionOpts {
  server: string;
  port: number;
  bind: string;
  localPort?: number;
  ephemeral: boolean;
  user: string;
  mode: 'node-tlcv' | 'desktop';
  drop: number;
  reorder: number;
  seed: number;
  transcript?: string;
  quiet: boolean;
  logoffAfter?: number;
  logonAgainAfter?: number;
  silentAfter?: number;
  silentFor?: number;
  exitAfter?: number;
  reloginMin: number;
  dataTimeout: number;
  forcePing: boolean;
  noDisconnect: boolean;
  chat?: string;
  /** File polled for appended lines; each is sent as-is (a `#` prefix sends it numbered; desktop mode only). */
  control?: string;
  /** Called once with the exit code; the CLI maps it to process.exit. */
  onExit: (code: number) => void;
}

export class MockSession {
  private sock: Socket = createSocket('udp4');
  private tx: TranscriptWriter;
  private loss: LossInjector;
  private nt = new NodeTlcvReceiver();
  private desk = new DesktopReceiver();
  private sender = new DesktopSender();
  private limiter: ReloginLimiter;
  private silence: SilenceMonitor;
  private t0 = Date.now();
  private session = 1;
  private silent = false;
  private pingEnabled = false;
  private pingTimer?: NodeJS.Timeout;
  private timers: NodeJS.Timeout[] = [];
  private intervals: NodeJS.Timeout[] = [];
  private logonTries = 0;
  private exited = false;
  private chatSent = false;

  constructor(private readonly o: SessionOpts) {
    this.tx = new TranscriptWriter(o.transcript);
    this.loss = new LossInjector(o.drop, o.reorder, o.seed);
    this.limiter = new ReloginLimiter(() => performance.now(), o.reloginMin * 1000, o.dataTimeout * 1000);
    this.silence = new SilenceMonitor(Date.now());
  }

  private log(s: string): void {
    if (!this.o.quiet) console.log(s);
  }

  private rec(r: Partial<TranscriptRecord> & { dir: TranscriptRecord['dir'] }): void {
    const now = Date.now();
    this.tx.write({
      ts: new Date(now).toISOString(),
      t: now - this.t0,
      mode: this.o.mode,
      user: this.o.user,
      session: this.session,
      ...r,
    });
  }

  private event(event: string, reason?: string): void {
    this.rec({ dir: 'event', event, reason });
  }

  start(): void {
    const b = resolveBind({ bind: this.o.bind, port: this.o.port, ephemeral: this.o.ephemeral, localPort: this.o.localPort });
    this.sock.on('error', (err) => {
      console.error(`[mock] socket error: ${err}`);
      this.exit(1);
    });
    this.sock.on('message', (buf) => this.onDatagram(buf.toString()));
    this.sock.on('listening', () => {
      const a = this.sock.address();
      this.log(`[mock] ${this.o.mode} bound ${a.address}:${a.port}, logging on to ${this.o.server}:${this.o.port} as "${this.o.user}"`);
      this.begin();
    });
    this.sock.bind(b.port, b.address);
  }

  private begin(): void {
    this.sendLogon('logon');
    if (this.o.mode === 'node-tlcv') {
      this.send('RESULTTABLE');
      this.intervals.push(
        setInterval(() => {
          this.send('PING');
          if (this.limiter.watchdogDue() && this.limiter.allow()) this.relogon('watchdog');
        }, 10_000),
      );
    } else {
      this.intervals.push(setInterval(() => this.deskTick(), 1000));
      this.logonRetry();
      if (this.o.forcePing) this.enablePing();
    }
    if (this.o.control) this.watchControl(this.o.control);
    const at = (s: number | undefined, f: () => void) => {
      if (s !== undefined) this.timers.push(setTimeout(f, s * 1000));
    };
    at(this.o.logoffAfter, () => {
      this.send('LOGOFF', true);
      this.event('logoff');
      if (this.o.logonAgainAfter !== undefined) {
        this.timers.push(setTimeout(() => this.relogon('scenario'), this.o.logonAgainAfter * 1000));
      } else this.exit(0);
    });
    at(this.o.silentAfter, () => {
      this.silent = true;
      this.event('silent-start');
      if (this.o.silentFor !== undefined) {
        this.timers.push(
          setTimeout(() => {
            this.silent = false;
            this.event('silent-end');
          }, this.o.silentFor * 1000),
        );
      }
    });
    at(this.o.exitAfter, () => this.exit(0));
  }

  private watchControl(file: string): void {
    writeFileSync(file, '', { flag: 'a' });
    let off = 0;
    let partial = '';
    this.intervals.push(
      setInterval(() => {
        const size = statSync(file).size;
        if (size <= off) return;
        const buf = Buffer.alloc(size - off);
        const fd = openSync(file, 'r');
        try {
          readSync(fd, buf, 0, buf.length, off);
        } finally {
          closeSync(fd);
        }
        off = size;
        const lines = (partial + buf.toString()).split('\n');
        partial = lines.pop() ?? '';
        for (const l of lines) {
          if (l === '') continue;
          if (l.startsWith('#')) {
            if (this.o.mode === 'desktop') this.sendNumbered(l.slice(1));
            else console.error(`[mock] --control '#' (numbered) lines need --mode desktop: ignored`);
          } else this.send(l);
        }
      }, 200),
    );
  }

  private sendLogon(ev: string, reason?: string): void {
    this.event(ev, reason);
    this.send(`LOGONv15:${this.o.user}`);
  }

  private relogon(reason: string): void {
    this.session++;
    if (this.o.mode === 'desktop') {
      this.desk.resetGate();
      this.logonTries = 0;
      this.logonRetry();
    }
    this.sendLogon('relogon', reason);
  }

  private logonRetry(): void {
    const t = setInterval(() => {
      if (this.desk.gate) return clearInterval(t);
      if (this.logonTries >= 3) {
        clearInterval(t);
        this.event('logon-failed');
        console.error('[mock] LOGON never succeeded');
        this.exit(4);
        return;
      }
      this.logonTries++;
      this.send(`LOGONv15:${this.o.user}`);
    }, 3000);
    this.intervals.push(t);
  }

  private enablePing(): void {
    if (this.pingEnabled) return;
    this.pingEnabled = true;
    this.pingTimer = setInterval(() => this.sendNumbered('PING'), 20_000);
    this.intervals.push(this.pingTimer);
  }

  private sendNumbered(body: string): void {
    this.send(this.sender.send(body, Date.now()));
  }

  private deskTick(): void {
    const now = Date.now();
    const { resend, giveups } = this.sender.tick(now);
    for (const m of resend) this.send(m);
    for (const id of giveups) {
      this.event('ping-giveup', `id ${id}`);
      this.log(`[mock] WARN client-side id ${id} gave up after ${DesktopSender.MAX_RESENDS} resends`);
    }
    for (const s of this.silence.check(now)) {
      this.log(`[mock] silence: ${s}`);
      if (s === 'disconnect' && !this.o.noDisconnect) {
        this.send('LOGOFF', true);
        this.event('disconnect');
        this.exit(3);
      }
    }
  }

  // ---------------------------------------------------------------- outbound

  private send(raw: string, force = false): void {
    if (this.exited && !force) return;
    if (this.silent && !force) {
      this.rec({ dir: 'out', raw, verdict: 'suppressed' });
      return;
    }
    const d = force ? ({ kind: 'pass' } as const) : this.loss.decide('out', raw);
    if (d.kind === 'drop') {
      this.rec({ dir: 'out', raw, verdict: 'injected-drop' });
      return;
    }
    if (d.kind === 'delay') {
      this.rec({ dir: 'out', raw, verdict: 'injected-delay' });
      this.timers.push(setTimeout(() => this.wire(raw, 'delayed-sent'), d.ms));
      return;
    }
    this.wire(raw, 'sent');
  }

  private wire(raw: string, verdict: string): void {
    this.rec({ dir: 'out', raw, verdict });
    this.sock.send(raw, this.o.port, this.o.server);
  }

  // ----------------------------------------------------------------- inbound

  private onDatagram(raw: string): void {
    const d = this.loss.decide('in', raw);
    if (d.kind === 'drop') {
      this.rec({ dir: 'in', raw, verdict: 'injected-drop' });
      return;
    }
    if (d.kind === 'delay') {
      this.rec({ dir: 'in', raw, verdict: 'injected-delay' });
      this.timers.push(setTimeout(() => this.handle(raw), d.ms));
      return;
    }
    this.handle(raw);
  }

  private handle(raw: string): void {
    if (this.exited) return;
    const receivedAt = performance.now();
    this.silence.reset(Date.now());
    const r: RecvResult & { ackedId?: number; featurePing?: boolean; gateOpened?: boolean } =
      this.o.mode === 'desktop' ? this.desk.receive(raw) : this.nt.receive(raw);
    if (r.live) this.limiter.noteData(receivedAt);
    if (r.ack) this.send(r.ack);
    this.rec({ dir: 'in', raw: raw.replace(/\r?\n$/, ''), id: r.id, body: r.body, verdict: r.verdict });
    this.print(r);

    if (r.verdict === 'accepted' || r.verdict === 'restart' || r.verdict === 'unnumbered') {
      if (r.body === 'LOGON SUCCESSFUL') this.event('logon-ok');
      if (r.ackedId !== undefined) this.sender.ack(r.ackedId);
      if (r.featurePing) this.enablePing();
      if (r.gateOpened && this.o.chat && !this.chatSent) {
        this.chatSent = true;
        this.sendNumbered(`CHAT: ${this.o.chat}`);
      }
      if (this.o.mode === 'node-tlcv' && /no longer connected/i.test(r.body) && this.limiter.allow()) {
        this.relogon('msg-notice');
      }
    }
  }

  private print(r: RecvResult): void {
    if (this.o.quiet) return;
    const tag = r.id !== undefined ? `<${r.id}>` : '    ';
    let line = `[mock] ${tag} ${r.body}`;
    if (this.o.mode === 'desktop') {
      const f = desktopField(r.body);
      if (f) line += `   ${f.name} -> [${f.value}]`;
    }
    if (r.verdict === 'out-of-order') line += '   !! out-of-order: node-tlcv would DROP this';
    else if (r.verdict === 'gated' || r.verdict === 'duplicate') line += `   (${r.verdict})`;
    console.log(line);
  }

  exit(code: number): void {
    if (this.exited) return;
    this.send('LOGOFF', true);
    this.event('exit', String(code));
    this.exited = true;
    this.limiter.close();
    for (const i of this.intervals) clearInterval(i);
    for (const t of this.timers) clearTimeout(t);
    setTimeout(() => {
      try {
        this.sock.close();
      } catch {
        /* already closed */
      }
      this.o.onExit(code);
    }, 100);
  }

  /** Test helper: where the socket ended up bound. */
  get localPort(): number {
    return this.sock.address().port;
  }

  get gateOpen(): boolean {
    return this.desk.gate;
  }
}

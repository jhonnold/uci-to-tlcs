import { statSync } from 'node:fs';
import { saveState, type PersistedClient } from './state-file.js';

/** The slice of TlcsServer the store needs. */
export interface StoreHost {
  clientList(): Array<{ dest: string; ip: string; port: number; user: string }>;
}

const SAVE_INTERVAL_MS = 10_000;

/**
 * Tracks, per client, `next` = the oldest game it has not fully ACKed, and persists the
 * client table + those resume points. Writes are synchronous, in the same JS turn as the
 * ACK / table change, so a SIGKILL can never split them.
 */
export class StateStore {
  private next = new Map<string, number>();
  private epochGame = new Map<number, number>();
  private ready = false;
  private logIno?: number;
  private timer: NodeJS.Timeout | null = null;
  private loaded: PersistedClient[];
  private loadedIno?: number;

  constructor(
    private readonly path: string,
    private readonly host: StoreHost,
    loaded: { clients: PersistedClient[]; logIno?: number } | null,
    private readonly now: () => number = Date.now,
    private readonly logPath?: string,
  ) {
    this.loaded = loaded?.clients ?? [];
    this.loadedIno = loaded?.logIno;
    for (const c of this.loaded) if (c.next !== undefined) this.next.set(`${c.ip}:${c.port}`, c.next);
  }

  setLogIno(ino: number | undefined): void {
    this.logIno = ino;
    if (this.loadedIno !== undefined && ino !== undefined && this.loadedIno !== ino) this.next.clear();
  }

  /** Clients to re-attach; their `next` is dropped when the log is a different file. */
  restored(): PersistedClient[] {
    const sameLog = this.loadedIno === undefined || this.logIno === undefined || this.loadedIno === this.logIno;
    return this.loaded.map((c) => ({ ip: c.ip, port: c.port, user: c.user, ...(sameLog && c.next !== undefined ? { next: c.next } : {}) }));
  }

  mapEpoch(epoch: number, game: number): void {
    this.epochGame.set(epoch, game);
  }

  onAcked(dest: string, epoch: number, critical: boolean): void {
    const g = this.epochGame.get(epoch);
    if (g === undefined) return;
    const n = critical ? g + 1 : g;
    if (n > (this.next.get(dest) ?? 0)) {
      this.next.set(dest, n);
      this.save();
    }
  }

  nextOf(dest: string): number | undefined {
    return this.next.get(dest);
  }

  save(): void {
    if (!this.ready) return;
    if (this.logIno === undefined && this.logPath) {
      try {
        this.logIno = statSync(this.logPath).ino; // the log appeared after startup
      } catch {
        /* still absent */
      }
    }
    const list = this.host.clientList();
    const live = new Set(list.map((c) => c.dest));
    for (const d of [...this.next.keys()]) if (!live.has(d)) this.next.delete(d);
    const clients: PersistedClient[] = list.map((c) => {
      const n = this.next.get(c.dest);
      return { ip: c.ip, port: c.port, user: c.user, ...(n !== undefined ? { next: n } : {}) };
    });
    saveState(this.path, { version: 1, savedAt: this.now(), logIno: this.logIno, clients });
  }

  /** Startup finished: from now on every change is persisted, and `savedAt` is refreshed every 10 s. */
  markReady(): void {
    this.ready = true;
    this.save();
    this.timer = setInterval(() => this.save(), SAVE_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Log rotated/truncated: numbering restarts, so every resume point is void. */
  resetProgress(): void {
    this.next.clear();
    this.epochGame.clear();
    this.save();
  }

  close(flush: boolean): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (flush) this.save();
  }
}

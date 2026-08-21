import { logger } from '../util/logger.js';

type RawSend = (payload: string, dest: string) => void;
type GetClients = () => string[];

interface QueueItem {
  msg: string;
  /** Single client dest (`ip:port`) to deliver to, or null to broadcast to all. */
  target: string | null;
  /** Fires once this item is delivered (all targets ACKed) or gives up after maxTries. */
  onComplete?: () => void;
}

interface InFlight {
  id: number;
  msg: string;
  targets: string[];
  acked: Set<string>;
  tries: number;
  onComplete?: () => void;
}

export interface ReliableOptions {
  retransmitMs: number;
  maxTries: number;
}

const DEFAULTS: ReliableOptions = { retransmitMs: 750, maxTries: 4 };

/**
 * Stop-and-wait sender for the ID-wrapped (reliable) channel.
 *
 * node-tlcv (udp-transport.ts) ACKs `<NNN>MSG` with `ACK: NNN` and DROPS any id
 * less than the last it saw. So reliable messages must ship one at a time, in
 * strictly increasing id order: we never assign the next id until the current
 * message is ACKed by all its targets (or times out). Reliable traffic is only
 * ~3 messages per move, so the throughput cost is irrelevant; high-frequency PV
 * and clock updates use the unwrapped channel and never pass through here.
 */
export class ReliableSender {
  private id = 0;
  private queue: QueueItem[] = [];
  private inFlight: InFlight | null = null;
  private timer: NodeJS.Timeout | null = null;
  private opts: ReliableOptions;

  constructor(
    private rawSend: RawSend,
    private getClients: GetClients,
    opts: Partial<ReliableOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Queue a reliable message. `target` null = broadcast to all current clients. */
  enqueue(msg: string, target: string | null = null, onComplete?: () => void): void {
    this.queue.push({ msg, target, onComplete });
    this.pump();
  }

  ack(id: number, dest: string): void {
    if (!this.inFlight || this.inFlight.id !== id) return;
    this.inFlight.acked.add(dest);
    if (this.inFlight.targets.every((t) => this.inFlight!.acked.has(t))) {
      this.complete();
    }
  }

  close(): void {
    this.clearTimer();
    this.queue = [];
    this.inFlight = null;
  }

  private pump(): void {
    if (this.inFlight || this.queue.length === 0) return;

    const item = this.queue.shift()!;
    const targets = item.target ? [item.target] : this.getClients();
    this.id += 1;

    if (targets.length === 0) {
      // No one to deliver to — the id is consumed (kept monotonic) and we move on.
      logger.debug(`Reliable msg <${this.id}> dropped (no clients): ${item.msg}`);
      item.onComplete?.();
      this.pump();
      return;
    }

    this.inFlight = { id: this.id, msg: item.msg, targets, acked: new Set(), tries: 1, onComplete: item.onComplete };
    const payload = `<${this.id}>${item.msg}`;
    for (const dest of targets) this.rawSend(payload, dest);
    this.armTimer();
  }

  private onTimeout(): void {
    if (!this.inFlight) return;

    if (this.inFlight.tries >= this.opts.maxTries) {
      logger.warn(`Reliable msg <${this.inFlight.id}> unacked after ${this.inFlight.tries} tries; advancing`);
      this.complete();
      return;
    }

    this.inFlight.tries += 1;
    const payload = `<${this.inFlight.id}>${this.inFlight.msg}`;
    for (const dest of this.inFlight.targets) {
      if (!this.inFlight.acked.has(dest)) this.rawSend(payload, dest);
    }
    this.armTimer();
  }

  private complete(): void {
    this.clearTimer();
    const done = this.inFlight?.onComplete;
    this.inFlight = null;
    done?.();
    this.pump();
  }

  private armTimer(): void {
    this.clearTimer();
    this.timer = setTimeout(() => this.onTimeout(), this.opts.retransmitMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// Inbound (client -> server) numbered-message helpers.

/** `<42>PING` or `< 42>PING` → { id: 42, body: 'PING' }. Ids start at 1. */
export function parseNumbered(raw: string): { id: number; body: string } | null {
  const m = /^<\s*(\d+)\s*>([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const id = Number(m[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { id, body: m[2] };
}

/** `ACK: 42`, `ACK:42`, `ACK:   42` → 42. */
export function parseAck(body: string): number | null {
  const m = /^ACK:\s*(\d+)/.exec(body);
  return m ? Number(m[1]) : null;
}

/** Per-source ring of the last N inbound ids, to drop retransmitted duplicates. */
export class InboundDeduper {
  private seen = new Map<string, { set: Set<number>; order: number[] }>();

  constructor(private readonly ringSize = 256) {}

  /** True if `id` was already seen from `key`; otherwise records it and returns false. */
  isDuplicate(key: string, id: number): boolean {
    let e = this.seen.get(key);
    if (!e) {
      e = { set: new Set(), order: [] };
      this.seen.set(key, e);
    }
    if (e.set.has(id)) return true;
    e.set.add(id);
    e.order.push(id);
    if (e.order.length > this.ringSize) e.set.delete(e.order.shift()!);
    return false;
  }

  /** Forget a source (a LOGONv15 means a restarted desktop client restarts its counter). */
  reset(key: string): void {
    this.seen.delete(key);
  }
}

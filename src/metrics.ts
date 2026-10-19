import http from 'node:http';
import { logger } from './util/logger.js';

type Labels = Record<string, string>;
interface Def {
  help: string;
  seed?: Labels[];
}

export const DEFS = {
  tlcs_retransmits_total: { help: 'Datagram retransmissions to clients.' },
  tlcs_giveups_total: {
    help: 'Items given up on after the give-up timeout, by kind.',
    seed: [{ kind: 'game' }, { kind: 'control' }, { kind: 'critical' }],
  },
  tlcs_resyncs_total: {
    help: 'Replay resyncs: full (logon/restore) or giveup (game replay after a give-up).',
    seed: [{ kind: 'full' }, { kind: 'giveup' }],
  },
  tlcs_coalesces_total: { help: 'Queued game epochs coalesced to a shorter replay.' },
  tlcs_stalls_total: { help: 'Client stall episodes (no ACK progress).' },
  tlcs_messages_sent_total: { help: 'Datagrams sent, by message type.' },
  tlcs_messages_received_total: { help: 'Datagrams received, by message type.' },
} satisfies Record<string, Def>;

/** Counters whose only series is the unlabelled one start at 0. */
const UNLABELLED = new Set<string>(['tlcs_retransmits_total', 'tlcs_coalesces_total', 'tlcs_stalls_total']);

export type MetricsSource = { clientList(): { dest: string }[]; queueDepth(dest: string): number };
type Gauge = { name: string; help: string; samples: Array<[Labels, number]> };

const escapeValue = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

function labelKey(labels: Labels): string {
  const ks = Object.keys(labels).sort();
  if (ks.length === 0) return '';
  return `{${ks.map((k) => `${k}="${escapeValue(labels[k])}"`).join(',')}}`;
}

export class Metrics {
  private values = new Map<string, Map<string, number>>();

  constructor() {
    for (const [name, def] of Object.entries(DEFS) as Array<[string, Def]>) {
      const m = new Map<string, number>();
      for (const s of def.seed ?? []) m.set(labelKey(s), 0);
      if (UNLABELLED.has(name)) m.set('', 0);
      this.values.set(name, m);
    }
  }

  inc(name: keyof typeof DEFS, labels: Labels = {}, by = 1): void {
    const m = this.values.get(name)!;
    const k = labelKey(labels);
    m.set(k, (m.get(k) ?? 0) + by);
  }

  get(name: keyof typeof DEFS, labels: Labels = {}): number {
    return this.values.get(name)!.get(labelKey(labels)) ?? 0;
  }

  render(gauges: Gauge[] = []): string {
    const out: string[] = [];
    for (const g of gauges) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      for (const [l, v] of g.samples) out.push(`${g.name}${labelKey(l)} ${v}`);
    }
    for (const [name, def] of Object.entries(DEFS) as Array<[string, Def]>) {
      out.push(`# HELP ${name} ${def.help}`, `# TYPE ${name} counter`);
      for (const [k, v] of this.values.get(name)!) out.push(`${name}${k} ${v}`);
    }
    return out.join('\n') + '\n';
  }
}

export const metrics = new Metrics();

/** Server-generated bodies: optional `^<n>` frame prefix, then the leading word. */
export function sentType(payload: string): string {
  const m = /^[A-Za-z]+/.exec(payload.replace(/^<\d+>/, ''));
  return m ? m[0] : 'other';
}

const RECEIVED = new Set([
  'LOGONv15', 'LOGON', 'LOGOFF', 'PING', 'CHAT', 'RESULTTABLE', 'GAMELIST', 'ACK', 'ADMIN',
  'CHANGE', 'VOTE', 'EMAIL', 'SEND', 'SECURITY', 'BOOT', 'SRBOOT',
]);

/** Client-controlled input: allowlisted so a client cannot inflate label cardinality. */
export function receivedType(msg: string): string {
  const m = /^[A-Za-z0-9]+/.exec(msg.replace(/^<\s*\d+\s*>/, ''));
  return m && RECEIVED.has(m[0]) ? m[0] : 'other';
}

function gauges(source: MetricsSource): Gauge[] {
  const clients = source.clientList();
  return [
    { name: 'tlcs_clients', help: 'Connected clients.', samples: [[{}, clients.length]] },
    {
      name: 'tlcs_client_queue_depth',
      help: 'Queued outbound items per live client.',
      samples: clients.map((c) => [{ dest: c.dest }, source.queueDepth(c.dest)] as [Labels, number]),
    },
  ];
}

export function startMetricsServer(port: number, host: string, source: MetricsSource): http.Server {
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.split('?')[0] === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metrics.render(gauges(source)));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  srv.on('error', (e) => {
    logger.error(`metrics server: ${e.message}`);
    process.exit(1);
  });
  srv.listen(port, host, () => logger.info(`metrics on http://${host}:${port}/metrics`));
  return srv;
}

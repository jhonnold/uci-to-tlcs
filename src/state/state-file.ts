import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { logger } from '../util/logger.js';

export interface PersistedClient {
  ip: string;
  port: number;
  user: string;
  /** Number of the oldest game this client has not fully ACKed (resume point). */
  next?: number;
}

export interface PersistedState {
  version: 1;
  savedAt: number;
  /** Inode of the tailed log when saved (a different inode invalidates every `next`). */
  logIno?: number;
  clients: PersistedClient[];
}

export const STATE_MAX_AGE_MS = 600_000;

let lastSaveError = '';

/** Atomic (write tmp + rename), synchronous, never throws. No fsync: SIGKILL-safe, not power-loss-safe. */
export function saveState(path: string, s: PersistedState): void {
  try {
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(s) + '\n');
    renameSync(tmp, path);
    lastSaveError = '';
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    if (m !== lastSaveError) logger.warn(`state: cannot write ${path}: ${m}`);
    lastSaveError = m;
  }
}

/** Parsed state, or null (after one log line saying why) when absent, corrupt, unknown-version or stale. */
export function loadState(
  path: string,
  now = Date.now(),
  maxAgeMs = STATE_MAX_AGE_MS,
): { clients: PersistedClient[]; logIno?: number } | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') logger.info(`state: no state file ${path}; clients will re-LOGON`);
    else logger.warn(`state: ignoring ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch (err) {
    logger.warn(`state: ignoring ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const o = j as Partial<PersistedState> | null;
  if (!o || typeof o !== 'object' || o.version !== 1 || typeof o.savedAt !== 'number' || !Array.isArray(o.clients)) {
    logger.warn(`state: ignoring ${path}: unrecognised format`);
    return null;
  }
  if (now - o.savedAt > maxAgeMs) {
    logger.info(`state: ignoring ${path}: stale (${Math.round((now - o.savedAt) / 1000)}s old)`);
    return null;
  }
  const clients: PersistedClient[] = [];
  for (const c of o.clients as unknown[]) {
    const x = c as Partial<PersistedClient> | null;
    if (
      x && typeof x.ip === 'string' && x.ip && Number.isInteger(x.port) && x.port! >= 1 && x.port! <= 65535 &&
      typeof x.user === 'string' && (x.next === undefined || (Number.isInteger(x.next) && x.next > 0))
    ) {
      clients.push({ ip: x.ip, port: x.port!, user: x.user, ...(x.next !== undefined ? { next: x.next } : {}) });
    } else {
      logger.warn(`state: skipping invalid client entry ${JSON.stringify(c)}`);
    }
  }
  return { clients, logIno: typeof o.logIno === 'number' ? o.logIno : undefined };
}

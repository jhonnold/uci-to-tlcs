import { closeSync, existsSync, openSync, readdirSync, readSync, renameSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ByteLineReader } from '../results/line-reader.js';
import { GameSegmenter } from '../results/segmenter.js';
import { makeSource, type Format, type LogSource } from '../source/index.js';
import { parseLine } from '../uci/parser.js';
import { logger } from '../util/logger.js';

const POLL_MS = 1000;
const COPY_CHUNK = 1024 * 1024;

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '_');

/**
 * SAVEDEBUG: copies each finished game's byte segment of the engine log to
 * `Debug-<white>_vs_<black>-<n>.log`. A game is finished once the next game start is seen or
 * the PGN registry lists it. Idempotent (a game number that already has a file is skipped),
 * so a restart backfills without duplicates.
 */
export class DebugLogSaver {
  private reader!: ByteLineReader;
  private source!: LogSource;
  private seg!: GameSegmenter;
  private starts: number[] = [];
  private names = new Map<number, { white: string; black: string }>();
  private have = new Set<number>();
  private saved = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logPath: string,
    private readonly format: Format,
    private readonly dir: string,
    private readonly registry?: { finishedCount(): number; lookup(n: number): { white: string; black: string } | undefined },
    private readonly seed?: { starts: number[]; end: number },
  ) {
    this.reset(true);
  }

  start(): void {
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private reset(seeded: boolean): void {
    const K = seeded && this.seed ? this.seed.starts.length : 0;
    this.starts = seeded && this.seed ? this.seed.starts.slice() : [];
    this.reader = new ByteLineReader(this.logPath, undefined, K > 1 ? this.starts[K - 1] : 0);
    this.source = makeSource(this.format);
    this.seg = new GameSegmenter();
    this.names.clear();
    this.saved = 0;
    this.have.clear();
    try {
      for (const f of readdirSync(this.dir)) {
        const m = /^Debug-.*-(\d+)\.log$/.exec(f);
        if (m) this.have.add(Number(m[1]));
      }
    } catch {
      /* dir missing: nothing exists yet */
    }
  }

  poll(): void {
    const res = this.reader.readAvailable((line, off) => {
      const n = this.source.normalize(line);
      if (!n || n.direction !== 'in' || !n.uci) return;
      if (n.uci.trim() === 'ucinewgame') {
        if (this.seg.onUciNewGame(n.engineId) && (this.starts.length === 0 || off > this.starts[this.starts.length - 1])) {
          this.starts.push(off);
        }
      } else if (parseLine(n.uci)?.type === 'go') this.seg.onGo(n.engineId);
      const b = this.seg.bound();
      if (b && this.starts.length > 0) this.names.set(this.starts.length, b);
    });
    if (res === 'truncated') {
      this.reset(false);
      return;
    }
    for (;;) {
      const n = this.saved + 1;
      let end: number;
      if (this.starts[n] !== undefined) end = this.starts[n];
      else if (this.registry && this.registry.finishedCount() >= n && this.starts[n - 1] !== undefined) end = this.reader.lineEnd;
      else break;
      const begin = n === 1 ? 0 : this.starts[n - 1];
      if (begin === undefined) break;
      if (!this.have.has(n)) this.write(n, begin, end);
      this.saved = n;
    }
  }

  private write(n: number, begin: number, end: number): void {
    const e = this.registry?.lookup(n);
    const nm = this.names.get(n);
    const w = sanitize(e?.white ?? nm?.white ?? 'unknown');
    const b = sanitize(e?.black ?? nm?.black ?? 'unknown');
    const file = join(this.dir, `Debug-${w}_vs_${b}-${n}.log`);
    if (existsSync(file)) {
      this.have.add(n);
      return;
    }
    const tmp = file + '.tmp';
    try {
      const inFd = openSync(this.logPath, 'r');
      const outFd = openSync(tmp, 'w');
      try {
        const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK, Math.max(1, end - begin)));
        for (let pos = begin; pos < end; ) {
          const len = readSync(inFd, buf, 0, Math.min(buf.length, end - pos), pos);
          if (len <= 0) break;
          writeSync(outFd, buf, 0, len);
          pos += len;
        }
      } finally {
        closeSync(inFd);
        closeSync(outFd);
      }
      renameSync(tmp, file);
      this.have.add(n);
      logger.info(`debug: wrote ${file} (${end - begin} B)`);
    } catch (err) {
      logger.warn(`debug: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

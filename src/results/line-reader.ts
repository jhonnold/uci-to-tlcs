import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export type LineHandler = (line: string, byteOffset: number) => void;

/**
 * Synchronous, byte-exact incremental line reader. Reads fixed-size chunks into a
 * Buffer and splits on byte 0x0A, so offsets are real file byte offsets and a
 * multi-byte UTF-8 character split across chunks is never decoded half-way (only
 * complete lines are decoded). One trailing 0x0D is stripped (CRLF).
 *
 * The fd is opened and closed inside each call: no lifecycle to manage, and a
 * missing file is a no-op.
 */
export class ByteLineReader {
  private consumed = 0; // bytes read from the file so far (== offset of next read)
  private carry: Buffer = Buffer.alloc(0); // partial last line
  private readonly chunk: Buffer;

  constructor(
    private readonly path: string,
    private readonly chunkSize = 64 * 1024,
  ) {
    this.chunk = Buffer.allocUnsafe(chunkSize);
  }

  /** Bytes consumed (read into lines or the carry). */
  get offset(): number {
    return this.consumed;
  }

  /** File offset just past the last complete line. */
  get lineEnd(): number {
    return this.consumed - this.carry.length;
  }

  /**
   * Deliver every newly completed line. Returns `'truncated'` (after clearing state
   * and delivering nothing) if the file shrank; the caller resets its own state and
   * calls again to re-read from 0.
   */
  readAvailable(onLine: LineHandler, prefilter?: (raw: Buffer) => boolean): 'truncated' | void {
    let fd: number;
    try {
      fd = openSync(this.path, 'r');
    } catch {
      return; // ENOENT etc.: nothing to read yet
    }
    try {
      const size = fstatSync(fd).size;
      if (size < this.consumed) {
        this.consumed = 0;
        this.carry = Buffer.alloc(0);
        return 'truncated';
      }
      while (this.consumed < size) {
        const n = readSync(fd, this.chunk, 0, Math.min(this.chunkSize, size - this.consumed), this.consumed);
        if (n <= 0) break;
        const carryStart = this.consumed - this.carry.length;
        const buf = this.carry.length ? Buffer.concat([this.carry, this.chunk.subarray(0, n)]) : this.chunk.subarray(0, n);
        this.consumed += n;
        let start = 0;
        for (;;) {
          const nl = buf.indexOf(0x0a, start);
          if (nl < 0) break;
          let end = nl;
          if (end > start && buf[end - 1] === 0x0d) end--;
          const raw = buf.subarray(start, end);
          if (!prefilter || prefilter(raw)) onLine(raw.toString('utf8'), carryStart + start);
          start = nl + 1;
        }
        // copy: `buf` may alias the reusable chunk buffer
        this.carry = Buffer.from(buf.subarray(start));
      }
    } finally {
      closeSync(fd);
    }
  }
}

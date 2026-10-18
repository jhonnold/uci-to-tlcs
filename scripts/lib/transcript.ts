import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

export interface TranscriptRecord {
  ts: string;
  t: number;
  mode: string;
  user: string;
  session: number;
  dir: 'in' | 'out' | 'event';
  raw?: string;
  body?: string;
  id?: number;
  verdict?: string;
  event?: string;
  reason?: string;
}

/** Synchronous JSONL writer so a kill never loses buffered lines. */
export class TranscriptWriter {
  constructor(private readonly file: string | undefined) {
    if (file) writeFileSync(file, '');
  }
  write(rec: TranscriptRecord): void {
    if (this.file) appendFileSync(this.file, JSON.stringify(rec) + '\n');
  }
}

export function readTranscript(file: string): TranscriptRecord[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TranscriptRecord);
}

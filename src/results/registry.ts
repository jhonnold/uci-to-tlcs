import { PgnFileReader } from './pgn-reader.js';
import type { PgnGame } from './pgn-parser.js';

/** One finished game from the tournament PGN; `number` is 1-based file order. */
export interface FinishedGame extends PgnGame {
  number: number;
}

/** Ordered registry of finished games, fed by the tournament PGN. */
export class GameRegistry {
  games: FinishedGame[] = [];
  private readonly reader: PgnFileReader;

  constructor(path: string, chunkSize?: number) {
    this.reader = new PgnFileReader(path, chunkSize);
  }

  finishedCount(): number {
    return this.games.length;
  }

  /** 1-based; a pure read. */
  lookup(n: number): FinishedGame | undefined {
    return this.games[n - 1];
  }

  refresh(): void {
    const { added, reset } = this.reader.refresh();
    if (reset) this.games = [];
    for (const g of added) this.games.push({ ...g, number: this.games.length + 1 });
  }

  startPolling(onTick: () => void, ms = 200): void {
    this.reader.startPolling(onTick, ms, () => this.refresh());
  }

  close(): void {
    this.reader.close();
  }
}

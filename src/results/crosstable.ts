// Renders the TLCS results table (CT) and game list (GL) from finished games.
// The CT layout is what node-tlcv's result-parser reads positionally (see docs/tlcs-wire.md).

export interface ResultGame {
  number: number;
  white: string;
  black: string;
  result: string;
}

export interface Standing {
  name: string;
  games: number;
  points: number;
  /** Results against each opponent, from this player's view, in game order. */
  h2h: Map<string, string>;
}

const DECIDED: Record<string, number> = { '1-0': 1, '0-1': 0, '1/2-1/2': 0.5 };

/** Display name: a run of 3+ spaces would break node-tlcv's game-row split. */
export function clean(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/** Players sorted by points descending, then name ascending. Only decided games count. */
export function standings(games: readonly ResultGame[]): Standing[] {
  const byName = new Map<string, Standing>();
  const get = (raw: string): Standing => {
    const name = clean(raw);
    let s = byName.get(name);
    if (!s) byName.set(name, (s = { name, games: 0, points: 0, h2h: new Map() }));
    return s;
  };
  for (const g of games) {
    const w = get(g.white);
    const b = get(g.black);
    const wp = DECIDED[g.result];
    if (wp === undefined) continue;
    w.games++;
    b.games++;
    w.points += wp;
    b.points += 1 - wp;
    const cell = (p: number) => (p === 1 ? '1' : p === 0 ? '0' : '=');
    w.h2h.set(b.name, (w.h2h.get(b.name) ?? '') + cell(wp));
    b.h2h.set(w.name, (b.h2h.get(w.name) ?? '') + cell(1 - wp));
  }
  return [...byName.values()].sort((a, b) => b.points - a.points || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** CT bodies (no `CT:` prefix). Game section is newest first, at most `recent` rows. */
export function renderCrosstable(games: readonly ResultGame[], recent = 300): string[] {
  const sorted = standings(games);
  const total = games.filter((g) => DECIDED[g.result] !== undefined).length;
  const RW = 5;
  const maxName = sorted.reduce((m, s) => Math.max(m, s.name.length), 0);
  const NW = Math.max(6, maxName) + 2;
  const maxCell = sorted.reduce((m, s) => {
    for (const v of s.h2h.values()) m = Math.max(m, v.length);
    return m;
  }, 0);
  const CW = Math.max(2, maxCell) + 2;

  const header = (
    'RANK ' + 'ENGINE'.padEnd(NW) + 'GAMES  ' + 'POINTS  ' + sorted.map((_, j) => String(j + 1).padEnd(CW)).join('')
  ).trimEnd();
  const out: string[] = [header, '-'.repeat(header.length)];
  sorted.forEach((s, i) => {
    const cells = sorted
      .map((o) => (o === s ? '**' : (s.h2h.get(o.name) ?? '.')).padEnd(CW))
      .join('');
    out.push(
      (
        `${i + 1}.`.padEnd(RW) + s.name.padEnd(NW) + String(s.games).padStart(5) + '  ' + s.points.toFixed(1).padStart(6) + '  ' + cells
      ).trimEnd(),
    );
  });
  out.push('', `Total games = ${total}`);
  if (games.length === 0) return out;

  const shown = (recent > 0 ? games.slice(-recent) : []).reverse();
  const maxG = shown.reduce((m, g) => Math.max(m, clean(g.white).length, clean(g.black).length), 0);
  const GNW = Math.max(5, maxG) + 3;
  const gh = 'Game No.  ' + 'White'.padEnd(GNW) + 'Black'.padEnd(GNW) + 'Result';
  out.push('', 'Most recent games played...', '-'.repeat(gh.length), gh);
  for (const g of shown) out.push(String(g.number).padEnd(10) + clean(g.white).padEnd(GNW) + clean(g.black).padEnd(GNW) + g.result);
  return out;
}

const fix = (s: string, n: number) => clean(s).slice(0, n).padEnd(n);

/** GL bodies (no `GL:` prefix), newest first: `#####` number + white(40) + black(40) + result(8). */
export function renderGameList(games: readonly ResultGame[], max = 300): string[] {
  return games
    .slice(-max)
    .reverse()
    .map((g) => String(g.number).padStart(5) + fix(g.white, 40) + fix(g.black, 40) + fix(g.result, 8));
}

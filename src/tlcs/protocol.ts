// Builders for the TLCS server->client wire messages, decoded from what node-tlcv
// accepts (src/game-service.ts). These return bare message bodies; ID-wrapping for
// the reliable channel is applied by ReliableSender.

export type ColorCode = 'w' | 'b';

/** UCI/TLCS time fields are centiseconds on the wire; convert from milliseconds. */
export function msToCs(ms: number): number {
  return Math.round(ms / 10);
}

export function site(s: string): string {
  return `SITE: ${s}`;
}

export function wplayer(name: string): string {
  return `WPLAYER: ${name}`;
}

export function bplayer(name: string): string {
  return `BPLAYER: ${name}`;
}

/** Truncated FEN: `<board> <stm> <castling>` only (node-tlcv supplies ep/clock/move#). */
export function fen(truncated: string): string {
  return `FEN: ${truncated}`;
}

export function fmr(halfmoveClock: number): string {
  return `FMR: ${halfmoveClock}`;
}

export function move(color: ColorCode, fullMoveNumber: number, san: string): string {
  const cmd = color === 'w' ? 'WMOVE' : 'BMOVE';
  const sep = color === 'w' ? '.' : '...';
  return `${cmd}: ${fullMoveNumber}${sep} ${san}`;
}

/** `WTIME: <cs> otim <opponentCs>` — node-tlcv reads the first value as this side's clock. */
export function time(color: ColorCode, cs: number, opponentCs: number): string {
  const cmd = color === 'w' ? 'WTIME' : 'BTIME';
  return `${cmd}: ${cs} otim ${opponentCs}`;
}

export function pv(
  color: ColorCode,
  depth: number,
  scoreCp: number,
  timeCs: number,
  nodes: number,
  sanPv: string[],
): string {
  const cmd = color === 'w' ? 'WPV' : 'BPV';
  return `${cmd}: ${depth} ${scoreCp} ${timeCs} ${nodes} ${sanPv.join(' ')}`.trimEnd();
}

export function result(r: string): string {
  return `result: ${r}`;
}

export function adduser(name: string): string {
  return `ADDUSER: ${name}`;
}

export function deluser(name: string): string {
  return `DELUSER: ${name}`;
}

export function chat(text: string): string {
  return `CHAT: ${text}`;
}

export function ct(line: string): string {
  return `CT: ${line}`;
}

export const CTRESET = 'CTRESET';
export const PONG = 'PONG';
export const LOGON_SUCCESSFUL = 'LOGON SUCCESSFUL';

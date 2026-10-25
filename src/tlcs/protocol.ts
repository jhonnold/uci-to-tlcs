// Builders for the TLCS server->client wire messages, decoded from what node-tlcv
// accepts (src/game-service.ts). These return bare message bodies; ID-wrapping for
// the reliable channel is applied by ReliableSender using frame() below.

import type { UciInfo } from '../uci/info.js';

export type ColorCode = 'w' | 'b';

/** UCI/TLCS time fields are centiseconds on the wire; convert from milliseconds. */
export function msToCs(ms: number): number {
  return Math.round(ms / 10);
}

/** Reliable-channel framing. NO space after `>` (deliberate deviation from the reference `< N>`). */
export function frame(id: number, body: string): string {
  return `<${id}>${body}`;
}

export function ack(id: number): string {
  return `ACK: ${id}`;
}

export function level(text: string): string {
  return `level ${text}`;
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
  pvCoords: string[],
): string {
  const cmd = color === 'w' ? 'WPV' : 'BPV';
  return `${cmd}: ${depth} ${scoreCp} ${timeCs} ${nodes} ${pvCoords.join(' ')}`.trimEnd();
}

/**
 * `WINFO: depth 33 seldepth 64 score cp 61 wdl 196 801 3 nodes … nps … hashfull 214 tbhits … time 71417 pv …`
 * — the `info depth …` search line as UCI-style `<tag> <value…>` pairs in raw UCI units
 * (ms, `score cp|mate`, engine POV), `pv` last. Tags the engine did not send are omitted.
 */
export function info(color: ColorCode, i: UciInfo, pvCoords: string[]): string {
  const cmd = color === 'w' ? 'WINFO' : 'BINFO';
  const parts = [`depth ${i.depth}`];
  if (i.seldepth !== null) parts.push(`seldepth ${i.seldepth}`);
  parts.push(`score ${i.scoreKind} ${i.scoreValue}`);
  if (i.lowerbound) parts.push('lowerbound');
  if (i.upperbound) parts.push('upperbound');
  if (i.wdl) parts.push(`wdl ${i.wdl.join(' ')}`);
  parts.push(`nodes ${i.nodes}`);
  if (i.nps !== null) parts.push(`nps ${i.nps}`);
  if (i.hashfull !== null) parts.push(`hashfull ${i.hashfull}`);
  if (i.tbhits !== null) parts.push(`tbhits ${i.tbhits}`);
  parts.push(`time ${i.timeMs}`);
  parts.push(`pv ${pvCoords.join(' ')}`);
  return `${cmd}: ${parts.join(' ')}`;
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
  return `CT:${line}`;
}

export function gl(line: string): string {
  return `GL:${line}`;
}

export const CTRESET = 'CTRESET';
export const PONG = 'PONG';
export const LOGON_SUCCESSFUL = 'LOGON SUCCESSFUL';

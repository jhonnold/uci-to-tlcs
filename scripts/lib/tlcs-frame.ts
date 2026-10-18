// Frame parsing for the two client models the mock emulates, plus the pieces of
// node-tlcv's protocol handling that the mock copies verbatim.

// ---- node-tlcv: src/transport/udp-transport.ts (keep in sync) ----
export const ID_RESTART_WINDOW = 100;

export function isIdRestart(id: number, lastMessage: number): boolean {
  if (id >= lastMessage) return false;
  // Exactly 1 is the counter's first value, so it is followed even after a short session.
  return id === 1 || (id <= ID_RESTART_WINDOW && lastMessage - id > ID_RESTART_WINDOW);
}

// ---- node-tlcv: src/protocol.ts (keep in sync) ----
export enum Command {
  FEN = 'FEN',
  WPLAYER = 'WPLAYER',
  BPLAYER = 'BPLAYER',
  WPV = 'WPV',
  BPV = 'BPV',
  WTIME = 'WTIME',
  BTIME = 'BTIME',
  WMOVE = 'WMOVE',
  BMOVE = 'BMOVE',
  SITE = 'SITE',
  CT = 'CT',
  CTRESET = 'CTRESET',
  PONG = 'PONG',
  ADDUSER = 'ADDUSER',
  DELUSER = 'DELUSER',
  CHAT = 'CHAT',
  MENU = 'MENU',
  RESULT = 'result',
  FMR = 'FMR',
  LOGON = 'LOGON',
  FEATURE = 'FEATURE',
  LEVEL = 'level',
  MSG = 'MSG',
}

const KNOWN_COMMANDS = new Set<string>(Object.values(Command));

export const PROVES_LIVENESS: Record<Command, boolean> = {
  [Command.FEN]: true,
  [Command.WPLAYER]: true,
  [Command.BPLAYER]: true,
  [Command.WPV]: true,
  [Command.BPV]: true,
  [Command.WTIME]: true,
  [Command.BTIME]: true,
  [Command.WMOVE]: true,
  [Command.BMOVE]: true,
  [Command.SITE]: true,
  [Command.CT]: true,
  [Command.CTRESET]: true,
  [Command.CHAT]: true,
  [Command.RESULT]: true,
  [Command.FMR]: true,
  [Command.PONG]: false,
  [Command.MSG]: false,
  [Command.LOGON]: false,
  [Command.FEATURE]: false,
  [Command.LEVEL]: false,
  [Command.MENU]: false,
  [Command.ADDUSER]: false,
  [Command.DELUSER]: false,
};

export function splitOnCommand(line: string): [Command, string] | null {
  const semiIdx = line.indexOf(':');
  const spaceIdx = line.indexOf(' ');
  let argSplit = semiIdx;
  if (semiIdx < 0) argSplit = spaceIdx;
  else if (spaceIdx >= 0) argSplit = Math.min(semiIdx, spaceIdx);

  const command = argSplit < 0 ? line : line.substring(0, argSplit);
  if (!KNOWN_COMMANDS.has(command)) return null;
  return [command as Command, argSplit < 0 ? '' : line.substring(argSplit + 1).trim()];
}

/** True when the body is a command that node-tlcv counts as live broadcast data. */
export function isLive(body: string): boolean {
  const sp = splitOnCommand(body);
  return sp !== null && PROVES_LIVENESS[sp[0]];
}

// ---- framing ----
export interface Frame {
  numbered: boolean;
  /** node-tlcv: the text between `<` and `>` (may carry a space). */
  idString?: string;
  id?: number;
  body: string;
}

/** node-tlcv view: trim, then `<id>body`. */
export function parseNodeTlcv(raw: string): Frame {
  const s = raw.trim();
  if (!s.startsWith('<')) return { numbered: false, body: s };
  const [idString, ...rest] = s.substring(1).split('>');
  return { numbered: true, idString, id: parseInt(idString), body: rest.join('>') };
}

/** VB Val(): skip leading spaces, parse leading digits, empty gives 0. */
export function vbVal(s: string): number {
  const m = /^\s*(\d+)/.exec(s);
  return m ? parseInt(m[1], 10) : 0;
}

/** VB Mid(s, n): 1-based substring from n. */
export function mid(s: string, n: number): string {
  return s.slice(n - 1);
}

/** Desktop TLCV view: untrimmed, fixed positions; numbered only when Val(id) > 0. */
export function parseDesktop(raw: string): Frame {
  if (raw[0] === '<') {
    const p = raw.indexOf('>', 1);
    if (p >= 1) {
      const id = vbVal(raw.slice(1, p));
      if (id > 0) return { numbered: true, id, idString: raw.slice(1, p), body: raw.slice(p + 1) };
    }
  }
  return { numbered: false, body: raw };
}

export function parseResultBody(body: string): string | null {
  const m = /^result:?\s*(\S+)/.exec(body);
  return m ? m[1] : null;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold = ORDER[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info;

function log(level: Level, msg: string): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string) => log('debug', msg),
  info: (msg: string) => log('info', msg),
  warn: (msg: string) => log('warn', msg),
  error: (msg: string) => log('error', msg),
};

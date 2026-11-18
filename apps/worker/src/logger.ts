/**
 * Structured logs (CLAUDE.md §5): one JSON object per line, with the job id as correlation id.
 * Callers never pass prompts, completions, briefs or credentials.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

export interface Logger {
  log(level: LogLevel, msg: string, fields?: LogFields): void;
}

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(minimum: LogLevel, json: boolean): Logger {
  return {
    log(level, msg, fields = {}) {
      if (ORDER[level] < ORDER[minimum]) return;
      const entry = { time: new Date().toISOString(), level, msg, service: 'worker', ...fields };
      const line = json
        ? JSON.stringify(entry)
        : `${entry.time} ${level.toUpperCase()} ${msg} ${JSON.stringify(fields)}`;
      if (level === 'error' || level === 'warn') console.error(line);
      else console.info(line);
    },
  };
}

/** A logger that discards everything (tests). */
export const silentLogger: Logger = { log: () => undefined };

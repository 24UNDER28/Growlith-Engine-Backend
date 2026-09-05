import 'server-only';

import { redactSecrets } from '@/server/logging/redaction';

/**
 * Structured logger.
 *
 * No logging library is added (Rule 17): the requirement is one-line JSON on
 * stdout with a level filter and mandatory redaction, which is ~100 lines here
 * and avoids a dependency in the hottest path of every request. If distributed
 * tracing becomes a requirement, the OpenTelemetry integration point is the
 * `fields` object below, not a rewrite.
 *
 * DESIGN DECISION — this module must not import `src/server/env.ts`.
 * The logger reads `LOG_LEVEL` directly from `process.env`. If it went through
 * the validated env contract, a missing `SUPABASE_SERVICE_ROLE_KEY` would throw
 * while trying to log the warning about that same missing key, and the operator
 * would lose the one diagnostic that explains the failure. A logging system
 * that depends on the thing it reports on is not observable (ADR-0023).
 *
 * Output contract: exactly one JSON object per line on stdout (`debug`/`info`)
 * or stderr (`warn`/`error`), always containing `time`, `level` and `msg`.
 * Single-line JSON is what makes the logs ingestible by any collector without a
 * multi-line reassembly rule.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_SEVERITY: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Arbitrary structured context attached to a log line. */
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derive a logger that carries extra context on every line. */
  child(fields: LogFields): Logger;
}

const DEFAULT_LEVEL: LogLevel = 'info';

/**
 * Resolve the active level.
 *
 * An unrecognised value falls back to `info` rather than throwing: logging
 * configuration must never be able to take the process down.
 */
function resolveLogLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL;
  if (raw !== undefined && (LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return DEFAULT_LEVEL;
}

function shouldLog(active: LogLevel, candidate: Exclude<LogLevel, 'silent'>): boolean {
  if (active === 'silent') {
    return false;
  }
  return LEVEL_SEVERITY[candidate] >= LEVEL_SEVERITY[active];
}

function emit(
  level: Exclude<LogLevel, 'silent'>,
  message: string,
  context: LogFields | undefined,
  fields: LogFields | undefined,
): void {
  const record: Record<string, unknown> = {
    time: new Date().toISOString(),
    level,
    msg: message,
    ...(redactSecrets(context ?? {}) as Record<string, unknown>),
    ...(redactSecrets(fields ?? {}) as Record<string, unknown>),
  };

  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // JSON.stringify throws on a BigInt or on a structure the redactor could not
    // normalise. Losing the diagnostic entirely would be worse than losing the
    // fields, so degrade to a line that still carries the message and level.
    line = JSON.stringify({
      time: record.time,
      level,
      msg: message,
      serializationError: 'fields could not be serialized',
    });
  }

  if (level === 'error' || level === 'warn') {
    console.error(line);
    return;
  }
  console.info(line);
}

/**
 * Create a logger.
 *
 * @param context fields attached to every line emitted by this logger and by
 *                any logger derived from it via `child()`. Typically
 *                `{ requestId, route }` or `{ scope: 'env' }`.
 */
export function createLogger(context: LogFields = {}): Logger {
  const build =
    (level: Exclude<LogLevel, 'silent'>) =>
    (message: string, fields?: LogFields): void => {
      if (!shouldLog(resolveLogLevel(), level)) {
        return;
      }
      emit(level, message, context, fields);
    };

  return {
    debug: build('debug'),
    info: build('info'),
    warn: build('warn'),
    error: build('error'),
    child(fields: LogFields): Logger {
      return createLogger({ ...context, ...fields });
    },
  };
}

/** A logger with no request context, for boot-time and background work. */
export function getRootLogger(): Logger {
  return createLogger({ scope: 'root' });
}

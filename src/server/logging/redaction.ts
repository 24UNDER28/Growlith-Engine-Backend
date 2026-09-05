import 'server-only';

/**
 * Log redaction.
 *
 * This module is the reason the repository can forbid raw `console.*` calls
 * (see the `growlith/no-raw-console` ESLint block): every field written by the
 * structured logger passes through `redactSecrets` first, so a credential cannot
 * reach stdout just because someone logged a request object.
 *
 * Two independent mechanisms are applied, because either one alone is
 * insufficient:
 *
 * 1. **Key-based** — a field whose *name* looks sensitive is replaced wholesale.
 *    Catches `authorization`, `cookie`, `serviceRoleKey`.
 * 2. **Value-based** — a string whose *shape* is a credential is replaced even
 *    when it is stored under an innocuous key such as `payload` or `headers`.
 *    Catches a JWT logged as part of a request dump, which key-matching misses
 *    entirely.
 */

/** Field names that are replaced wholesale, whatever their value. */
const SENSITIVE_KEY =
  /(pass(?:word|wd)|secret|token|jwt|authorization|auth[_-]?header|cookie|session|api[_-]?key|access[_-]?key|private[_-]?key|service[_-]?role|refresh[_-]?token|credit[_-]?card|cvv)/i;

/** Field names whose values are personal data and are therefore partially masked. */
const PII_KEY = /^(email|e_?mail|phone|telephone|msisdn)$/i;

/** A JWT: three base64url segments, the first starting with `eyJ` (`{`). */
const JWT_SHAPE = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}$/;

/** Supabase secret keys (`sb_secret_…`) and legacy `service_role` JWTs. */
const SUPABASE_SECRET_SHAPE = /^sb_secret_[A-Za-z0-9_-]{8,}$/;

/** A PostgreSQL connection string, which embeds a password. */
const CONNECTION_STRING_SHAPE = /^(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/\S+$/i;

const REDACTED = '[REDACTED]';

/**
 * Guards against pathological input: deeply nested payloads, huge arrays and
 * cyclic references all have to survive a logging call without hanging the
 * request or throwing inside the error path.
 */
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 25;
const MAX_STRING_LENGTH = 4_000;

/**
 * Return a deep copy of `value` with credentials removed and personal data
 * masked. The input is never mutated, and cycles are preserved as a marker
 * rather than causing a stack overflow.
 */
export function redactSecrets(value: unknown): unknown {
  return redact(value, 0, new WeakSet());
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return redactString(value);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (depth >= MAX_DEPTH) {
    return '[Truncated: max depth]';
  }

  // Non-plain objects (Date, Error, Headers, …) are rendered as a short summary
  // rather than walked, because their internals are either uninteresting or
  // getter-based and expensive to enumerate.
  if (!isPlainObject(value) && !Array.isArray(value)) {
    return summarizeOpaqueObject(value);
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) {
        items.push(`[Truncated: ${value.length - MAX_ARRAY_ITEMS} more items]`);
      }
      return items;
    }

    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
      if (SENSITIVE_KEY.test(key)) {
        output[key] = REDACTED;
        continue;
      }
      if (PII_KEY.test(key)) {
        output[key] = maskPersonalData(source[key]);
        continue;
      }
      output[key] = redact(source[key], depth + 1, seen);
    }

    return output;
  } finally {
    seen.delete(value);
  }
}

function redactString(value: string): string {
  if (
    JWT_SHAPE.test(value) ||
    SUPABASE_SECRET_SHAPE.test(value) ||
    CONNECTION_STRING_SHAPE.test(value)
  ) {
    return REDACTED;
  }
  if (value.length > MAX_STRING_LENGTH) {
    return `${value.slice(0, MAX_STRING_LENGTH)}[Truncated: ${value.length - MAX_STRING_LENGTH} more chars]`;
  }
  return value;
}

/**
 * Partially mask personal data instead of removing it.
 *
 * Support genuinely needs to know *which* account an event concerns; it does not
 * need the full address. Keeping the first character and the domain preserves
 * the diagnostic value while limiting what a log store accumulates.
 */
function maskPersonalData(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    return REDACTED;
  }

  const atIndex = value.indexOf('@');
  if (atIndex > 0) {
    const domain = value.slice(atIndex + 1);
    return `${value.charAt(0)}***@${domain}`;
  }

  if (value.length <= 2) {
    return REDACTED;
  }

  return `${value.charAt(0)}***${value.charAt(value.length - 1)}`;
}

function summarizeOpaqueObject(value: object): unknown {
  if (value instanceof Error) {
    // `Error.message` is walked through the string redactor: a message built
    // from a request header can itself contain a credential. The stack is
    // dropped entirely — it is written by the error mapper instead, server-side,
    // and can embed argument values from the failing frame.
    return { name: value.name, message: redactString(value.message) };
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return `[${value.constructor?.name ?? 'Object'}]`;
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '@/server/logging/logger';
import { redactSecrets } from '@/server/logging/redaction';

/* ───────────────────────────── redaction ───────────────────────────── */

describe('redactSecrets — key-based', () => {
  const sensitiveKeys = [
    'password',
    'userPassword',
    'secret',
    'serviceRoleKey',
    'service_role_key',
    'accessToken',
    'refresh_token',
    'jwt',
    'authorization',
    'cookie',
    'sessionToken',
    'apiKey',
    'api_key',
    'privateKey',
    'creditCard',
    'cvv',
  ];

  it.each(sensitiveKeys)('replaces the value of "%s" wholesale', (key) => {
    const result = redactSecrets({ [key]: 'super-secret-value' }) as Record<string, unknown>;
    expect(result[key]).toBe('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it('redacts nested and deeply nested sensitive keys', () => {
    // Asserted against a concrete shape rather than `Record<string, …>`: with
    // `noUncheckedIndexedAccess` an index signature would make every lookup
    // `| undefined`, which obscures what is actually being verified.
    const result = redactSecrets({
      request: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sb=xyz' } },
    }) as { request: { headers: { authorization: unknown; cookie: unknown } } };

    expect(result.request.headers.authorization).toBe('[REDACTED]');
    expect(result.request.headers.cookie).toBe('[REDACTED]');
  });

  it('redacts sensitive keys inside arrays of objects', () => {
    const result = redactSecrets([{ password: 'a' }, { password: 'b' }]) as Array<
      Record<string, unknown>
    >;
    expect(result).toEqual([{ password: '[REDACTED]' }, { password: '[REDACTED]' }]);
  });

  it('leaves non-sensitive keys intact', () => {
    const result = redactSecrets({ requestId: 'abc', status: 201, tookMs: 12 }) as Record<
      string,
      unknown
    >;
    expect(result).toEqual({ requestId: 'abc', status: 201, tookMs: 12 });
  });
});

describe('redactSecrets — value-based', () => {
  // Key matching alone is insufficient: a request dump logs a JWT under an
  // innocuous key such as `payload`, and that is the realistic leak path.
  it('redacts a JWT stored under an innocuous key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnopqrstuvw';
    const result = redactSecrets({ payload: jwt }) as Record<string, unknown>;
    expect(result.payload).toBe('[REDACTED]');
  });

  it('redacts a Supabase secret key value', () => {
    const result = redactSecrets({ value: 'sb_secret_AbCdEf0123456789' }) as Record<
      string,
      unknown
    >;
    expect(result.value).toBe('[REDACTED]');
  });

  it('redacts a connection string with embedded credentials', () => {
    const result = redactSecrets({
      dsn: 'postgresql://postgres:hunter2@db.internal:5432/postgres',
    }) as Record<string, unknown>;
    expect(result.dsn).toBe('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain('hunter2');
  });

  it('leaves an ordinary string alone', () => {
    expect(redactSecrets({ note: 'deliverable approved by client' })).toEqual({
      note: 'deliverable approved by client',
    });
  });
});

describe('redactSecrets — personal data', () => {
  it('masks an email but keeps it identifiable for support', () => {
    const result = redactSecrets({ email: 'kishor@growlithacademy.com' }) as Record<
      string,
      unknown
    >;
    expect(result.email).toBe('k***@growlithacademy.com');
  });

  it('masks a phone number', () => {
    const result = redactSecrets({ phone: '+9779812345678' }) as Record<string, unknown>;
    expect(result.phone).toBe('+***8');
  });
});

describe('redactSecrets — robustness against pathological input', () => {
  it('survives a circular structure', () => {
    const cyclic: Record<string, unknown> = { name: 'a' };
    cyclic.self = cyclic;
    const result = redactSecrets(cyclic) as Record<string, unknown>;
    expect(result.self).toBe('[Circular]');
    expect(result.name).toBe('a');
  });

  it('truncates beyond the maximum depth instead of recursing forever', () => {
    let nested: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i += 1) {
      nested = { child: nested };
    }
    expect(() => redactSecrets(nested)).not.toThrow();
    expect(JSON.stringify(redactSecrets(nested))).toContain('[Truncated: max depth]');
  });

  it('caps array length so a huge payload cannot become a huge log line', () => {
    const result = redactSecrets(Array.from({ length: 500 }, (_, i) => i)) as unknown[];
    expect(result.length).toBeLessThanOrEqual(26); // 25 items + truncation marker
    expect(result[result.length - 1]).toContain('Truncated');
  });

  it('truncates an over-long string', () => {
    const result = redactSecrets('x'.repeat(10_000)) as string;
    expect(result.length).toBeLessThan(10_000);
    expect(result).toContain('[Truncated:');
  });

  it('does not mutate its input', () => {
    const input = { password: 'secret', nested: { token: 'abc' } };
    const snapshot = JSON.stringify(input);
    redactSecrets(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('renders an Error without its stack', () => {
    const result = redactSecrets(new Error('boom at /var/app/secret.ts')) as Record<
      string,
      unknown
    >;
    expect(result.name).toBe('Error');
    expect(result.message).toBe('boom at /var/app/secret.ts');
    expect('stack' in result).toBe(false);
  });

  it('renders a Date as an ISO string', () => {
    expect(redactSecrets(new Date('2026-09-05T00:00:00.000Z'))).toBe('2026-09-05T00:00:00.000Z');
  });
});

/* ───────────────────────────── logger ───────────────────────────── */
type CapturedLine = { readonly stream: 'info' | 'error'; readonly line: string };

interface ConsoleCapture {
  readonly lines: CapturedLine[];
  readonly infoCount: () => number;
  readonly errorCount: () => number;
  readonly lastInfo: () => Record<string, unknown>;
  readonly lastError: () => Record<string, unknown>;
  readonly lastRawInfo: () => string;
}

/**
 * Capture logger output.
 *
 * Types are inferred from `vi.spyOn` rather than annotated, so the helper cannot
 * drift from the installed Vitest version's mock typings.
 */
function captureConsole(): ConsoleCapture {
  const lines: CapturedLine[] = [];

  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    lines.push({ stream: 'info', line: String(args[0] ?? '') });
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push({ stream: 'error', line: String(args[0] ?? '') });
  });

  const lastFor = (stream: CapturedLine['stream']): Record<string, unknown> => {
    const matching = lines.filter((entry) => entry.stream === stream);
    const last = matching[matching.length - 1];
    expect(last, `expected at least one ${stream} line`).toBeDefined();
    return JSON.parse(last?.line ?? '{}') as Record<string, unknown>;
  };

  return {
    lines,
    infoCount: () => lines.filter((entry) => entry.stream === 'info').length,
    errorCount: () => lines.filter((entry) => entry.stream === 'error').length,
    lastInfo: () => lastFor('info'),
    lastError: () => lastFor('error'),
    lastRawInfo: () => lines.filter((entry) => entry.stream === 'info').at(-1)?.line ?? '',
  };
}

describe('createLogger', () => {
  const originalLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLevel;
    }
  });

  it('emits exactly one JSON line per call with the required contract fields', () => {
    const captured = captureConsole();
    createLogger().info('something happened');

    expect(captured.infoCount()).toBe(1);
    const record = captured.lastInfo();
    expect(record).toMatchObject({ level: 'info', msg: 'something happened' });
    expect(typeof record.time).toBe('string');
    expect(new Date(record.time as string).toISOString()).toBe(record.time);
  });

  it('routes warn and error to stderr so alerting can subscribe to the right stream', () => {
    const captured = captureConsole();
    const log = createLogger();
    log.warn('careful');
    log.error('broken');

    expect(captured.errorCount()).toBe(2);
    expect(captured.infoCount()).toBe(0);
    expect(captured.lastError()).toMatchObject({ level: 'error', msg: 'broken' });
  });

  it('carries context on every line and merges it through child()', () => {
    const captured = captureConsole();
    const log = createLogger({ requestId: 'req-1', route: 'GET /api/v1/health' });
    log.info('a');
    log.child({ organizationId: 'org-1' }).info('b');

    expect(captured.lastInfo()).toMatchObject({
      requestId: 'req-1',
      route: 'GET /api/v1/health',
      organizationId: 'org-1',
      msg: 'b',
    });
  });

  it('redacts fields before they are written', () => {
    const captured = captureConsole();
    createLogger().info('login attempt', {
      email: 'kishor@growlithacademy.com',
      password: 'hunter2',
      authorization: 'Bearer abc',
    });

    const raw = captured.lastRawInfo();
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('kishor@');
    expect(raw).toContain('k***@growlithacademy.com');
    expect(captured.lastInfo().password).toBe('[REDACTED]');
    expect(captured.lastInfo().authorization).toBe('[REDACTED]');
  });

  it('honours LOG_LEVEL=error, suppressing everything below it', () => {
    process.env.LOG_LEVEL = 'error';
    const captured = captureConsole();
    const log = createLogger();

    log.debug('d');
    log.info('i');
    log.warn('w');
    expect(captured.lines).toHaveLength(0);

    log.error('e');
    expect(captured.errorCount()).toBe(1);
  });

  it('honours LOG_LEVEL=warn, admitting warn and error but not info', () => {
    process.env.LOG_LEVEL = 'warn';
    const captured = captureConsole();
    const log = createLogger();

    log.debug('d');
    log.info('i');
    expect(captured.lines).toHaveLength(0);

    log.warn('w');
    log.error('e');
    expect(captured.errorCount()).toBe(2);
    expect(captured.infoCount()).toBe(0);
  });

  it('admits debug only when LOG_LEVEL=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    const captured = captureConsole();
    createLogger().debug('d');
    expect(captured.infoCount()).toBe(1);
  });

  it('supports a silent level for tests and tooling', () => {
    process.env.LOG_LEVEL = 'silent';
    const captured = captureConsole();
    const log = createLogger();
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(captured.lines).toHaveLength(0);
  });

  it('falls back to a valid line when a field cannot be serialized', () => {
    const captured = captureConsole();
    // JSON.stringify throws on BigInt. Losing the whole diagnostic would be
    // worse than losing the fields, so the logger must degrade, not crash.
    expect(() => createLogger().info('bigint', { value: BigInt(10) })).not.toThrow();

    const record = captured.lastInfo();
    expect(record.msg).toBe('bigint');
    expect(record.serializationError).toBe('fields could not be serialized');
  });

  it('defaults to info when LOG_LEVEL is unrecognised, rather than throwing', () => {
    process.env.LOG_LEVEL = 'verbose-please';
    const captured = captureConsole();
    expect(() => createLogger().info('still works')).not.toThrow();
    expect(captured.infoCount()).toBe(1);
  });
});

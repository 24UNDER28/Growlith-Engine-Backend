import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLIENT_ENV_KEYS,
  __resetClientEnvCacheForTests,
  getClientEnv,
  inspectClientEnv,
} from '@/lib/env/client-env';
import {
  EnvironmentError,
  SERVER_ENV_KEYS,
  __resetServerEnvCacheForTests,
  getServerEnv,
  inspectServerEnv,
  reportEnvStatus,
} from '@/server/env';

/**
 * Environment contract tests.
 *
 * Two distinct properties are being verified:
 *  1. **Classification** — that the split between public and server-only
 *     variables is structurally correct, so a secret cannot be moved into the
 *     public set by accident (Rules 11–12).
 *  2. **Failure behaviour** — that a misconfigured environment fails loudly,
 *     completely and early, rather than surfacing as an unexplained 500 during a
 *     request (ADR-0023).
 */

const VALID_SERVER_ENV = {
  APP_ENV: 'development',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key-not-a-real-key',
  LOG_LEVEL: 'silent',
} as const;

const VALID_CLIENT_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test-ref.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key-not-a-real-key',
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
} as const;

const MANAGED_KEYS = [
  'APP_ENV',
  'LOG_LEVEL',
  'SUPABASE_SERVICE_ROLE_KEY',
  ...CLIENT_ENV_KEYS,
] as const;

let snapshot: Record<string, string | undefined> = {};

function applyEnv(vars: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  snapshot = {};
  for (const key of MANAGED_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
  __resetServerEnvCacheForTests();
  __resetClientEnvCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  applyEnv(snapshot);
  __resetServerEnvCacheForTests();
  __resetClientEnvCacheForTests();
});

describe('variable classification', () => {
  it('keeps the public and server-only sets disjoint', () => {
    const overlap = SERVER_ENV_KEYS.filter((key) =>
      (CLIENT_ENV_KEYS as readonly string[]).includes(key),
    );
    expect(overlap).toEqual([]);
  });

  it('prefixes every browser-exposed variable with NEXT_PUBLIC_', () => {
    // Next.js only inlines NEXT_PUBLIC_* values into the client bundle, so this
    // prefix is the actual mechanism that decides what a browser can read.
    for (const key of CLIENT_ENV_KEYS) {
      expect(key.startsWith('NEXT_PUBLIC_')).toBe(true);
    }
  });

  it('never prefixes a server-only variable with NEXT_PUBLIC_', () => {
    // The inverse is the dangerous direction: a service-role key placed in the
    // public set would be inlined into shipped JavaScript.
    for (const key of SERVER_ENV_KEYS) {
      expect(key.startsWith('NEXT_PUBLIC_')).toBe(false);
    }
  });

  it('lists SUPABASE_SERVICE_ROLE_KEY as server-only', () => {
    expect(SERVER_ENV_KEYS).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});

describe('getServerEnv', () => {
  it('parses a complete environment', () => {
    applyEnv(VALID_SERVER_ENV);
    expect(getServerEnv()).toMatchObject({
      APP_ENV: 'development',
      SUPABASE_SERVICE_ROLE_KEY: VALID_SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
    });
  });

  it('defaults APP_ENV to development rather than failing without it', () => {
    applyEnv({ SUPABASE_SERVICE_ROLE_KEY: VALID_SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY });
    expect(getServerEnv().APP_ENV).toBe('development');
  });

  it('throws an EnvironmentError naming every problem at once', () => {
    applyEnv({
      LOG_LEVEL: 'verbose', // not a member of the level enum
      // SUPABASE_SERVICE_ROLE_KEY deliberately absent
    });

    let thrown: unknown;
    try {
      getServerEnv();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvironmentError);
    const report = (thrown as EnvironmentError).report;
    expect(report).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(report).toContain('LOG_LEVEL');
  });

  it('rejects an unrecognised APP_ENV value', () => {
    applyEnv({ ...VALID_SERVER_ENV, APP_ENV: 'prod' });
    // `.catch('development')` means an invalid value degrades safely instead of
    // failing: a typo must not stop the portal from booting.
    expect(getServerEnv().APP_ENV).toBe('development');
  });

  it('ignores variables outside the contract, so unrelated shell config cannot break boot', () => {
    // The schema strips unknown keys rather than rejecting them. That matters
    // because a deployment environment legitimately carries variables this
    // application does not consume — the Supabase connection strings used by
    // Phase 2 migration tooling, for instance, live in the same shell. A
    // `.strict()` schema would make every such variable a boot failure.
    applyEnv({
      ...VALID_SERVER_ENV,
      SUPABASE_DB_URL_POOLED: 'postgresql://postgres:pw@db.pooler.supabase.com:6543/postgres',
      SUPABASE_DB_URL_DIRECT: 'postgresql://postgres:pw@db.supabase.co:5432/postgres',
      SOMETHING_ELSE_ENTIRELY: 'irrelevant',
    });

    const env = getServerEnv();
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBe(VALID_SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY);
    expect('SUPABASE_DB_URL_POOLED' in env).toBe(false);
    expect(Object.keys(env).sort()).toEqual([...SERVER_ENV_KEYS].sort());
  });

  it('memoizes the parsed result, so a request does not re-validate', () => {
    applyEnv(VALID_SERVER_ENV);
    expect(getServerEnv()).toBe(getServerEnv());
  });

  it('re-reads after the cache is reset', () => {
    applyEnv(VALID_SERVER_ENV);
    const first = getServerEnv();
    __resetServerEnvCacheForTests();
    applyEnv({ ...VALID_SERVER_ENV, APP_ENV: 'staging' });
    expect(getServerEnv()).not.toBe(first);
    expect(getServerEnv().APP_ENV).toBe('staging');
  });
});

describe('inspectServerEnv', () => {
  it('reports failure without throwing, so diagnostics stay usable', () => {
    const result = inspectServerEnv();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(EnvironmentError);
    }
  });

  it('reports success for a valid environment', () => {
    applyEnv(VALID_SERVER_ENV);
    const result = inspectServerEnv();
    expect(result.ok).toBe(true);
  });
});

describe('reportEnvStatus — boot behaviour', () => {
  it('throws in production, so a misconfigured portal never accepts traffic', () => {
    applyEnv({ APP_ENV: 'production', LOG_LEVEL: 'silent' });
    expect(() => reportEnvStatus()).toThrow(EnvironmentError);
  });

  it('warns instead of throwing outside production, keeping local dev usable', () => {
    applyEnv({ APP_ENV: 'development', LOG_LEVEL: 'warn' });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => reportEnvStatus()).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();

    const line = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(line).toContain('environment configuration incomplete');
    expect(line).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('logs success quietly when the environment is complete', () => {
    applyEnv({ ...VALID_SERVER_ENV, LOG_LEVEL: 'info' });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    expect(() => reportEnvStatus()).not.toThrow();
    expect(String(infoSpy.mock.calls[0]?.[0] ?? '')).toContain('environment configuration valid');
  });
});

describe('getClientEnv', () => {
  it('parses a complete browser environment', () => {
    applyEnv(VALID_CLIENT_ENV);
    expect(getClientEnv()).toMatchObject({
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    });
  });

  it('rejects a malformed Supabase URL rather than issuing requests to it', () => {
    applyEnv({ ...VALID_CLIENT_ENV, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' });

    let thrown: unknown;
    try {
      getClientEnv();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EnvironmentError);
    expect((thrown as EnvironmentError).report).toContain('NEXT_PUBLIC_SUPABASE_URL');
  });

  it('reports every missing browser variable at once', () => {
    const result = inspectClientEnv();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      for (const key of CLIENT_ENV_KEYS) {
        expect(result.error.report).toContain(key);
      }
    }
  });
});

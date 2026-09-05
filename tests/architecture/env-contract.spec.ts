import { describe, expect, it } from 'vitest';

import { CLIENT_ENV_KEYS } from '@/lib/env/client-env';
import { SERVER_ENV_KEYS } from '@/server/env';
import { readRepositoryFile } from '../helpers/repo';

/**
 * The environment template must not drift from the code that consumes it.
 *
 * A `.env.example` that lists a variable nothing reads teaches operators to
 * configure the wrong thing; one that omits a variable the code requires turns
 * every new environment into a debugging session. Neither failure is visible at
 * runtime, so the contract is checked here instead.
 */

interface EnvLine {
  readonly key: string;
  readonly value: string;
}

function parseEnvExample(): EnvLine[] {
  const lines = readRepositoryFile('.env.example').split('\n');
  const entries: EnvLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (match?.[1] !== undefined) {
      entries.push({ key: match[1], value: match[2] ?? '' });
    }
  }

  return entries;
}

describe('.env.example ↔ code parity', () => {
  const example = parseEnvExample();
  const exampleKeys: string[] = example.map((entry) => entry.key).sort();
  // Widened to `string[]`: the source lists are literal-union tuples, and
  // `includes` on those rejects the arbitrary strings parsed from the template.
  const declaredKeys: string[] = [...SERVER_ENV_KEYS, ...CLIENT_ENV_KEYS].sort();

  it('found variables in the template', () => {
    expect(exampleKeys.length).toBeGreaterThan(0);
  });

  it('documents every variable the code declares', () => {
    const missingFromTemplate = declaredKeys.filter((key) => !exampleKeys.includes(key));
    expect(missingFromTemplate).toEqual([]);
  });

  it('documents nothing the code does not declare', () => {
    // A variable listed here but read nowhere is speculative configuration
    // (Rule 14): it implies a capability the system does not have.
    const undocumented = exampleKeys.filter((key) => !declaredKeys.includes(key));
    expect(undocumented).toEqual([]);
  });

  it('contains no duplicate keys', () => {
    expect(new Set(exampleKeys).size).toBe(exampleKeys.length);
  });
});

describe('.env.example contains placeholders only', () => {
  const example = parseEnvExample();

  const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/;
  const SUPABASE_SECRET_SHAPE = /sb_secret_[A-Za-z0-9]{8,}/;
  const CONNECTION_STRING_SHAPE = /postgres(?:ql)?:\/\/([^:/\s]+):([^@\s]+)@/;

  it('has no JWT-shaped value (anon and service keys are JWTs)', () => {
    const offenders = example.filter((entry) => JWT_SHAPE.test(entry.value));
    expect(offenders.map((entry) => entry.key)).toEqual([]);
  });

  it('has no Supabase secret-key value', () => {
    const offenders = example.filter((entry) => SUPABASE_SECRET_SHAPE.test(entry.value));
    expect(offenders.map((entry) => entry.key)).toEqual([]);
  });

  it('marks every connection-string password as an obvious placeholder', () => {
    // Connection strings legitimately appear in the template, so the check is
    // that the embedded credential is visibly fake rather than absent.
    for (const entry of example) {
      const match = CONNECTION_STRING_SHAPE.exec(entry.value);
      if (match === null) {
        continue;
      }
      expect(match[2], `${entry.key} looks like a real database password`).toContain(
        'REPLACE_WITH',
      );
    }
  });

  it('has no empty value, so a copied template fails loudly rather than silently', () => {
    const empties = example.filter((entry) => entry.value.trim().length === 0);
    expect(empties.map((entry) => entry.key)).toEqual([]);
  });
});

describe('.gitignore protects secrets', () => {
  const ignore = readRepositoryFile('.gitignore');

  it('ignores dotenv files', () => {
    expect(ignore).toMatch(/^\.env$/m);
    expect(ignore).toMatch(/^\.env\.\*$/m);
  });

  it('re-includes only the template', () => {
    expect(ignore).toMatch(/^!\.env\.example$/m);
  });

  it('ignores Supabase local state and build output', () => {
    expect(ignore).toContain('node_modules/');
    expect(ignore).toContain('.next/');
    expect(ignore).toContain('supabase/.temp/');
  });
});

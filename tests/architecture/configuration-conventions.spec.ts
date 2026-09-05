import { describe, expect, it } from 'vitest';

import { readRepositoryFile } from '../helpers/repo';

/**
 * Configuration invariants.
 *
 * These are regression guards for decisions that are easy to undo by accident
 * and expensive to notice: turning off a strictness flag, dropping a security
 * header, weakening the lint wall, or adding a dependency. Each assertion
 * corresponds to an ADR, so a failing test points at the decision that is about
 * to be broken rather than at a symptom.
 */

interface PackageJson {
  readonly private?: boolean;
  readonly engines?: { readonly node?: string };
  readonly scripts?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(readRepositoryFile('package.json')) as PackageJson;
}

describe('dependency budget (Rule 17, ADR-0022)', () => {
  const pkg = readPackageJson();
  const runtime = Object.keys(pkg.dependencies ?? {}).sort();

  /**
   * The exact set of runtime dependencies this architecture approves.
   *
   * Adding one requires editing this list, which is the point: it forces the
   * addition to be a deliberate, reviewed decision with a stated technical
   * reason rather than a convenience.
   */
  const APPROVED_RUNTIME_DEPENDENCIES = [
    '@supabase/ssr', // cookie-based Supabase sessions for the App Router
    '@supabase/supabase-js', // database/auth/storage client
    'next', // framework
    'react', // required by next
    'react-dom', // required by next
    'server-only', // the client/server import barrier
    'zod', // one schema definition shared by server validation and client forms
  ].sort();

  it('contains exactly the approved runtime dependencies', () => {
    expect(runtime).toEqual(APPROVED_RUNTIME_DEPENDENCIES);
  });

  it('has no runtime dependency that is only needed for tests or build tooling', () => {
    const devOnly = Object.keys(pkg.devDependencies ?? {});
    const leaked = runtime.filter((name) => devOnly.includes(name));
    expect(leaked).toEqual([]);
  });

  it('is private and pins a Node engine', () => {
    expect(pkg.private).toBe(true);
    expect(pkg.engines?.node).toMatch(/>=\s*22/);
  });
});

describe('validation scripts exist (Rule 23)', () => {
  const scripts = readPackageJson().scripts ?? {};

  it.each(['typecheck', 'lint', 'test', 'build', 'check:client-exposure', 'validate'])(
    'defines %s',
    (name) => {
      expect(scripts[name], `missing script: ${name}`).toBeTruthy();
    },
  );

  it('validate runs every gate in order', () => {
    const validate = scripts.validate ?? '';
    const order = ['typecheck', 'lint', 'test', 'build', 'check:client-exposure'];
    let position = -1;
    for (const step of order) {
      const found = validate.indexOf(step);
      expect(found, `${step} missing from validate`).toBeGreaterThan(position);
      position = found;
    }
  });
});

describe('TypeScript strictness (Rule 18, ADR-0022)', () => {
  const tsconfig = readRepositoryFile('tsconfig.json');

  it.each([
    'strict',
    'noUncheckedIndexedAccess',
    'exactOptionalPropertyTypes',
    'noImplicitOverride',
    'noImplicitReturns',
    'noFallthroughCasesInSwitch',
    'noUnusedLocals',
    'noUnusedParameters',
    'verbatimModuleSyntax',
    'isolatedModules',
    'forceConsistentCasingInFileNames',
  ])('enables %s', (flag) => {
    expect(tsconfig, `${flag} must be enabled`).toMatch(new RegExp(`"${flag}":\\s*true`));
  });

  it('does not emit JavaScript (Next.js owns the build)', () => {
    expect(tsconfig).toMatch(/"noEmit":\s*true/);
  });

  it('declares the path aliases that express the client/server wall', () => {
    expect(tsconfig).toContain('"@/*"');
    expect(tsconfig).toContain('"@/components/*"');
  });
});

describe('HTTP hardening baseline (§M)', () => {
  const nextConfig = readRepositoryFile('next.config.ts');

  it('sets the baseline security headers', () => {
    expect(nextConfig).toContain('X-Content-Type-Options');
    expect(nextConfig).toContain('nosniff');
    expect(nextConfig).toContain('X-Frame-Options');
    expect(nextConfig).toContain('DENY');
    expect(nextConfig).toContain('Referrer-Policy');
    expect(nextConfig).toContain('Permissions-Policy');
  });

  it('marks the whole API surface as non-cacheable', () => {
    expect(nextConfig).toContain('/api/:path*');
    expect(nextConfig).toContain('no-store');
  });

  it('enables strict mode and removes the framework fingerprint', () => {
    expect(nextConfig).toMatch(/reactStrictMode:\s*true/);
    expect(nextConfig).toMatch(/poweredByHeader:\s*false/);
  });

  it('documents that CSP and HSTS are deferred to Phase 6 rather than forgotten', () => {
    expect(nextConfig).toContain('Phase 6');
    expect(nextConfig).toContain('Content-Security-Policy');
  });
});

describe('the ESLint wall is present (ADR-0002)', () => {
  const eslint = readRepositoryFile('eslint.config.mjs');

  it('restricts isomorphic code from importing server code', () => {
    expect(eslint).toContain('growlith/wall-lib-and-components');
    expect(eslint).toContain('no-restricted-imports');
    expect(eslint).toContain('@/server');
    expect(eslint).toContain('server-only');
  });

  it('restricts isomorphic code from reading process.env directly', () => {
    expect(eslint).toContain('no-restricted-properties');
    expect(eslint).toContain('growlith/env-client-exception');
  });

  it('restricts server code from importing UI', () => {
    expect(eslint).toContain('growlith/wall-server-no-ui');
  });

  it('forces logging through the structured logger', () => {
    expect(eslint).toContain('growlith/no-raw-console');
    expect(eslint).toContain('growlith/logger-implementation-exception');
  });

  it('forbids `any`, which would defeat strict typing in an authorization system', () => {
    expect(eslint).toContain("'@typescript-eslint/no-explicit-any': 'error'");
  });

  it('does not lint the generated database types', () => {
    expect(eslint).toContain('src/types/database.ts');
  });
});

describe('repository hygiene', () => {
  it('commits a lockfile so builds are reproducible', () => {
    expect(() => readRepositoryFile('package-lock.json')).not.toThrow();
  });

  it('pins the Node version for contributors and CI', () => {
    expect(readRepositoryFile('.nvmrc').trim()).toBe('22');
  });

  it('documents the environment template', () => {
    expect(readRepositoryFile('.env.example')).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(readRepositoryFile('.env.example')).toContain('BYPASSRLS');
  });
});

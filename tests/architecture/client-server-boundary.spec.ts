import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';

import {
  REPO_ROOT,
  stripComments,
  extractImportSpecifiers,
  firstImportStatement,
  hasUseClientDirective,
  readRepositoryFile,
  walkRepository,
} from '../helpers/repo';

/**
 * The client/server boundary, enforced by test.
 *
 * WHY THIS FILE EXISTS
 * `SUPABASE_SERVICE_ROLE_KEY` carries PostgreSQL's BYPASSRLS attribute. If it
 * reaches a browser bundle, tenant isolation is gone for every client
 * organization at once, and the leak is invisible — the application keeps
 * working perfectly. Convention and code review do not survive a deadline; this
 * suite does.
 *
 * It is one of four independent controls (ADR-0002):
 *   1. ESLint `growlith/wall-*` rules            — structural imports
 *   2. `server-only` package                     — fails the Next.js build
 *   3. this suite                                — source-level invariants,
 *                                                  including `'use client'`
 *                                                  files that ESLint cannot see
 *   4. `scripts/check-client-exposure.mjs`       — inspects emitted bundles
 *
 * These tests read source rather than execute it, so they keep working even when
 * a module cannot be imported in Node (e.g. one that depends on `next/headers`).
 */

const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

const SERVER_ROOT = 'src/server';
const ISOMORPHIC_ROOTS = ['src/lib', 'components'];

/**
 * Application source directories: everything that ships, minus tests and
 * configuration. Scans rooted here must never contain a credential-shaped
 * literal or a non-analyzable dynamic import.
 *
 * `src` covers `src/types/database.ts` (the generated schema types), which lives
 * inside the source tree so that it is reachable through the `@/` alias like
 * every other module.
 */
const SOURCE_ROOTS = ['src', 'app', 'components'];

function serverModules(): string[] {
  return walkRepository({ roots: [SERVER_ROOT], extensions: TS_EXTENSIONS }).filter(
    (file) => !file.endsWith('.spec.ts') && !file.endsWith('.d.ts'),
  );
}

function isomorphicModules(): string[] {
  return walkRepository({ roots: ISOMORPHIC_ROOTS, extensions: TS_EXTENSIONS }).filter(
    (file) => !file.endsWith('.spec.ts') && !file.endsWith('.d.ts'),
  );
}

function resolvesIntoServerRoot(importer: string, specifier: string): boolean {
  if (specifier.startsWith('@/server/') || specifier === '@/server') {
    return true;
  }
  if (!specifier.startsWith('.')) {
    return false;
  }

  const absolute = resolve(dirname(resolve(REPO_ROOT, importer)), specifier);
  const serverRootAbsolute = resolve(REPO_ROOT, SERVER_ROOT);
  return absolute === serverRootAbsolute || absolute.startsWith(serverRootAbsolute + '/');
}

describe('A. every server module declares the boundary', () => {
  /**
   * The ONE deliberate exemption: middleware-support modules compile for the
   * Edge runtime, where the `server-only` package evaluates its throwing
   * branch — importing it there breaks every page request at build time.
   * `src/server/auth/session-refresh.ts` is imported by `middleware.ts` (repo
   * root, Edge) and therefore must not carry the marker. What that module may
   * import instead is pinned by `tests/architecture/auth-boundary.spec.ts`,
   * which forbids it from reaching the service-role client or anything else
   * that would smuggle server authority into the Edge bundle.
   */
  const SERVER_ONLY_EXEMPTIONS: readonly string[] = ['src/server/auth/session-refresh.ts'];

  const modules = serverModules().filter((file) => !SERVER_ONLY_EXEMPTIONS.includes(file));

  it('found server modules to check', () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  it('the server-only exemptions are exactly the documented set', () => {
    // If a module stops needing the exemption, remove it here; if a new one
    // must be added, the rationale belongs in this block's comment.
    for (const exempt of SERVER_ONLY_EXEMPTIONS) {
      expect(exempt.startsWith('src/server/')).toBe(true);
    }
  });

  it.each(modules)('%s imports `server-only` as its first statement', (file) => {
    const source = readRepositoryFile(file);
    const first = firstImportStatement(source);

    // The `server-only` marker must be the FIRST import. If another import runs
    // first, that module is evaluated before the barrier is established, so a
    // side-effectful dependency could already have leaked into a client graph.
    expect(first, `${file} has no import statements`).not.toBeNull();
    expect(first).toMatch(/^import\s+['"]server-only['"];/);
  });
});

describe('B. isomorphic code cannot reach server code', () => {
  const offenders = isomorphicModules()
    .map((file) => ({
      file,
      bad: extractImportSpecifiers(readRepositoryFile(file)).filter((specifier) =>
        resolvesIntoServerRoot(file, specifier),
      ),
    }))
    .filter((entry) => entry.bad.length > 0);

  it('no module under src/lib or components imports src/server', () => {
    expect(offenders).toEqual([]);
  });

  it('no isomorphic module imports the `server-only` marker directly', () => {
    // Importing `server-only` from isomorphic code would break the browser
    // bundle: under the `default` export condition the package throws.
    const withMarker = isomorphicModules()
      .map((file) => ({ file, source: readRepositoryFile(file) }))
      .filter(({ source }) => extractImportSpecifiers(source).includes('server-only'));

    expect(withMarker.map((entry) => entry.file)).toEqual([]);
  });
});

describe('C. client components cannot reach server code', () => {
  const clientFiles = walkRepository({
    roots: ['app', 'components', 'src'],
    extensions: TS_EXTENSIONS,
  })
    .map((file) => ({ file, source: readRepositoryFile(file) }))
    .filter(({ source }) => hasUseClientDirective(source));

  it('found client components to check', () => {
    // `app/error.tsx` and `app/global-error.tsx` are client components in
    // Phase 1; the dashboards add many more in Phase 9.
    expect(clientFiles.length).toBeGreaterThan(0);
  });

  it('none of them imports src/server, even transitively-declared ones', () => {
    const offenders = clientFiles
      .map(({ file, source }) => ({
        file,
        bad: extractImportSpecifiers(source).filter((specifier) =>
          resolvesIntoServerRoot(file, specifier),
        ),
      }))
      .filter((entry) => entry.bad.length > 0);

    expect(offenders).toEqual([]);
  });
});

describe('D. isomorphic code cannot read arbitrary environment variables', () => {
  const ALLOWED = new Set(['src/lib/env/client-env.ts']);

  it('only the client env module touches process.env', () => {
    // A bare `process.env.FOO` in isomorphic code compiles to `undefined` in the
    // browser unless FOO is NEXT_PUBLIC_ and was present at build time. That
    // silent failure is hard to trace, and reading a server-only variable here
    // would leak it into the bundle.
    const offenders = isomorphicModules()
      .filter((file) => !ALLOWED.has(file))
      .map((file) => ({ file, source: readRepositoryFile(file) }))
      .filter(({ source }) => /process\.env\b/.test(source))
      .map((entry) => entry.file);

    expect(offenders).toEqual([]);
  });
});

describe('E. server code does not depend on the UI layer', () => {
  it('no server module imports a component', () => {
    const offenders = serverModules()
      .map((file) => ({
        file,
        bad: extractImportSpecifiers(readRepositoryFile(file)).filter(
          (specifier) => specifier.startsWith('@/components') || specifier.includes('/components/'),
        ),
      }))
      .filter((entry) => entry.bad.length > 0);

    expect(offenders).toEqual([]);
  });
});

describe('F. the Supabase clients have no barrel file', () => {
  it('src/server/supabase exposes no index.ts', () => {
    // A single `import { … } from '@/server/supabase'` would pull
    // client-service.ts into every consumer's module graph, including consumers
    // that only wanted the request-scoped client. Importing the two clients
    // explicitly keeps the dangerous one out of graphs that do not need it.
    const barrels = walkRepository({ roots: ['src/server/supabase'], extensions: TS_EXTENSIONS });
    expect(barrels.filter((file) => file.endsWith('/index.ts'))).toEqual([]);
  });
});

describe('G. every API route goes through withRoute', () => {
  const routes = walkRepository({ roots: ['app/api'], extensions: new Set(['.ts']) }).filter(
    (file) => file.endsWith('route.ts'),
  );

  it('found route handlers to check', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes)('%s is built with withRoute', (file) => {
    // This is the invariant that makes validation, correlation and error mapping
    // unavoidable. A hand-written handler would be free to skip all three, and
    // in Phase 4 it would be free to skip authorization — so the rule is
    // established now, before there are many routes to retrofit.
    const source = readRepositoryFile(file);
    expect(source).toContain("from '@/server/api/with-route'");
    expect(source).toContain('withRoute(');
  });
});

describe('H. no credential-shaped literal is committed in source', () => {
  const PATTERNS = [
    { id: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/ },
    { id: 'supabase-secret-key', pattern: /sb_secret_[A-Za-z0-9]{8,}/ },
    { id: 'connection-string-with-password', pattern: /postgres(?:ql)?:\/\/[^/\s]+:[^/\s]+@/ },
  ];

  const sourceFiles = walkRepository({ roots: SOURCE_ROOTS, extensions: TS_EXTENSIONS });

  it('scanned the source tree', () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  it('contains no real-looking secret', () => {
    const findings: string[] = [];

    for (const file of sourceFiles) {
      const source = readRepositoryFile(file);
      for (const { id, pattern } of PATTERNS) {
        if (pattern.test(source)) {
          findings.push(`${file}: ${id}`);
        }
      }
    }

    // Tests are excluded because they must contain credential-shaped fixtures in
    // order to prove that redaction works.
    expect(findings).toEqual([]);
  });
});

describe('I. isomorphic code must actually run on both sides', () => {
  /**
   * `src/lib` is documented as isomorphic, which means *safe to execute on
   * either side* — not merely safe to import. A module that touches a
   * browser-only API can be imported from a Server Component, a route handler or
   * middleware and then throws at the first call, so the failure surfaces at
   * runtime in whichever environment the author did not test.
   *
   * LIMIT OF THIS CHECK, stated plainly: it scans *our* source, so it cannot see
   * through a dependency. `createBrowserClient` from `@supabase/ssr` reads
   * `document.cookie` inside the library, and a `src/lib` module that merely
   * imported it would contain no offending token at all. That exact regression
   * happened during the Phase 1 review, which is why the factory is named
   * explicitly below. Any new third-party factory placed in `src/lib` needs the
   * same treatment: check the library's runtime contract, then add it here.
   */
  const BROWSER_ONLY_PATTERNS = [
    { id: 'document', pattern: /\bdocument\s*[.[]/ },
    { id: 'window', pattern: /\bwindow\s*[.[]/ },
    { id: 'typeof window guard', pattern: /typeof\s+window\b/ },
    { id: 'localStorage', pattern: /\blocalStorage\b/ },
    { id: 'sessionStorage', pattern: /\bsessionStorage\b/ },
    { id: 'navigator', pattern: /\bnavigator\s*[.[]/ },
    // Browser-only Supabase factory. See the limitation note above.
    { id: 'createBrowserClient', pattern: /\bcreateBrowserClient\b/ },
  ];

  it('no isomorphic module reaches for a browser-only API', () => {
    const findings: string[] = [];

    for (const file of isomorphicModules()) {
      const code = stripComments(readRepositoryFile(file));
      for (const { id, pattern } of BROWSER_ONLY_PATTERNS) {
        if (pattern.test(code)) {
          findings.push(`${file}: ${id}`);
        }
      }
    }

    expect(
      findings,
      'Each finding is a module that cannot run on the server. Either move it to ' +
        'a browser-only tier, or move the browser-specific call behind an ' +
        'injected dependency so the module itself stays isomorphic.',
    ).toEqual([]);
  });

  it('environment branching stays out of the isomorphic tier entirely', () => {
    // Deliberately stricter than "no browser APIs": a module that must ask which
    // environment it is in usually belongs on one side of the wall. Banning the
    // question keeps `src/lib` genuinely environment-agnostic, so nothing there
    // needs a second code path to be tested twice.
    const offenders = isomorphicModules()
      .map((file) => ({ file, code: stripComments(readRepositoryFile(file)) }))
      .filter(({ code }) => /typeof\s+(window|document)\b/.test(code))
      .map((entry) => entry.file);

    expect(offenders).toEqual([]);
  });
});

describe('J. the wall cannot be bypassed by a dynamic import', () => {
  it('every dynamic import in application source has a literal specifier', () => {
    // Every boundary test in this file works by extracting module specifiers from
    // source text. A *computed* specifier — `import(target)` or
    // `import(`@/server/${name}`)` — is invisible to that extraction, so a client
    // component could reach a server module without failing a single check.
    //
    // `next build` rejects many such cases at bundle time, but only along paths
    // reachable from a client entry; a lazily-evaluated specifier can slip past
    // that as well. Closing the gap statically is cheap because application
    // source currently contains no dynamic imports at all — the rule is simply
    // that any which appear must remain analyzable.
    //
    // A template literal is treated as non-literal even when it has no
    // substitution, because `import(`@/server/x`)` and `import('@/server/x')` are
    // indistinguishable to this scanner and only one of them is safe to allow.
    const LITERAL_DYNAMIC_IMPORT = /\bimport\s*\(\s*['"][^'"]*['"]\s*\)/g;
    const ANY_DYNAMIC_IMPORT = /\bimport\s*\(/g;
    const offenders: string[] = [];

    for (const file of walkRepository({ roots: SOURCE_ROOTS, extensions: TS_EXTENSIONS })) {
      const code = stripComments(readRepositoryFile(file));
      const total = [...code.matchAll(ANY_DYNAMIC_IMPORT)].length;
      const literal = [...code.matchAll(LITERAL_DYNAMIC_IMPORT)].length;

      if (total !== literal) {
        offenders.push(`${file}: ${total - literal} non-literal dynamic import(s)`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

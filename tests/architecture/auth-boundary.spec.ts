import { describe, expect, it } from 'vitest';

import {
  extractImportSpecifiers,
  readRepositoryFile,
  stripComments,
  walkRepository,
} from '../helpers/repo';

/** Specifiers of CODE, not prose — comments may quote import-like text. */
function importsOf(relativePath: string): string[] {
  return extractImportSpecifiers(stripComments(readRepositoryFile(relativePath)));
}

/**
 * The middleware (Edge) import boundary — design §7.
 *
 * `middleware.ts` compiles for the Edge runtime. Everything in its import
 * graph ships in that bundle, so the graph is capability-sensitive: it must
 * contain no service-role credentials, no Node-only server APIs and no
 * session-decision authority beyond the coarse refresh/route split that
 * `session-refresh.ts` owns.
 *
 * `src/server/auth/session-refresh.ts` is the ONE `src/server` module without
 * the `server-only` marker (the marker throws in the Edge bundle — see the
 * exemption in `client-server-boundary.spec.ts` block A). This spec is the
 * price of that exemption: its import list is pinned to the exact, reviewed
 * set, so the module cannot drift into authority it was never given.
 */

const MIDDLEWARE_ENTRY = 'middleware.ts';

/** The Edge-reachable server module — the reviewed, closed import surface. */
const EDGE_SUPPORT_MODULE = 'src/server/auth/session-refresh.ts';

/** Every application source file, for static specifier resolution. */
const SOURCE_FILES = new Set(
  walkRepository({ roots: ['src', 'app', 'components'], extensions: new Set(['.ts', '.tsx']) }),
);

/** Modules that must never appear in an Edge entrypoint's import graph. */
const FORBIDDEN_EDGE_IMPORTS: readonly RegExp[] = [
  // The service_role key and the server env that loads it.
  /client-service/,
  /@\/server\/env/,
  // Session-decision authority: the Edge gate is refresh + coarse routing ONLY.
  /@\/server\/auth\/(context|audit|accounts|invitations|routes-|email-links|session-cookies)/,
];

describe('auth boundary — the Edge (middleware) graph', () => {
  it('middleware imports only next/server and the session-support module', () => {
    const specifiers = importsOf(MIDDLEWARE_ENTRY);

    expect(specifiers).toEqual(['next/server', '@/server/auth/session-refresh']);
  });

  it('the session-support module imports only the reviewed public surface', () => {
    const specifiers = importsOf(EDGE_SUPPORT_MODULE).sort();

    // Any change here is a capability change to the Edge bundle: it must be a
    // reviewed decision, made by editing this pinned list.
    expect(specifiers).toEqual([
      '@/lib/auth/routes',
      '@/lib/env/client-env',
      '@supabase/ssr',
      '@supabase/supabase-js',
    ]);
  });

  it('nothing in the Edge graph reaches a forbidden module', () => {
    for (const entry of [MIDDLEWARE_ENTRY, EDGE_SUPPORT_MODULE]) {
      expect(forbiddenInGraph(entry), `${entry} reaches a forbidden module`).toEqual([]);
    }
  });

  it('no other src/server module is Edge-reachable', () => {
    // The exemption in client-server-boundary block A must stay a list of ONE.
    // Reaching the Edge module from src/server requires a DIRECT import: the
    // only other route would be through src/lib, which block B of the
    // client-server boundary already forbids from importing src/server at all.
    const offenders = walkRepository({
      roots: ['src/server'],
      extensions: new Set(['.ts']),
    })
      .filter((file) => !file.endsWith('.spec.ts') && file !== EDGE_SUPPORT_MODULE)
      .filter((file) => importsOf(file).includes('@/server/auth/session-refresh'));

    expect(offenders).toEqual([]);
  });
});

/* ────────────────────────────── internals ──────────────────────────────── */

function resolveSpecifier(specifier: string): string | null {
  if (!specifier.startsWith('@/')) {
    return null; // bare packages (next/server, @supabase/ssr) are not files here
  }
  const base = specifier.replace('@/', 'src/');
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (SOURCE_FILES.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

function forbiddenInGraph(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  const offenders: string[] = [];

  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);

    for (const specifier of importsOf(file)) {
      if (FORBIDDEN_EDGE_IMPORTS.some((pattern) => pattern.test(specifier))) {
        offenders.push(`${file} → ${specifier}`);
      }
      const resolved = resolveSpecifier(specifier);
      if (resolved !== null && !seen.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  return offenders;
}

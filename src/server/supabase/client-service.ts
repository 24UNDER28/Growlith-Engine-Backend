import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { getClientEnv } from '@/lib/env/client-env';
import { getServerEnv } from '@/server/env';
import { createLogger } from '@/server/logging/logger';
import type { Database } from '@/types/database';

/**
 * The service-role client. Read this before using it.
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ Supabase's `service_role` carries the PostgreSQL BYPASSRLS attribute.  │
 * │ A query issued through this client is NOT subject to Row Level         │
 * │ Security. It can read and write every row of every client              │
 * │ organization at once.                                                  │
 * │                                                                        │
 * │ Leaking this key is therefore not a bug in one feature — it is the     │
 * │ simultaneous loss of tenant isolation for the whole platform.          │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * CONTAINMENT — four independent controls (ADR-0002, §M):
 *   1. This file lives under `src/server/`, which `src/lib` and `components/`
 *      may not import (ESLint `growlith/wall-lib-and-components`).
 *   2. `import 'server-only'` above makes the Next.js build fail if this module
 *      is reachable from a client graph.
 *   3. `tests/architecture/client-server-boundary.spec.ts` fails if any module
 *      under `src/server/` loses its `server-only` import, or if any
 *      `'use client'` file imports it.
 *   4. `scripts/check-client-exposure.mjs` scans the emitted client bundles
 *      after `next build` for the key and for this module's markers.
 *
 * WHEN USE IS LEGITIMATE
 * Only for operations that must exceed the caller's own rights, and each such
 * call site must state why in a comment:
 *   - inviting or suspending a user (Phase 3)
 *   - cross-tenant administration by SUPER_ADMIN (Phase 4/5)
 *   - verifying that a Storage object exists after a direct upload (Phase 6)
 *
 * DEFAULT TO `client-server.ts` INSTEAD. If a read can be performed as the
 * caller, it must be — that is what keeps RLS meaningful.
 *
 * There is deliberately **no barrel file** re-exporting the Supabase clients:
 * a single `import { … } from '@/server/supabase'` would pull this module into
 * every consumer's graph, including ones that only wanted the safe client.
 */

export type SupabaseServiceClient = SupabaseClient<Database>;

let cached: SupabaseServiceClient | undefined;

export function getSupabaseServiceClient(): SupabaseServiceClient {
  // Defence in depth beyond `server-only`: if this module is ever reached in a
  // browser context — through a bundler misconfiguration, a test environment or
  // a future refactor — fail immediately rather than issuing a request with a
  // BYPASSRLS key from a client.
  if (typeof window !== 'undefined') {
    throw new Error(
      'getSupabaseServiceClient() was called in a browser context. The service_role key has BYPASSRLS and must never be reachable from client code.',
    );
  }

  if (cached) {
    return cached;
  }

  const { SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey } = getServerEnv();
  // The project URL comes from the public contract rather than a server-only
  // duplicate: one declaration of one fact, so this client and the browser can
  // never be pointed at different Supabase projects. See src/lib/env/client-env.ts.
  const { NEXT_PUBLIC_SUPABASE_URL: url } = getClientEnv();

  cached = createClient<Database>(url, serviceRoleKey, {
    auth: {
      // The service client authenticates as the platform, never as a user, so
      // there is no session to persist or refresh. Leaving these enabled would
      // create a shared, mutable session inside a process-wide singleton — a
      // cross-request identity leak.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        // Identifies the traffic source in Supabase logs, so service-role usage
        // is attributable and can be alerted on.
        'x-application-name': 'growlith-engine-service-role',
      },
    },
  });

  createLogger({ scope: 'supabase-service-client' }).info('service-role client constructed');

  return cached;
}

/** Test helper: drop the singleton so each test constructs a fresh client. */
export function __resetServiceClientForTests(): void {
  cached = undefined;
}

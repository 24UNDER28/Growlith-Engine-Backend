import 'server-only';

import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import { getClientEnv } from '@/lib/env/client-env';
import { createLogger } from '@/server/logging/logger';
import type { Database } from '@/types/database';

/**
 * The request-scoped server client — the primary database boundary.
 *
 * THE PROPERTY THAT MATTERS (ADR-0007, Rules 9–10)
 * This client is built with the **anonymous key** and the **calling user's own
 * cookies**. Consequently every query it issues reaches PostgreSQL carrying that
 * user's JWT, so Row Level Security is evaluated *as that user*. Server code
 * therefore cannot accidentally exceed the caller's rights: tenant isolation is
 * a property of the connection, not of the discipline of whoever wrote the
 * query.
 *
 * This is what makes the API layer and RLS two genuine layers rather than one
 * duplicated check. If a future handler forgets a filter, RLS still denies.
 *
 * Use `client-service.ts` only when an operation must legitimately exceed the
 * caller's rights (invitations, cross-tenant administration). Default to this
 * module.
 *
 * USAGE CONSTRAINTS
 * - `cookies()` is only available inside a request scope: a route handler, a
 *   Server Component, or `middleware`. Calling this from a build-time context or
 *   a background job throws. That is correct — there is no user to act as, so
 *   such code must use the service client and justify it.
 * - The returned client must not be cached across requests: it is bound to one
 *   caller's session.
 */

export type SupabaseServerClient = SupabaseClient<Database>;

export async function createSupabaseServerClient(): Promise<SupabaseServerClient> {
  const cookieStore = await cookies();
  // Both values come from the public contract, which server modules are allowed
  // to read: the URL is declared once so no client can drift to another project,
  // and the anon key is public by design. See src/lib/env/client-env.ts.
  const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: anonKey } = getClientEnv();

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      /**
       * Write refreshed session cookies back to the response.
       *
       * Inside a Server Component the cookie store is read-only and `set()`
       * throws. That is expected: `middleware.ts` (Phase 3) owns refresh on that
       * path, so the session has already been renewed before rendering begins.
       * The failure is logged rather than swallowed (Rule 24) — if it ever fires
       * on a route handler, where writes *are* permitted, that is a real bug and
       * it must be visible.
       */
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch (error) {
          createLogger({ scope: 'supabase-server-client' }).debug(
            'session cookie write skipped — read-only cookie store (expected inside Server Components)',
            { reason: error instanceof Error ? error.message : String(error) },
          );
        }
      },
    },
  });
}

import { withRoute } from '@/server/api/with-route';

/**
 * GET /api/v1/health — liveness probe.
 *
 * This is infrastructure, not a business endpoint (Rule 14): it exists so a load
 * balancer, an uptime monitor and a deploy pipeline can answer "is the process
 * up and able to serve requests?" without authenticating.
 *
 * Deliberate properties:
 * - **No environment or database dependency.** A probe that fails because
 *   Supabase is unreachable cannot distinguish "the app is down" from "a
 *   dependency is degraded", which is the one distinction an on-call engineer
 *   needs. Dependency readiness is a separate check added in Phase 5/6.
 * - **Reveals nothing.** No version, no region, no configuration state, no
 *   dependency identity. It is unauthenticated and therefore public.
 * - `force-dynamic` so it is never served from a cache and always proves the
 *   current process is executing code.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  // Public by definition: a liveness probe exists so infrastructure can ask
  // "is the process up?" without authenticating (§15 taxonomy).
  auth: 'public',
  rateLimit: { class: 'read' },
  summary: 'liveness probe',
  handler: async () => ({ status: 'ok' as const }),
});

export { GET };

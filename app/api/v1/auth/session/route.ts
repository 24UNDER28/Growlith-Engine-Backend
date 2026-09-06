import { withRoute } from '@/server/api/with-route';
import { resolveAuthContext } from '@/server/auth/context';

/**
 * GET /api/v1/auth/session — client-side session awareness (design §6).
 *
 * The browser has no Supabase client and no `onAuthStateChange` (ADR-0026), so
 * a client component that must react without a re-render asks here. Contract:
 * ALWAYS 200 — `{ session: AuthContextDTO | null }`, never a 401 — so clients
 * branch on data rather than exceptions. The DTO carries `accountStatus`, so a
 * suspended or deactivated account is distinguishable from "signed out" on the
 * client without the status gate turning into an error envelope.
 *
 * The account-status GATE is deliberately not applied: this endpoint REPORTS
 * state; the surfaces that must block apply `requireAuthContext()` themselves.
 * Unavailability still surfaces as 503 — a reporting endpoint must not claim
 * "signed out" during an outage.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GET = withRoute({
  method: 'GET',
  auth: 'public',
  rateLimit: { class: 'read' },
  summary: 'report the current session context, or null',
  handler: async () => ({ session: await resolveAuthContext() }),
});

export { GET };

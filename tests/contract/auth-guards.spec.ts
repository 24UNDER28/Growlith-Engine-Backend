import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetClientEnvCacheForTests } from '@/lib/env/client-env';
import { ApiError } from '@/server/api/errors';
import {
  requireAdminContext,
  requirePortalContext,
} from '@/server/auth/guards';
import { authContextFixture, clientContextFixture, UUIDS } from '../helpers/auth-fixtures';

/**
 * Layout guard contracts (§15 Layer 2).
 *
 * These guards run in Server Components, where failures are REDIRECTS (thrown
 * by `next/navigation`), not error envelopes. The guards must enforce:
 *   - admin: session + INTERNAL + MFA enrolled + aal2
 *   - portal: session + CLIENT + at least one ACTIVE membership
 *   - wrong-side users are sent to their correct landing
 *   - suspended/deactivated/invited go to /account-restricted
 *   - unauthenticated goes to /login
 */

const requireAuthContextMock = vi.hoisted(() => vi.fn());

vi.mock('@/server/auth/context', () => ({
  requireAuthContext: (...args: unknown[]) => requireAuthContextMock(...args),
}));

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.test.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key');
  __resetClientEnvCacheForTests();
  requireAuthContextMock.mockReset();
});

/**
 * `redirect()` from `next/navigation` throws a special error whose `digest`
 * encodes the destination. Format: `NEXT_REDIRECT;<type>;<url>;<status>;`
 * We extract the URL (parts[2]).
 */
async function redirectDestination(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const thrown = error as { digest?: string };
    if (thrown.digest?.startsWith('NEXT_REDIRECT;')) {
      const parts = thrown.digest.split(';');
      // Format: NEXT_REDIRECT;<type>;<url>;<status>;
      return parts[2] ?? '';
    }
    return String(error);
  }
  throw new Error('expected redirect to be thrown');
}

/* ─────────────────────────── admin guard ─────────────────────────────── */

describe('requireAdminContext — the admin layout guard (§15, §6c)', () => {
  const opts = { currentPath: '/admin/settings' };

  it('accepts an INTERNAL aal2 session with MFA enrolled', async () => {
    requireAuthContextMock.mockResolvedValue(
      authContextFixture({ aal: 'aal2', mfaEnrolled: true }),
    );

    const context = await requireAdminContext(opts);
    expect(context.userId).toBe(UUIDS.user);
    expect(context.userType).toBe('INTERNAL');
  });

  it('redirects to login when unauthenticated', async () => {
    requireAuthContextMock.mockRejectedValue(ApiError.unauthenticated());

    const dest = await redirectDestination(requireAdminContext(opts));
    expect(dest).toMatch(/^\/login\?next=/);
  });

  it('redirects to /account-restricted when suspended', async () => {
    requireAuthContextMock.mockRejectedValue(ApiError.accountSuspended());

    const dest = await redirectDestination(requireAdminContext(opts));
    expect(dest).toBe('/account-restricted');
  });

  it('redirects to /account-restricted when deactivated', async () => {
    requireAuthContextMock.mockRejectedValue(ApiError.accountDeactivated());

    const dest = await redirectDestination(requireAdminContext(opts));
    expect(dest).toBe('/account-restricted');
  });

  it('redirects to /account-restricted?reason=invitation_pending for INVITED', async () => {
    requireAuthContextMock.mockRejectedValue(ApiError.invitationPending());

    const dest = await redirectDestination(requireAdminContext(opts));
    expect(dest).toContain('/account-restricted');
    expect(dest).toContain('invitation_pending');
  });

  it('redirects to /account-restricted?reason=unavailable for service outage', async () => {
    requireAuthContextMock.mockRejectedValue(ApiError.serviceUnavailable());

    const dest = await redirectDestination(requireAdminContext(opts));
    expect(dest).toContain('/account-restricted');
    expect(dest).toContain('unavailable');
  });

  it('redirects a CLIENT user (wrong side) to /portal if they have active membership', async () => {
    requireAuthContextMock.mockResolvedValue(clientContextFixture());

    const dest = await redirectDestination(requireAdminContext(opts));
    expect(dest).toBe('/portal');
  });

  it('redirects a CLIENT user without active membership to /account-restricted', async () => {
    requireAuthContextMock.mockResolvedValue(
      clientContextFixture({
        memberships: [
          {
            organizationId: UUIDS.organization,
            role: 'CLIENT_MEMBER',
            status: 'SUSPENDED',
            isPrimaryContact: false,
          },
        ],
      }),
    );

    const dest = await redirectDestination(requireAdminContext(opts));
    expect(dest).toBe('/account-restricted');
  });

  it('redirects to MFA enrollment when no factors are verified', async () => {
    requireAuthContextMock.mockResolvedValue(
      authContextFixture({ aal: 'aal1', mfaEnrolled: false }),
    );

    const dest = await redirectDestination(requireAdminContext(opts));
    expect(dest).toBe('/auth/mfa-enroll');
  });

  it('redirects to MFA challenge when factors exist but session is aal1', async () => {
    requireAuthContextMock.mockResolvedValue(
      authContextFixture({ aal: 'aal1', mfaEnrolled: true }),
    );

    const dest = await redirectDestination(requireAdminContext(opts));
    expect(dest).toBe('/auth/mfa-challenge');
  });

  it('redirects MFA_REQUIRED to login (the step-up path)', async () => {
    requireAuthContextMock.mockRejectedValue(ApiError.mfaRequired());

    const dest = await redirectDestination(requireAdminContext(opts));
    expect(dest).toMatch(/^\/login\?next=/);
  });
});

/* ─────────────────────────── portal guard ────────────────────────────── */

describe('requirePortalContext — the portal layout guard (§15, §8)', () => {
  const opts = { currentPath: '/portal/projects' };

  it('accepts a CLIENT session with an ACTIVE membership', async () => {
    requireAuthContextMock.mockResolvedValue(clientContextFixture());

    const context = await requirePortalContext(opts);
    expect(context.userId).toBe(UUIDS.user);
    expect(context.userType).toBe('CLIENT');
  });

  it('redirects to login when unauthenticated', async () => {
    requireAuthContextMock.mockRejectedValue(ApiError.unauthenticated());

    const dest = await redirectDestination(requirePortalContext(opts));
    expect(dest).toMatch(/^\/login\?next=/);
  });

  it('redirects to /account-restricted when suspended', async () => {
    requireAuthContextMock.mockRejectedValue(ApiError.accountSuspended());

    const dest = await redirectDestination(requirePortalContext(opts));
    expect(dest).toBe('/account-restricted');
  });

  it('redirects an INTERNAL user (wrong side) to /admin', async () => {
    requireAuthContextMock.mockResolvedValue(authContextFixture());

    const dest = await redirectDestination(requirePortalContext(opts));
    expect(dest).toBe('/admin');
  });

  it('redirects a CLIENT without active membership to /account-restricted', async () => {
    requireAuthContextMock.mockResolvedValue(
      clientContextFixture({
        memberships: [
          {
            organizationId: UUIDS.organization,
            role: 'CLIENT_MEMBER',
            status: 'SUSPENDED',
            isPrimaryContact: false,
          },
        ],
      }),
    );

    const dest = await redirectDestination(requirePortalContext(opts));
    expect(dest).toBe('/account-restricted');
  });

  it('redirects to /account-restricted?reason=invitation_pending for INVITED', async () => {
    requireAuthContextMock.mockRejectedValue(ApiError.invitationPending());

    const dest = await redirectDestination(requirePortalContext(opts));
    expect(dest).toContain('/account-restricted');
    expect(dest).toContain('invitation_pending');
  });
});

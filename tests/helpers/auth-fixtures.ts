import type { AuthContext } from '@/lib/auth/context';

/**
 * Fixtures for the Phase 3 auth contract tests.
 *
 * Pure data — no Supabase, no Next.js. The fake Supabase clients live beside
 * the specs that need them, because each spec scripts different behaviour.
 */

export const UUIDS = {
  user: '11111111-1111-4111-8111-111111111111',
  otherUser: '22222222-2222-4222-8222-222222222222',
  organization: '33333333-3333-4333-8333-333333333333',
  otherOrganization: '44444444-4444-4444-8444-444444444444',
  invitation: '55555555-5555-4555-8555-555555555555',
  factor: '66666666-6666-4666-8666-666666666666',
} as const;

export function authContextFixture(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: UUIDS.user,
    email: 'staff@growlith.test',
    fullName: 'Test Person',
    userType: 'INTERNAL',
    accountStatus: 'ACTIVE',
    platformRole: 'ADMIN',
    memberships: [],
    teams: [],
    projectRoles: {},
    projectRolesOverflow: false,
    aal: 'aal1',
    mfaEnrolled: false,
    lastSeenAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A CLIENT identity with one ACTIVE membership. */
export function clientContextFixture(overrides: Partial<AuthContext> = {}): AuthContext {
  return authContextFixture({
    email: 'client@example.test',
    userType: 'CLIENT',
    platformRole: null,
    memberships: [
      {
        organizationId: UUIDS.organization,
        role: 'CLIENT_ADMIN',
        status: 'ACTIVE',
        isPrimaryContact: true,
      },
    ],
    ...overrides,
  });
}

/** The jsonb shape `public.auth_context()` returns, for RPC stubbing. */
export function authContextRpcPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    userId: UUIDS.user,
    email: 'staff@growlith.test',
    fullName: 'Test Person',
    userType: 'INTERNAL',
    accountStatus: 'ACTIVE',
    lastSeenAt: new Date().toISOString(),
    mfaEnrolledAt: null,
    platformRole: 'ADMIN',
    memberships: [],
    teams: [],
    projectRoles: [],
    projectRolesOverflow: false,
    ...overrides,
  };
}

/** The GoTrue user shape `getUser()` returns, for client stubbing. */
export function gotrueUserFixture(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: UUIDS.user,
    email: 'staff@growlith.test',
    aud: 'authenticated',
    app_metadata: { user_type: 'INTERNAL' },
    user_metadata: { full_name: 'Test Person' },
    created_at: '2026-09-01T00:00:00Z',
    factors: [],
    ...overrides,
  };
}

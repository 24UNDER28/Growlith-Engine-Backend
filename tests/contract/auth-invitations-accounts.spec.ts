import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetClientEnvCacheForTests } from '@/lib/env/client-env';
import { ApiError } from '@/server/api/errors';
import { recordAuthEvent } from '@/server/auth/audit';
import { createInvitation, resendInvitation, revokeInvitation } from '@/server/auth/invitations';
import {
  deactivateAccount,
  reactivateAccount,
  reinstateAccount,
  suspendAccount,
  type AccountTransitionInput,
} from '@/server/auth/accounts';
import { authContextFixture, clientContextFixture, UUIDS } from '../helpers/auth-fixtures';
import { fakeQueryChain, fakeServiceClient } from '../helpers/fake-supabase';
import type { Database } from '@/types/database';

/**
 * The invitation ledger service (§2) and the account-status service (§8),
 * exercised against a scriptable service client. Route-level role gates are
 * covered by the route modules; here the services' OWN contracts are pinned:
 * branch selection, guarded writes, evictions and the audit trail.
 */

type InvitationRow = Database['public']['Tables']['invitations']['Row'];

const serviceClientMock = vi.hoisted(() => vi.fn());

vi.mock('@/server/supabase/client-server', () => ({
  createSupabaseServerClient: vi.fn(),
}));
vi.mock('@/server/supabase/client-service', () => ({
  getSupabaseServiceClient: () => serviceClientMock(),
}));
vi.mock('@/server/auth/audit', () => ({
  recordAuthEvent: vi.fn(async () => true),
}));

const audit = vi.mocked(recordAuthEvent);

const invitationRow = (overrides: Partial<InvitationRow> = {}): InvitationRow => ({
  id: UUIDS.invitation,
  email: 'new.person@example.test',
  organization_id: UUIDS.organization,
  organization_role: 'CLIENT_MEMBER',
  platform_role: null,
  invited_by: UUIDS.user,
  token_hash: 'a'.repeat(64),
  status: 'PENDING',
  expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  message: null,
  resent_count: 0,
  last_sent_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  revoked_at: null,
  revoked_by: null,
  accepted_user_id: null,
  accepted_at: null,
  updated_at: new Date().toISOString(),
  ...overrides,
});

/**
 * Script the service client table-by-table. `profiles` accepts separate READ
 * and WRITE terminals (`.select().maybeSingle()` vs `.update().single()`).
 * Chains are cached per table so write payloads stay assertable.
 */
function scriptService(options: {
  readonly tables?: Record<string, { data?: unknown; error?: unknown }>;
  readonly profilesRead?: { data?: unknown; error?: unknown };
  readonly profilesWrite?: { data?: unknown; error?: unknown };
  readonly invitationsRead?: { data?: unknown; error?: unknown };
  readonly invitationsWrite?: { data?: unknown; error?: unknown };
}) {
  const service = fakeServiceClient();
  const chains = new Map<string, ReturnType<typeof fakeQueryChain>>();

  // Tables whose READ and WRITE terminals must differ (e.g. load PENDING,
  // update to REVOKED). The write chain's `update` spy is cached under
  // `<table>:update` for payload assertions.
  const splitTable = (
    table: string,
    read: { data?: unknown; error?: unknown },
    write: { data?: unknown; error?: unknown },
  ) => {
    const readChain = fakeQueryChain(read);
    const writeChain = fakeQueryChain(write);
    const update = vi.fn(() => writeChain.chain);
    chains.set(`${table}:update`, {
      chain: writeChain.chain,
      terminal: writeChain.terminal,
      passthrough: update,
    });
    return { select: () => readChain.chain, update, insert: vi.fn(() => writeChain.chain) };
  };

  service.spies.from.mockImplementation((table: string) => {
    if (table === 'profiles') {
      return splitTable(
        'profiles',
        options.profilesRead ?? options.tables?.profiles ?? {},
        options.profilesWrite ?? options.tables?.profiles ?? {},
      );
    }
    if (
      table === 'invitations' &&
      (options.invitationsRead !== undefined || options.invitationsWrite !== undefined)
    ) {
      return splitTable(
        'invitations',
        options.invitationsRead ?? options.tables?.invitations ?? {},
        options.invitationsWrite ?? options.tables?.invitations ?? {},
      );
    }
    let chain = chains.get(table);
    if (chain === undefined) {
      chain = fakeQueryChain(options.tables?.[table] ?? {});
      chains.set(table, chain);
    }
    return chain.chain;
  });

  serviceClientMock.mockReturnValue(service.client);
  return {
    service,
    /** Cached chain for a table; `profiles:update` for a profile write. */
    spy: (table: string) => {
      const chain = chains.get(table);
      if (chain === undefined) {
        throw new Error(`no chain was created for table '${table}'`);
      }
      return chain;
    },
  };
}

const actorContext = authContextFixture({ platformRole: 'ADMIN' });

const createInput = {
  body: {
    email: 'new.person@example.test',
    fullName: 'New Person',
    organizationId: UUIDS.organization,
    organizationRole: 'CLIENT_MEMBER' as const,
  },
  auth: actorContext,
  request: new Request('https://app.test/api/v1/invitations', { method: 'POST' }),
  requestId: 'req-invite',
};

async function rejectionOf(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error('expected the call to reject');
}

beforeEach(() => {
  process.env.LOG_LEVEL = 'silent';
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.test');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://db.test.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test-key');
  __resetClientEnvCacheForTests();
  audit.mockClear();
});

/* ───────────────────────────── create (§2.1) ───────────────────────────── */

describe('createInvitation — three states, three actions', () => {
  it('invites a brand-new address: GoTrue invite + app_metadata hint + ledger row + INVITED membership', async () => {
    const env = scriptService({
      profilesRead: { data: null }, // no live profile for the address
      tables: {
        organizations: { data: { id: UUIDS.organization } },
        invitations: { data: invitationRow() },
      },
    });

    const dto = await createInvitation(createInput);

    expect(env.service.spies.inviteUserByEmail).toHaveBeenCalledWith(
      'new.person@example.test',
      expect.objectContaining({
        data: { full_name: 'New Person', user_type: 'CLIENT' },
        redirectTo: expect.stringContaining('/auth/confirm?type=invite&it='),
      }),
    );
    expect(env.service.spies.updateUserById).toHaveBeenCalledWith(UUIDS.user, {
      app_metadata: { user_type: 'CLIENT' },
    });
    expect(dto).toMatchObject({ email: 'new.person@example.test', status: 'PENDING' });
    // The INVITED membership is written at invite time — role assignment is a
    // server decision, not a link-click side effect.
    expect(env.service.spies.from).toHaveBeenCalledWith('organization_memberships');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'INVITE_SENT', severity: 'NOTICE' }),
    );
  });

  it('routes a staff invitation through the CRITICAL audit severity', async () => {
    const env = scriptService({
      profilesRead: { data: null },
      tables: {
        invitations: { data: invitationRow({ platform_role: 'ADMIN', organization_id: null }) },
      },
    });

    await createInvitation({
      ...createInput,
      body: { email: 'ops@example.test', fullName: 'Ops', platformRole: 'ADMIN' },
    });

    expect(env.service.spies.inviteUserByEmail).toHaveBeenCalledWith(
      'ops@example.test',
      expect.objectContaining({
        data: { full_name: 'Ops', user_type: 'INTERNAL' },
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'INVITE_SENT', severity: 'CRITICAL' }),
    );
  });

  it('refuses a CLIENT_ADMIN from inviting a second CLIENT_ADMIN (ceiling 1, §A)', async () => {
    const env = scriptService({ profilesRead: { data: null } });

    const error = await rejectionOf(
      createInvitation({
        ...createInput,
        auth: clientContextFixture(),
        body: {
          ...createInput.body,
          organizationRole: 'CLIENT_ADMIN' as const,
        },
      }),
    );

    expect(error.status).toBe(403);
    expect(error.message).toContain('CLIENT_MEMBER');
    // The forbidden branch must short-circuit before any GoTrue invite.
    expect(env.service.spies.inviteUserByEmail).not.toHaveBeenCalled();
  });

  it('allows a CLIENT_ADMIN to invite a CLIENT_MEMBER (the ceiling is one-directional)', async () => {
    const env = scriptService({
      profilesRead: { data: null },
      tables: {
        organizations: { data: { id: UUIDS.organization } },
        invitations: { data: invitationRow() },
      },
    });

    const dto = await createInvitation({
      ...createInput,
      auth: clientContextFixture(),
    });

    expect(dto.status).toBe('PENDING');
    expect(env.spy('organization_memberships').passthrough).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'CLIENT_MEMBER', status: 'INVITED' }),
    );
  });

  it('refuses to invite an address that already belongs to a live CONFIRMED account (409)', async () => {
    scriptService({
      profilesRead: { data: { id: UUIDS.otherUser, account_status: 'ACTIVE', deleted_at: null } },
    });

    const error = await rejectionOf(createInvitation(createInput));
    expect(error.status).toBe(409);
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses when the client branch targets a missing organization (404)', async () => {
    scriptService({
      profilesRead: { data: null },
      tables: { organizations: { data: null } },
    });

    const error = await rejectionOf(createInvitation(createInput));
    expect(error.status).toBe(404);
  });

  it('re-issues (fresh token, same frozen terms) when the address is INVITED-but-never-accepted', async () => {
    const env = scriptService({
      profilesRead: { data: { id: UUIDS.otherUser, account_status: 'INVITED', deleted_at: null } },
      tables: {
        organizations: { data: { id: UUIDS.organization } },
        invitations: { data: invitationRow({ resent_count: 1 }) },
      },
    });

    const dto = await createInvitation(createInput);

    // The GoTrue invite is re-run; the ledger keeps the frozen terms.
    expect(env.service.spies.inviteUserByEmail).toHaveBeenCalled();
    expect(dto.status).toBe('PENDING');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'INVITE_SENT' }));
  });
});

/* ───────────────────────────── resend (§2.3) ───────────────────────────── */

describe('resendInvitation — frozen terms, rotated token', () => {
  const resendInput = {
    id: UUIDS.invitation,
    auth: actorContext,
    request: new Request('https://app.test/'),
    requestId: 'req-resend',
  };

  it('rotates the token on the same row and increments the guarded counter', async () => {
    const env = scriptService({
      invitationsRead: { data: invitationRow({ resent_count: 2 }) },
      invitationsWrite: {
        data: invitationRow({ resent_count: 3, last_sent_at: new Date().toISOString() }),
      },
    });

    const dto = await resendInvitation(resendInput);

    expect(env.spy('invitations:update').passthrough).toHaveBeenCalledWith(
      expect.objectContaining({ resent_count: 3 }),
    );
    expect(dto).toMatchObject({ status: 'PENDING', resentCount: 3 });
  });

  it('refuses to resend anything but a PENDING invitation', async () => {
    scriptService({
      tables: { invitations: { data: invitationRow({ status: 'ACCEPTED' }) } },
    });

    const error = await rejectionOf(resendInvitation(resendInput));
    expect(error.status).toBe(409);
  });

  it('refuses to resend an expired invitation — the operator creates a new one', async () => {
    scriptService({
      tables: {
        invitations: {
          data: invitationRow({ expires_at: new Date(Date.now() - 1000).toISOString() }),
        },
      },
    });

    const error = await rejectionOf(resendInvitation(resendInput));
    expect(error.status).toBe(409);
    expect(error.message).toContain('expired');
  });
});

/* ───────────────────────────── revoke (§2.3) ───────────────────────────── */

describe('revokeInvitation — terminal PENDING-only transition', () => {
  const revokeInput = {
    id: UUIDS.invitation,
    auth: actorContext,
    request: new Request('https://app.test/'),
    requestId: 'req-revoke',
  };

  it('flips the row to REVOKED with a guarded update and audits the STATUS_CHANGE', async () => {
    const env = scriptService({
      invitationsRead: { data: invitationRow() },
      invitationsWrite: { data: invitationRow({ status: 'REVOKED', revoked_by: UUIDS.user }) },
    });

    const dto = await revokeInvitation(revokeInput);

    expect(env.spy('invitations:update').passthrough).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'REVOKED', revoked_by: UUIDS.user }),
    );
    expect(dto.status).toBe('REVOKED');
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STATUS_CHANGE',
        before: { status: 'PENDING' },
        after: { status: 'REVOKED' },
      }),
    );
  });

  it('does NOT touch the GoTrue identity on revoke — an unconfirmed identity is inert', async () => {
    const env = scriptService({
      tables: { invitations: { data: invitationRow() } },
    });

    await revokeInvitation({ ...revokeInput, reason: 'wrong address' });

    expect(env.service.spies.inviteUserByEmail).not.toHaveBeenCalled();
    expect(env.service.spies.updateUserById).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ reason: 'wrong address' }));
  });

  it('refuses when the invitation already left PENDING', async () => {
    scriptService({
      tables: { invitations: { data: invitationRow({ status: 'REVOKED' }) } },
    });

    const error = await rejectionOf(revokeInvitation(revokeInput));
    expect(error.status).toBe(409);
  });

  it('reports 404 for an unknown invitation', async () => {
    scriptService({ tables: { invitations: { data: null } } });

    const error = await rejectionOf(revokeInvitation(revokeInput));
    expect(error.status).toBe(404);
  });
});

/* ─────────────────────── account status transitions (§8) ───────────────── */

describe('the account-status service — transitions, evictions, audit', () => {
  const input = (targetUserId: string): AccountTransitionInput => ({
    actor: { userId: UUIDS.user, platformRole: 'ADMIN' },
    targetUserId,
    reason: 'conduct investigation',
    requestId: 'req-status',
  });

  it('suspends: guarded status write, GoTrue ban, dual audit rows', async () => {
    const env = scriptService({
      profilesRead: { data: { id: UUIDS.otherUser, account_status: 'ACTIVE', deleted_at: null } },
      profilesWrite: { data: { id: UUIDS.otherUser, account_status: 'SUSPENDED' } },
    });

    const result = await suspendAccount(input(UUIDS.otherUser));

    expect(result).toMatchObject({
      userId: UUIDS.otherUser,
      accountStatus: 'SUSPENDED',
      membershipsDeactivated: 0,
      grantsRevoked: 0,
    });
    expect(env.spy('profiles:update').passthrough).toHaveBeenCalledWith(
      expect.objectContaining({ account_status: 'SUSPENDED' }),
    );
    // The eviction is the by-identity kill switch this client version offers.
    expect(env.service.spies.updateUserById).toHaveBeenCalledWith(UUIDS.otherUser, {
      ban_duration: '87600h',
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'STATUS_CHANGE',
        before: { accountStatus: 'ACTIVE' },
        after: { accountStatus: 'SUSPENDED' },
        reason: 'conduct investigation',
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SESSIONS_REVOKED',
        after: expect.objectContaining({ method: 'gotrue-ban' }),
      }),
    );
  });

  it('lifts the ban on reinstate and issues NO resurrected sessions', async () => {
    const env = scriptService({
      profilesRead: {
        data: { id: UUIDS.otherUser, account_status: 'SUSPENDED', deleted_at: null },
      },
      profilesWrite: { data: { id: UUIDS.otherUser, account_status: 'ACTIVE' } },
    });

    const result = await reinstateAccount(input(UUIDS.otherUser));

    expect(result.accountStatus).toBe('ACTIVE');
    expect(env.service.spies.updateUserById).toHaveBeenCalledWith(UUIDS.otherUser, {
      ban_duration: 'none',
    });
    expect(audit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SESSIONS_REVOKED' }));
  });

  it('deactivation offboards everywhere: memberships DEACTIVATED, grants revoked', async () => {
    const env = scriptService({
      profilesRead: { data: { id: UUIDS.otherUser, account_status: 'ACTIVE', deleted_at: null } },
      profilesWrite: { data: { id: UUIDS.otherUser, account_status: 'DEACTIVATED' } },
      tables: {
        organization_memberships: { data: [{ id: 'm1' }, { id: 'm2' }] },
        platform_role_grants: { data: [{ id: 'g1' }] },
      },
    });

    const result = await deactivateAccount(input(UUIDS.otherUser));

    expect(result.membershipsDeactivated).toBe(2);
    expect(result.grantsRevoked).toBe(1);
    expect(env.spy('organization_memberships').passthrough).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DEACTIVATED' }),
    );
    expect(env.service.spies.updateUserById).toHaveBeenCalledWith(UUIDS.otherUser, {
      ban_duration: '87600h',
    });
  });

  it('reactivate succeeds for SUPER_ADMIN and lifts the ban', async () => {
    const env = scriptService({
      profilesRead: {
        data: { id: UUIDS.otherUser, account_status: 'DEACTIVATED', deleted_at: null },
      },
      profilesWrite: { data: { id: UUIDS.otherUser, account_status: 'ACTIVE' } },
    });

    const result = await reactivateAccount({
      ...input(UUIDS.otherUser),
      actor: { userId: UUIDS.user, platformRole: 'SUPER_ADMIN' },
    });

    expect(result.accountStatus).toBe('ACTIVE');
    expect(env.service.spies.updateUserById).toHaveBeenCalledWith(UUIDS.otherUser, {
      ban_duration: 'none',
    });
  });

  it('reactivate is refused for a mere ADMIN — the service enforces the graph too', async () => {
    scriptService({
      profilesRead: {
        data: { id: UUIDS.otherUser, account_status: 'DEACTIVATED', deleted_at: null },
      },
    });

    const error = await rejectionOf(reactivateAccount(input(UUIDS.otherUser)));
    expect(error.status).toBe(403);
  });

  it('refuses an ADMIN from suspending a SUPER_ADMIN account (matrix [R] ceiling)', async () => {
    scriptService({
      profilesRead: {
        data: { id: UUIDS.otherUser, account_status: 'ACTIVE', deleted_at: null },
      },
      tables: {
        platform_role_grants: { data: [{ role: 'SUPER_ADMIN', expires_at: null }] },
      },
    });

    const error = await rejectionOf(suspendAccount(input(UUIDS.otherUser)));
    expect(error.status).toBe(403);
    expect(error.message).toContain('SUPER_ADMIN');
  });

  it('allows SUPER_ADMIN to suspend another SUPER_ADMIN (the ceiling is ADMIN-only)', async () => {
    const env = scriptService({
      profilesRead: {
        data: { id: UUIDS.otherUser, account_status: 'ACTIVE', deleted_at: null },
      },
      profilesWrite: { data: { id: UUIDS.otherUser, account_status: 'SUSPENDED' } },
      tables: {
        platform_role_grants: { data: [{ role: 'SUPER_ADMIN', expires_at: null }] },
      },
    });

    const result = await suspendAccount({
      ...input(UUIDS.otherUser),
      actor: { userId: UUIDS.user, platformRole: 'SUPER_ADMIN' },
    });

    expect(result.accountStatus).toBe('SUSPENDED');
    expect(env.spy('profiles:update').passthrough).toHaveBeenCalledWith(
      expect.objectContaining({ account_status: 'SUSPENDED' }),
    );
  });

  it('refuses self-service status changes — the suspender must stay auditable', async () => {
    scriptService({
      profilesRead: { data: { id: UUIDS.user, account_status: 'ACTIVE', deleted_at: null } },
    });

    const error = await rejectionOf(suspendAccount(input(UUIDS.user)));
    expect(error.status).toBe(400);
  });

  it('reports 404 (not 403) for an unknown or deleted target — equal answers', async () => {
    scriptService({ profilesRead: { data: null } });

    const error = await rejectionOf(suspendAccount(input(UUIDS.otherUser)));
    expect(error.status).toBe(404);
  });

  it('refuses an illegal edge outright (INVITED → SUSPENDED)', async () => {
    scriptService({
      profilesRead: { data: { id: UUIDS.otherUser, account_status: 'INVITED', deleted_at: null } },
    });

    const error = await rejectionOf(suspendAccount(input(UUIDS.otherUser)));
    expect(error.status).toBe(403);
    expect(error.message).toContain('illegal transition');
  });
});

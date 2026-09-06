import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@/lib/types/error-codes';
import { ApiError } from '@/server/api/errors';

/**
 * Phase 5 API audit — organization-membership object-scope regression tests.
 *
 * `organization:manage_members` is organization-qualified: a membership
 * manager of org P must not be able to mutate org Q's memberships by pairing
 * `/organizations/{P}/members/{membership-of-Q}`. `patchMember` /
 * `removeMember` delegate to definer RPCs (`update_organization_member`,
 * `remove_organization_member`), so the service must verify the addressed
 * row belongs to the path's organization BEFORE the RPC runs. The check uses
 * the caller-scoped `loadLive`, so an invisible row and a foreign-org row
 * both answer 404 (ADR-0019) and the write never happens.
 */

const { crudMock, rpcMock } = vi.hoisted(() => ({
  crudMock: {
    loadLive: vi.fn(),
    listLive: vi.fn(),
    updateLive: vi.fn(),
  },
  rpcMock: {
    callRpc: vi.fn(async () => undefined),
    callRpcVoid: vi.fn(async () => undefined),
  },
}));

vi.mock('@/server/services/crud', () => crudMock);
vi.mock('@/server/db/rpc', () => rpcMock);

// Static imports execute after the mocks are installed (vi.mock hoists).
import { patchMember, removeMember } from '@/server/services/memberships';

const MEMBERSHIP_ROW = {
  id: 'm-9',
  organization_id: 'org-9', // different org from the one named in the path
  user_id: 'u-9',
  role: 'CLIENT_MEMBER',
  status: 'ACTIVE',
  is_primary_contact: false,
  job_title: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  deleted_at: null,
  deleted_by: null,
};

describe('organization membership object-scope enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    crudMock.loadLive.mockResolvedValue(MEMBERSHIP_ROW);
  });

  it('patchMember refuses a membership that belongs to another organization', async () => {
    await expect(
      patchMember({
        organizationId: 'org-1',
        membershipId: 'm-9',
        role: 'CLIENT_ADMIN',
      }),
    ).rejects.toMatchObject({ status: 404, code: ErrorCode.NotFound });

    // The definer RPC never ran.
    expect(rpcMock.callRpcVoid).not.toHaveBeenCalled();
  });

  it('removeMember refuses a membership that belongs to another organization', async () => {
    await expect(
      removeMember({
        organizationId: 'org-1',
        membershipId: 'm-9',
        reason: 'offboarding',
      }),
    ).rejects.toMatchObject({ status: 404, code: ErrorCode.NotFound });

    expect(rpcMock.callRpcVoid).not.toHaveBeenCalled();
  });

  it('patchMember allows a membership of the organization named in the path', async () => {
    crudMock.loadLive.mockResolvedValue({ ...MEMBERSHIP_ROW, organization_id: 'org-1' });

    await expect(
      patchMember({
        organizationId: 'org-1',
        membershipId: 'm-9',
        role: 'CLIENT_ADMIN',
      }),
    ).resolves.toMatchObject({ role: 'CLIENT_MEMBER' });

    expect(rpcMock.callRpcVoid).toHaveBeenCalledWith(
      'update_organization_member',
      expect.anything(),
    );
    expect(rpcMock.callRpcVoid).toHaveBeenCalledTimes(1);
  });

  it('removeMember allows a membership of the organization named in the path', async () => {
    crudMock.loadLive.mockResolvedValue({ ...MEMBERSHIP_ROW, organization_id: 'org-1' });

    await expect(
      removeMember({
        organizationId: 'org-1',
        membershipId: 'm-9',
        reason: 'offboarding',
      }),
    ).resolves.toBeUndefined();

    expect(rpcMock.callRpcVoid).toHaveBeenCalledWith(
      'remove_organization_member',
      expect.anything(),
    );
    expect(rpcMock.callRpcVoid).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 404 from the underlying load when the row is invisible', async () => {
    crudMock.loadLive.mockRejectedValue(ApiError.notFound());

    await expect(
      patchMember({
        organizationId: 'org-1',
        membershipId: 'm-9',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(rpcMock.callRpcVoid).not.toHaveBeenCalled();
  });
});

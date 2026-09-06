import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthContext } from '@/lib/auth/context';

/**
 * Phase 5 API audit — object-scope regression tests.
 *
 * `project:manage_members` is project-qualified for ADMIN (the matrix's [P]
 * qualifier: an ADMIN must be a LEAD of the project NAMED IN THE PATH). A
 * membership row is addressed only by `membershipId` in the body-less
 * sub-route, so the service must verify the membership belongs to the path's
 * project. Before the fix, pairing `/projects/{P}/members/{membership-of-Q}`
 * let an ADMIN (LEAD of P only) alter project Q's membership in the same
 * organization. The fix answers 404 for the mismatch (ADR-0019: invisible and
 * missing are the same answer) and never performs the write.
 */

const { crudMock, mutationMock, tenantMock, supabaseMock } = vi.hoisted(() => ({
  crudMock: {
    loadLive: vi.fn(),
    updateLive: vi.fn(),
    softDeleteLive: vi.fn(),
    listLive: vi.fn(),
    actorStamp: vi.fn(() => ({ created_by: 'a', updated_by: 'a' })),
    requireParentId: vi.fn((value: string | undefined) => value as string),
  },
  mutationMock: { recordMutation: vi.fn(async () => undefined) },
  tenantMock: { isStaff: vi.fn(() => true) },
  supabaseMock: { createSupabaseServerClient: vi.fn(async () => ({ from: vi.fn() })) },
}));

vi.mock('@/server/services/crud', () => crudMock);
vi.mock('@/server/audit/mutation', () => mutationMock);
vi.mock('@/server/api/tenant', () => tenantMock);
vi.mock('@/server/supabase/client-server', () => supabaseMock);

// Static imports execute after the mocks are installed (vi.mock hoists).
import { ErrorCode } from '@/lib/types/error-codes';
import { ApiError } from '@/server/api/errors';
import { patchProjectMember, removeProjectMember } from '@/server/services/projects';

const PROFILE: AuthContext = {
  userId: 'actor-1',
  email: 'admin@growlith.test',
  fullName: 'Actor',
  userType: 'INTERNAL',
  accountStatus: 'ACTIVE',
  platformRole: 'ADMIN',
  memberships: [],
  teams: [],
  projectRoles: {},
  projectRolesOverflow: false,
  aal: 'aal2',
  mfaEnrolled: true,
  lastSeenAt: null,
};

const REQUEST = new Request('http://localhost/api/v1/projects/p-1/members/m-9', {
  method: 'PATCH',
});

const MEMBERSHIP_ROW = {
  id: 'm-9',
  organization_id: 'org-1',
  project_id: 'p-9', // different project from the one named in the path
  user_id: 'u-9',
  project_role: 'CONTRIBUTOR',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  deleted_at: null,
  deleted_by: null,
};

describe('project membership object-scope enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tenantMock.isStaff.mockReturnValue(true);
  });

  it('patchProjectMember refuses a membership that belongs to another project', async () => {
    crudMock.loadLive.mockResolvedValue(MEMBERSHIP_ROW);

    await expect(
      patchProjectMember({
        auth: PROFILE,
        request: REQUEST,
        requestId: 'req-1',
        projectId: 'p-1',
        membershipId: 'm-9',
        projectRole: 'LEAD',
      }),
    ).rejects.toMatchObject({ status: 404, code: ErrorCode.NotFound });

    // The write never ran.
    expect(crudMock.updateLive).not.toHaveBeenCalled();
    expect(mutationMock.recordMutation).not.toHaveBeenCalled();
  });

  it('removeProjectMember refuses a membership that belongs to another project', async () => {
    crudMock.loadLive.mockResolvedValue(MEMBERSHIP_ROW);

    await expect(
      removeProjectMember({
        auth: PROFILE,
        request: REQUEST,
        requestId: 'req-1',
        projectId: 'p-1',
        membershipId: 'm-9',
      }),
    ).rejects.toMatchObject({ status: 404, code: ErrorCode.NotFound });

    expect(crudMock.softDeleteLive).not.toHaveBeenCalled();
  });

  it('patchProjectMember allows a membership of the project named in the path', async () => {
    crudMock.loadLive.mockResolvedValue({ ...MEMBERSHIP_ROW, project_id: 'p-1' });
    crudMock.updateLive.mockResolvedValue({ ...MEMBERSHIP_ROW, project_id: 'p-1', project_role: 'LEAD' });

    await expect(
      patchProjectMember({
        auth: PROFILE,
        request: REQUEST,
        requestId: 'req-1',
        projectId: 'p-1',
        membershipId: 'm-9',
        projectRole: 'LEAD',
      }),
    ).resolves.toMatchObject({ projectRole: 'LEAD' });

    expect(crudMock.updateLive).toHaveBeenCalledTimes(1);
    expect(mutationMock.recordMutation).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 404 from the underlying load when the row is invisible', async () => {
    crudMock.loadLive.mockRejectedValue(ApiError.notFound());

    await expect(
      patchProjectMember({
        auth: PROFILE,
        request: REQUEST,
        requestId: 'req-1',
        projectId: 'p-1',
        membershipId: 'm-9',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

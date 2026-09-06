import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthContext } from '@/lib/auth/context';
import { ErrorCode } from '@/lib/types/error-codes';

/**
 * Phase 5 API audit — L-6 regression: `clientVisible` is not a field of the
 * CLIENT PATCH contract for `/files/{id}`. A client flipping its own upload
 * to client-visible after its parent became visible would publish an
 * internal attachment to the whole client audience; the field is refused
 * (422, before any write) for every non-staff actor, while renaming one's
 * own upload remains allowed and staff can still change visibility.
 */

const { crudMock, mutationMock } = vi.hoisted(() => ({
  crudMock: {
    loadLive: vi.fn(),
    updateLive: vi.fn(),
  },
  mutationMock: { recordMutation: vi.fn(async () => undefined) },
}));

vi.mock('@/server/services/crud', () => crudMock);
vi.mock('@/server/audit/mutation', () => mutationMock);

// Static imports execute after the mocks are installed (vi.mock hoists).
import { patchFile } from '@/server/services/files';

const CLIENT: AuthContext = {
  userId: 'user-1',
  email: 'client@growlith.test',
  fullName: 'Client',
  userType: 'CLIENT',
  accountStatus: 'ACTIVE',
  platformRole: null,
  memberships: [
    { organizationId: 'org-1', role: 'CLIENT_MEMBER', status: 'ACTIVE', isPrimaryContact: false },
  ],
  teams: [],
  projectRoles: {},
  projectRolesOverflow: false,
  aal: 'aal1',
  mfaEnrolled: false,
  lastSeenAt: null,
};

const ROW = {
  id: 'file-1',
  organization_id: 'org-1',
  storage_bucket: 'growlith-private',
  storage_path: 'org-1/attachment/uuid/name.pdf',
  file_name: 'name.pdf',
  mime_type: 'application/pdf',
  size_bytes: 100,
  file_kind: 'ATTACHMENT',
  client_visible: false,
  virus_scan_status: 'CLEAN',
  uploaded_by: 'user-1',
  project_id: null,
  deliverable_id: null,
  task_id: null,
  report_id: null,
  comment_id: null,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  deleted_at: null,
  deleted_by: null,
};

describe('PATCH /files/{id} — clientVisible is staff-only (L-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    crudMock.loadLive.mockResolvedValue(ROW);
  });

  it('refuses a CLIENT flipping clientVisible on its own upload', async () => {
    const request = new Request('http://localhost/api/v1/files/file-1', { method: 'PATCH' });
    await expect(
      patchFile({ id: 'file-1', body: { clientVisible: true }, auth: CLIENT, request, requestId: 'r1' }),
    ).rejects.toMatchObject({ status: 422, code: ErrorCode.ValidationFailed });

    expect(crudMock.updateLive).not.toHaveBeenCalled();
    expect(mutationMock.recordMutation).not.toHaveBeenCalled();
  });

  it('still allows a CLIENT to rename its own upload', async () => {
    crudMock.updateLive.mockResolvedValue({ ...ROW, file_name: 'renamed.pdf' });
    const request = new Request('http://localhost/api/v1/files/file-1', { method: 'PATCH' });
    await expect(
      patchFile({ id: 'file-1', body: { fileName: 'renamed.pdf' }, auth: CLIENT, request, requestId: 'r1' }),
    ).resolves.toMatchObject({ fileName: 'renamed.pdf' });
    expect(crudMock.updateLive).toHaveBeenCalledTimes(1);
  });

  it('lets staff change clientVisible', async () => {
    crudMock.updateLive.mockResolvedValue({ ...ROW, client_visible: true });
    const request = new Request('http://localhost/api/v1/files/file-1', { method: 'PATCH' });
    const STAFF: AuthContext = { ...CLIENT, userType: 'INTERNAL', platformRole: 'ADMIN' };
    await expect(
      patchFile({ id: 'file-1', body: { clientVisible: true }, auth: STAFF, request, requestId: 'r1' }),
    ).resolves.toMatchObject({ clientVisible: true });
    expect(crudMock.updateLive).toHaveBeenCalledTimes(1);
  });
});

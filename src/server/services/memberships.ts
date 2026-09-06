import 'server-only';

import type { PageResult } from '@/lib/types/pagination';
import { toMembershipDto, type MembershipDto } from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { callRpc, callRpcVoid } from '@/server/db/rpc';
import { listLive, loadLive } from '@/server/services/crud';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type MembershipRow = Database['public']['Tables']['organization_memberships']['Row'];

export async function listMembers(input: {
  readonly organizationId: string;
  readonly query: PaginationQuery & {
    readonly status?: readonly string[] | undefined;
    readonly role?: readonly string[] | undefined;
  };
}): Promise<PageResult<MembershipDto>> {
  const page = await listLive<MembershipRow>({
    table: 'organization_memberships',
    query: input.query,
    allowedSorts: ['createdAt'],
    // C-6: the roster is join order — earliest member first.
    ascendingKeys: ['createdAt'],
    apply: (q) => {
      let next = q.eq('organization_id', input.organizationId);
      if (input.query.status !== undefined && input.query.status.length > 0) {
        next = next.in('status', [...input.query.status]);
      }
      if (input.query.role !== undefined && input.query.role.length > 0) {
        next = next.in('role', [...input.query.role]);
      }
      return next;
    },
  });
  return { data: page.data.map(toMembershipDto), pagination: page.pagination };
}

export async function addMember(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: MembershipRow['role'];
  readonly jobTitle?: string | undefined;
}): Promise<MembershipDto> {
  const id = await callRpc<string>('add_organization_member', {
    p_organization_id: input.organizationId,
    p_user_id: input.userId,
    p_role: input.role,
    p_job_title: input.jobTitle ?? null,
  });
  if (typeof id !== 'string') {
    throw ApiError.serviceUnavailable('The membership could not be created.');
  }
  const row = await loadLive<MembershipRow>('organization_memberships', id);
  return toMembershipDto(row);
}

/**
 * Organization memberships are addressed by `membershipId` alone under the
 * `/organizations/{organizationId}/members/{membershipId}` path, so the
 * service must prove the membership belongs to the organization NAMED IN THE
 * PATH before delegating to the definer RPC. `organization:manage_members` is
 * organization-qualified (a member manager of org P cannot manage org Q by
 * presenting one of Q's membership ids through P's path). The check runs
 * through the caller's own RLS (`loadLive`), so a row in a tenant the caller
 * cannot see answers exactly like a missing row — 404, never 403 (ADR-0019).
 */
async function requireMembershipInOrganization(
  organizationId: string,
  membershipId: string,
): Promise<void> {
  const row = await loadLive<MembershipRow>('organization_memberships', membershipId);
  if (row.organization_id !== organizationId) {
    throw ApiError.notFound();
  }
}

export async function patchMember(input: {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly role?: MembershipRow['role'] | undefined;
  readonly status?: MembershipRow['status'] | undefined;
  readonly isPrimaryContact?: boolean | undefined;
  readonly newPrimaryMembershipId?: string | undefined;
  readonly jobTitle?: string | undefined;
}): Promise<MembershipDto> {
  await requireMembershipInOrganization(input.organizationId, input.membershipId);
  await callRpcVoid('update_organization_member', {
    p_membership_id: input.membershipId,
    p_role: input.role ?? null,
    p_status: input.status ?? null,
    p_is_primary_contact: input.isPrimaryContact ?? null,
    p_new_primary_membership_id: input.newPrimaryMembershipId ?? null,
    p_job_title: input.jobTitle ?? null,
  });
  const row = await loadLive<MembershipRow>('organization_memberships', input.membershipId);
  return toMembershipDto(row);
}

export async function removeMember(input: {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly newPrimaryMembershipId?: string | undefined;
  readonly reason?: string | undefined;
}): Promise<void> {
  await requireMembershipInOrganization(input.organizationId, input.membershipId);
  await callRpcVoid('remove_organization_member', {
    p_membership_id: input.membershipId,
    p_new_primary_membership_id: input.newPrimaryMembershipId ?? null,
    p_reason: input.reason ?? null,
  });
}

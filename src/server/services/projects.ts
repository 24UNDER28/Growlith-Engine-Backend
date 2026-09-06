import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import {
  toProjectDto,
  toProjectMembershipDto,
  type ProjectDto,
  type ProjectMembershipDto,
} from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { isStaff } from '@/server/api/tenant';
import { recordMutation } from '@/server/audit/mutation';
import { throwIfError } from '@/server/db/errors';
import {
  actorStamp,
  listLive,
  loadLive,
  requireParentId,
  softDeleteLive,
  updateLive,
} from '@/server/services/crud';
import { enrichByIds } from '@/server/services/enrich';
import { changeStatus } from '@/server/services/status';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type Row = Database['public']['Tables']['projects']['Row'];
type MemberRow = Database['public']['Tables']['project_memberships']['Row'];

export async function listProjects(input: {
  readonly query: PaginationQuery & {
    readonly organizationId?: string | undefined;
    readonly serviceId?: string | undefined;
    readonly status?: readonly string[] | undefined;
    readonly owningTeam?: readonly string[] | undefined;
  };
}): Promise<PageResult<ProjectDto>> {
  const page = await listLive<Row>({
    table: 'projects',
    query: input.query,
    allowedSorts: ['createdAt', 'startDate', 'targetDate'],
    // H-2: targetDate is the deadline view — soonest deadline first.
    ascendingKeys: ['targetDate'],
    apply: (q) => {
      let next = q;
      if (input.query.organizationId !== undefined) next = next.eq('organization_id', input.query.organizationId);
      if (input.query.serviceId !== undefined) next = next.eq('service_id', input.query.serviceId);
      if (input.query.status !== undefined && input.query.status.length > 0) {
        next = next.in('status', [...input.query.status]);
      }
      if (input.query.owningTeam !== undefined && input.query.owningTeam.length > 0) {
        next = next.in('owning_team', [...input.query.owningTeam]);
      }
      return next;
    },
  });
  return { data: page.data.map(toProjectDto), pagination: page.pagination };
}

export async function getProject(id: string): Promise<ProjectDto> {
  return toProjectDto(await loadLive<Row>('projects', id));
}

export async function createProject(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly serviceId?: string | undefined;
    readonly code: string;
    readonly name: string;
    readonly description?: string | undefined;
    readonly priority?: Row['priority'] | undefined;
    readonly health?: Row['health'] | undefined;
    readonly owningTeam: Row['owning_team'];
    readonly leadUserId?: string | undefined;
    readonly startDate?: string | undefined;
    readonly targetDate?: string | undefined;
    readonly clientVisible?: boolean | undefined;
  };
}): Promise<ProjectDto> {
  const serviceId = requireParentId(input.body.serviceId, 'serviceId');
  const parent = await loadLive<{ organization_id: string }>('services', serviceId);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('projects')
    .insert({
      organization_id: parent.organization_id,
      service_id: serviceId,
      code: input.body.code,
      name: input.body.name,
      description: input.body.description ?? null,
      priority: input.body.priority ?? 'MEDIUM',
      health: input.body.health ?? 'ON_TRACK',
      owning_team: input.body.owningTeam,
      lead_user_id: input.body.leadUserId ?? null,
      start_date: input.body.startDate ?? null,
      target_date: input.body.targetDate ?? null,
      client_visible: input.body.clientVisible ?? true,
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) throw ApiError.serviceUnavailable('The project could not be created.');
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'project',
    entityId: data.id,
    organizationId: data.organization_id,
    after: { code: data.code, name: data.name },
  });
  return toProjectDto(data);
}

export async function patchProject(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: Record<string, unknown>;
}): Promise<ProjectDto> {
  const map: Record<string, string> = {
    name: 'name',
    description: 'description',
    priority: 'priority',
    health: 'health',
    startDate: 'start_date',
    targetDate: 'target_date',
    clientVisible: 'client_visible',
  };
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  for (const [from, to] of Object.entries(map)) {
    if (input.body[from] !== undefined) patch[to] = input.body[from];
  }
  const updated = await updateLive<Row>('projects', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'project',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toProjectDto(updated);
}

export async function deleteProject(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const row = await loadLive<Row>('projects', input.id);
  await softDeleteLive('projects', input.id, input.auth.userId);
  await recordMutation({
    action: 'SOFT_DELETE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'project',
    entityId: input.id,
    organizationId: row.organization_id,
  });
}

export async function assignProject(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly leadUserId?: string | null | undefined;
  readonly owningTeam?: Row['owning_team'] | undefined;
}): Promise<ProjectDto> {
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  if (input.leadUserId !== undefined) patch.lead_user_id = input.leadUserId;
  if (input.owningTeam !== undefined) patch.owning_team = input.owningTeam;
  const updated = await updateLive<Row>('projects', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'project',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toProjectDto(updated);
}

export async function changeProjectStatus(input: {
  readonly id: string;
  readonly status: string;
  readonly reason?: string | undefined;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<ProjectDto> {
  const extra: Record<string, unknown> = {};
  if (input.status === 'COMPLETED') extra.completed_at = new Date().toISOString();
  const updated = await changeStatus<Row>({
    table: 'projects',
    entityKind: 'project',
    id: input.id,
    toStatus: input.status,
    reason: input.reason,
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    extra,
  });
  return toProjectDto(updated);
}

export async function listProjectMembers(input: {
  readonly auth: AuthContext;
  readonly projectId: string;
  readonly query: PaginationQuery;
}): Promise<PageResult<ProjectMembershipDto>> {
  const staff = isStaff(input.auth);
  const page = await listLive<MemberRow>({
    table: 'project_memberships',
    select:
      'id, organization_id, project_id, user_id, project_role, created_at, updated_at, deleted_at, deleted_by',
    query: input.query,
    allowedSorts: ['createdAt'],
    // H-8: the project roster is join order — earliest member first.
    ascendingKeys: ['createdAt'],
    apply: (q) => q.eq('project_id', input.projectId),
  });
  if (!staff) {
    return {
      data: page.data.map((row) => toProjectMembershipDto(row, false)),
      pagination: page.pagination,
    };
  }
  const extra = await enrichByIds(
    'project_memberships',
    page.data.map((row) => row.id),
    'allocation_pct',
  );
  return {
    data: page.data.map((row) =>
      toProjectMembershipDto({ ...row, ...(extra.get(row.id) ?? {}) }, true),
    ),
    pagination: page.pagination,
  };
}

export async function addProjectMember(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly projectId: string;
  readonly userId: string;
  readonly projectRole: MemberRow['project_role'];
  readonly allocationPct?: number | undefined;
}): Promise<ProjectMembershipDto> {
  const project = await loadLive<Row>('projects', input.projectId);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('project_memberships')
    .insert({
      organization_id: project.organization_id,
      project_id: input.projectId,
      user_id: input.userId,
      project_role: input.projectRole,
      allocation_pct: input.allocationPct ?? null,
      added_by: input.auth.userId,
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) throw ApiError.serviceUnavailable('The project member could not be added.');
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'project',
    entityId: input.projectId,
    organizationId: project.organization_id,
    after: { userId: input.userId, projectRole: input.projectRole },
  });
  return toProjectMembershipDto(data, true);
}

export async function patchProjectMember(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly projectRole?: MemberRow['project_role'] | undefined;
  readonly allocationPct?: number | null | undefined;
}): Promise<ProjectMembershipDto> {
  // Object-scope check: `project:manage_members` is gated per project (an
  // ADMIN must hold a LEAD membership in THIS project — the matrix's [P]
  // qualifier), so the addressed membership must belong to the project named
  // in the path. Without the check an ADMIN who leads project P could edit a
  // membership row of project Q in the same organization by pairing Q's
  // membershipId with P's path. Invisible-or-missing answers 404 (ADR-0019).
  const existing = await loadLive<MemberRow>('project_memberships', input.membershipId);
  if (existing.project_id !== input.projectId) {
    throw ApiError.notFound();
  }
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  if (input.projectRole !== undefined) patch.project_role = input.projectRole;
  if (input.allocationPct !== undefined) patch.allocation_pct = input.allocationPct;
  const updated = await updateLive<MemberRow>('project_memberships', input.membershipId, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'project',
    entityId: updated.project_id,
    organizationId: updated.organization_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toProjectMembershipDto(updated, isStaff(input.auth));
}

export async function removeProjectMember(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly projectId: string;
  readonly membershipId: string;
}): Promise<void> {
  // Same object-scope rule as patchProjectMember: the membership must belong
  // to the project named in the path (see comment above).
  const row = await loadLive<MemberRow>('project_memberships', input.membershipId);
  if (row.project_id !== input.projectId) {
    throw ApiError.notFound();
  }
  await softDeleteLive('project_memberships', input.membershipId, input.auth.userId);
  await recordMutation({
    action: 'SOFT_DELETE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'project',
    entityId: row.project_id,
    organizationId: row.organization_id,
  });
}

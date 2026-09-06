import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toTaskDto, type TaskDto } from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
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
import { changeStatus } from '@/server/services/status';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type Row = Database['public']['Tables']['tasks']['Row'];

export async function listTasks(input: {
  readonly query: PaginationQuery & {
    readonly organizationId?: string | undefined;
    readonly projectId?: string | undefined;
    readonly deliverableId?: string | undefined;
    readonly status?: readonly string[] | undefined;
    readonly assigneeUserId?: string | undefined;
  };
}): Promise<PageResult<TaskDto>> {
  const page = await listLive<Row>({
    table: 'tasks',
    query: input.query,
    allowedSorts: ['createdAt', 'dueDate', 'position'],
    // I-2: dueDate is the deadline view; position is the board order — both
    // ascend (soonest due first; board position 1 first).
    ascendingKeys: ['dueDate', 'position'],
    apply: (q) => {
      let next = q;
      if (input.query.organizationId !== undefined) next = next.eq('organization_id', input.query.organizationId);
      if (input.query.projectId !== undefined) next = next.eq('project_id', input.query.projectId);
      if (input.query.deliverableId !== undefined) next = next.eq('deliverable_id', input.query.deliverableId);
      if (input.query.status !== undefined && input.query.status.length > 0) {
        next = next.in('status', [...input.query.status]);
      }
      if (input.query.assigneeUserId !== undefined) next = next.eq('assignee_user_id', input.query.assigneeUserId);
      return next;
    },
  });
  return { data: page.data.map(toTaskDto), pagination: page.pagination };
}

export async function getTask(id: string): Promise<TaskDto> {
  return toTaskDto(await loadLive<Row>('tasks', id));
}

export async function createTask(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly projectId?: string | undefined;
    readonly deliverableId?: string | undefined;
    readonly title: string;
    readonly description?: string | undefined;
    readonly priority?: Row['priority'] | undefined;
    readonly assigneeUserId?: string | undefined;
    readonly assignedTeam?: Row['assigned_team'] | undefined;
    readonly dueDate?: string | undefined;
    readonly estimatedHours?: number | undefined;
  };
}): Promise<TaskDto> {
  const projectId = requireParentId(input.body.projectId, 'projectId');
  const project = await loadLive<{ organization_id: string }>('projects', projectId);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      organization_id: project.organization_id,
      project_id: projectId,
      deliverable_id: input.body.deliverableId ?? null,
      title: input.body.title,
      description: input.body.description ?? null,
      priority: input.body.priority ?? 'MEDIUM',
      assignee_user_id: input.body.assigneeUserId ?? null,
      assigned_team: input.body.assignedTeam ?? null,
      due_date: input.body.dueDate ?? null,
      estimated_hours: input.body.estimatedHours ?? null,
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) throw ApiError.serviceUnavailable('The task could not be created.');
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'task',
    entityId: data.id,
    organizationId: data.organization_id,
    after: { title: data.title },
  });
  return toTaskDto(data);
}

export async function patchTask(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: Record<string, unknown>;
}): Promise<TaskDto> {
  const map: Record<string, string> = {
    title: 'title',
    description: 'description',
    priority: 'priority',
    assignedTeam: 'assigned_team',
    dueDate: 'due_date',
    estimatedHours: 'estimated_hours',
    actualHours: 'actual_hours',
    blockedReason: 'blocked_reason',
    position: 'position',
  };
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  for (const [from, to] of Object.entries(map)) {
    if (input.body[from] !== undefined) patch[to] = input.body[from];
  }
  const updated = await updateLive<Row>('tasks', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'task',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toTaskDto(updated);
}

export async function deleteTask(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const row = await loadLive<Row>('tasks', input.id);
  await softDeleteLive('tasks', input.id, input.auth.userId);
  await recordMutation({
    action: 'SOFT_DELETE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'task',
    entityId: input.id,
    organizationId: row.organization_id,
  });
}

export async function assignTask(input: {
  readonly id: string;
  readonly assigneeUserId: string | null;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<TaskDto> {
  const updated = await updateLive<Row>('tasks', input.id, {
    assignee_user_id: input.assigneeUserId,
    updated_by: input.auth.userId,
  });
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'task',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: ['assignee_user_id'],
  });
  return toTaskDto(updated);
}

export async function changeTaskStatus(input: {
  readonly id: string;
  readonly status: string;
  readonly reason?: string | undefined;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<TaskDto> {
  const extra: Record<string, unknown> = {};
  if (input.status === 'IN_PROGRESS') extra.started_at = new Date().toISOString();
  if (input.status === 'DONE') extra.completed_at = new Date().toISOString();
  const updated = await changeStatus<Row>({
    table: 'tasks',
    entityKind: 'task',
    id: input.id,
    toStatus: input.status,
    reason: input.reason,
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    extra,
  });
  return toTaskDto(updated);
}

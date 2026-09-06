import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toDeliverableDto, type DeliverableDto } from '@/lib/dto/mappers';
import { ApiError } from '@/server/api/errors';
import { recordMutation } from '@/server/audit/mutation';
import { throwIfError } from '@/server/db/errors';
import { callRpcVoid } from '@/server/db/rpc';
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

type Row = Database['public']['Tables']['deliverables']['Row'];
type VersionRow = Database['public']['Tables']['deliverable_versions']['Row'];

export async function listDeliverables(input: {
  readonly query: PaginationQuery & {
    readonly organizationId?: string | undefined;
    readonly projectId?: string | undefined;
    readonly status?: readonly string[] | undefined;
  };
}): Promise<PageResult<DeliverableDto>> {
  const page = await listLive<Row>({
    table: 'deliverables',
    query: input.query,
    allowedSorts: ['createdAt', 'dueDate'],
    // J-2: dueDate is the deadline view — soonest due first.
    ascendingKeys: ['dueDate'],
    apply: (q) => {
      let next = q;
      if (input.query.organizationId !== undefined)
        next = next.eq('organization_id', input.query.organizationId);
      if (input.query.projectId !== undefined) next = next.eq('project_id', input.query.projectId);
      if (input.query.status !== undefined && input.query.status.length > 0) {
        next = next.in('status', [...input.query.status]);
      }
      return next;
    },
  });
  return { data: page.data.map(toDeliverableDto), pagination: page.pagination };
}

export async function getDeliverable(id: string): Promise<DeliverableDto> {
  return toDeliverableDto(await loadLive<Row>('deliverables', id));
}

export async function createDeliverable(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly projectId: string;
    readonly title: string;
    readonly description?: string | undefined;
    readonly deliverableType: Row['deliverable_type'];
    readonly dueDate?: string | undefined;
    readonly ownerUserId?: string | undefined;
    readonly clientVisible?: boolean | undefined;
  };
}): Promise<DeliverableDto> {
  const projectId = requireParentId(input.body.projectId, 'projectId');
  const project = await loadLive<{ organization_id: string }>('projects', projectId);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('deliverables')
    .insert({
      organization_id: project.organization_id,
      project_id: projectId,
      title: input.body.title,
      description: input.body.description ?? null,
      deliverable_type: input.body.deliverableType,
      due_date: input.body.dueDate ?? null,
      owner_user_id: input.body.ownerUserId ?? null,
      client_visible: input.body.clientVisible ?? false,
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) throw ApiError.serviceUnavailable('The deliverable could not be created.');
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'deliverable',
    entityId: data.id,
    organizationId: data.organization_id,
    after: { title: data.title },
  });
  return toDeliverableDto(data);
}

export async function patchDeliverable(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: Record<string, unknown>;
}): Promise<DeliverableDto> {
  const map: Record<string, string> = {
    title: 'title',
    description: 'description',
    deliverableType: 'deliverable_type',
    dueDate: 'due_date',
    clientVisible: 'client_visible',
  };
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  for (const [from, to] of Object.entries(map)) {
    if (input.body[from] !== undefined) patch[to] = input.body[from];
  }
  const updated = await updateLive<Row>('deliverables', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'deliverable',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toDeliverableDto(updated);
}

export async function deleteDeliverable(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const row = await loadLive<Row>('deliverables', input.id);
  await softDeleteLive('deliverables', input.id, input.auth.userId);
  await recordMutation({
    action: 'SOFT_DELETE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'deliverable',
    entityId: input.id,
    organizationId: row.organization_id,
  });
}

export async function assignDeliverable(input: {
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<DeliverableDto> {
  const updated = await updateLive<Row>('deliverables', input.id, {
    owner_user_id: input.ownerUserId,
    updated_by: input.auth.userId,
  });
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'deliverable',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: ['owner_user_id'],
  });
  return toDeliverableDto(updated);
}

export async function changeDeliverableStatus(input: {
  readonly id: string;
  readonly status: string;
  readonly reason?: string | undefined;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<DeliverableDto> {
  const extra: Record<string, unknown> = {};
  if (input.status === 'PUBLISHED') extra.client_visible = true;
  const updated = await changeStatus<Row>({
    table: 'deliverables',
    entityKind: 'deliverable',
    id: input.id,
    toStatus: input.status,
    reason: input.reason,
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    extra,
  });
  return toDeliverableDto(updated);
}

export async function approveDeliverable(input: {
  readonly id: string;
  readonly outcome: Database['public']['Enums']['review_outcome'];
  readonly notes?: string | undefined;
}): Promise<DeliverableDto> {
  await callRpcVoid('approve_deliverable', {
    p_deliverable_id: input.id,
    p_outcome: input.outcome,
    p_notes: input.notes ?? null,
  });
  return getDeliverable(input.id);
}

export async function submitDeliverableReview(input: {
  readonly id: string;
  readonly outcome: Database['public']['Enums']['review_outcome'];
  readonly notes?: string | undefined;
  readonly summary?: string | undefined;
}): Promise<DeliverableDto> {
  await callRpcVoid('submit_deliverable_review', {
    p_deliverable_id: input.id,
    p_outcome: input.outcome,
    p_notes: input.notes ?? null,
    p_summary: input.summary ?? null,
  });
  return getDeliverable(input.id);
}

export async function listDeliverableVersions(id: string): Promise<readonly VersionRow[]> {
  await loadLive<Row>('deliverables', id);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('deliverable_versions')
    .select('*')
    .eq('deliverable_id', id)
    .order('version_number', { ascending: false });
  throwIfError(error, 'read');
  return data ?? [];
}

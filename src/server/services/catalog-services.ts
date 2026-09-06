import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toServiceDto, type ServiceDto } from '@/lib/dto/mappers';
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

type Row = Database['public']['Tables']['services']['Row'];

const PUBLIC_SELECT =
  'id, organization_id, engagement_id, service_line, delivering_team, name, scope_summary, status, currency, start_date, end_date, lead_user_id, created_at, updated_at, deleted_at';

async function toDto(row: Row, staff: boolean): Promise<ServiceDto> {
  if (!staff) {
    return toServiceDto(row, false);
  }
  const extra = await enrichByIds('services', [row.id], 'fee, fee_model');
  return toServiceDto({ ...row, ...(extra.get(row.id) ?? {}) }, true);
}

export async function listServices(input: {
  readonly auth: AuthContext;
  readonly query: PaginationQuery & {
    readonly organizationId?: string | undefined;
    readonly engagementId?: string | undefined;
    readonly status?: readonly string[] | undefined;
    readonly serviceLine?: readonly string[] | undefined;
  };
}): Promise<PageResult<ServiceDto>> {
  const staff = isStaff(input.auth);
  const page = await listLive<Row>({
    table: 'services',
    select: PUBLIC_SELECT,
    query: input.query,
    allowedSorts: ['createdAt', 'startDate'],
    apply: (q) => {
      let next = q;
      if (input.query.organizationId !== undefined)
        next = next.eq('organization_id', input.query.organizationId);
      if (input.query.engagementId !== undefined)
        next = next.eq('engagement_id', input.query.engagementId);
      if (input.query.status !== undefined && input.query.status.length > 0) {
        next = next.in('status', [...input.query.status]);
      }
      if (input.query.serviceLine !== undefined && input.query.serviceLine.length > 0) {
        next = next.in('service_line', [...input.query.serviceLine]);
      }
      return next;
    },
  });
  if (!staff) {
    return { data: page.data.map((row) => toServiceDto(row, false)), pagination: page.pagination };
  }
  const extra = await enrichByIds(
    'services',
    page.data.map((row) => row.id),
    'fee, fee_model',
  );
  return {
    data: page.data.map((row) => toServiceDto({ ...row, ...(extra.get(row.id) ?? {}) }, true)),
    pagination: page.pagination,
  };
}

export async function getService(id: string, auth: AuthContext): Promise<ServiceDto> {
  return toDto(await loadLive<Row>('services', id), isStaff(auth));
}

export async function createService(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly engagementId?: string | undefined;
    readonly serviceLine: Row['service_line'];
    readonly deliveringTeam: Row['delivering_team'];
    readonly name: string;
    readonly scopeSummary?: string | undefined;
    readonly currency: Row['currency'];
    readonly startDate: string;
    readonly endDate?: string | undefined;
    readonly fee?: number | undefined;
    readonly feeModel?: Row['fee_model'] | undefined;
    readonly leadUserId?: string | undefined;
  };
}): Promise<ServiceDto> {
  const engagementId = requireParentId(input.body.engagementId, 'engagementId');
  const parent = await loadLive<{ organization_id: string }>('engagements', engagementId);
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('services')
    .insert({
      organization_id: parent.organization_id,
      engagement_id: engagementId,
      service_line: input.body.serviceLine,
      delivering_team: input.body.deliveringTeam,
      name: input.body.name,
      scope_summary: input.body.scopeSummary ?? null,
      currency: input.body.currency,
      start_date: input.body.startDate,
      end_date: input.body.endDate ?? null,
      fee: input.body.fee ?? null,
      fee_model: input.body.feeModel ?? 'RETAINER',
      lead_user_id: input.body.leadUserId ?? null,
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) throw ApiError.serviceUnavailable('The service could not be created.');
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'service',
    entityId: data.id,
    organizationId: data.organization_id,
    after: { name: data.name, serviceLine: data.service_line },
  });
  return toDto(data, true);
}

export async function patchService(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: Record<string, unknown>;
}): Promise<ServiceDto> {
  const map: Record<string, string> = {
    name: 'name',
    scopeSummary: 'scope_summary',
    deliveringTeam: 'delivering_team',
    currency: 'currency',
    startDate: 'start_date',
    endDate: 'end_date',
    fee: 'fee',
    feeModel: 'fee_model',
  };
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  for (const [from, to] of Object.entries(map)) {
    if (input.body[from] !== undefined) patch[to] = input.body[from];
  }
  const updated = await updateLive<Row>('services', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'service',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toDto(updated, isStaff(input.auth));
}

export async function deleteService(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const row = await loadLive<Row>('services', input.id);
  await softDeleteLive('services', input.id, input.auth.userId);
  await recordMutation({
    action: 'SOFT_DELETE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'service',
    entityId: input.id,
    organizationId: row.organization_id,
  });
}

export async function assignService(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly leadUserId?: string | null | undefined;
  readonly deliveringTeam?: Row['delivering_team'] | undefined;
}): Promise<ServiceDto> {
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  if (input.leadUserId !== undefined) patch.lead_user_id = input.leadUserId;
  if (input.deliveringTeam !== undefined) patch.delivering_team = input.deliveringTeam;
  const updated = await updateLive<Row>('services', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'service',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toDto(updated, isStaff(input.auth));
}

export async function changeServiceStatus(input: {
  readonly id: string;
  readonly status: string;
  readonly reason?: string | undefined;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<ServiceDto> {
  const updated = await changeStatus<Row>({
    table: 'services',
    entityKind: 'service',
    id: input.id,
    toStatus: input.status,
    reason: input.reason,
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
  });
  return toDto(updated, isStaff(input.auth));
}

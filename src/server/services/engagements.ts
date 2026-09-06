import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toEngagementDto, type EngagementDto } from '@/lib/dto/mappers';
import { recordMutation } from '@/server/audit/mutation';
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
import { isStaff } from '@/server/api/tenant';
import { throwIfError } from '@/server/db/errors';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import { ApiError } from '@/server/api/errors';
import type { Database } from '@/types/database';
import type { PaginationQuery } from '@/lib/validation/pagination';

type Row = Database['public']['Tables']['engagements']['Row'];

const PUBLIC_SELECT =
  'id, organization_id, code, name, engagement_type, status, currency, start_date, end_date, renewal_date, account_manager_user_id, signed_at, created_at, updated_at, deleted_at';

async function toDto(row: Row | Record<string, unknown>, staff: boolean): Promise<EngagementDto> {
  if (!staff) {
    return toEngagementDto(row as Parameters<typeof toEngagementDto>[0], false);
  }
  const extra = await enrichByIds('engagements', [(row as { id: string }).id], 'contract_value, monthly_retainer, notes_internal');
  const merged = { ...(row as object), ...(extra.get((row as { id: string }).id) ?? {}) };
  return toEngagementDto(merged as Parameters<typeof toEngagementDto>[0], true);
}

export async function listEngagements(input: {
  readonly auth: AuthContext;
  readonly query: PaginationQuery & {
    readonly organizationId?: string | undefined;
    readonly status?: readonly string[] | undefined;
    readonly engagementType?: readonly string[] | undefined;
  };
}): Promise<PageResult<EngagementDto>> {
  const staff = isStaff(input.auth);
  const page = await listLive<Row>({
    table: 'engagements',
    select: PUBLIC_SELECT,
    query: input.query,
    allowedSorts: ['createdAt', 'startDate', 'renewalDate'],
    apply: (q) => {
      let next = q;
      if (input.query.organizationId !== undefined) {
        next = next.eq('organization_id', input.query.organizationId);
      }
      if (input.query.status !== undefined && input.query.status.length > 0) {
        next = next.in('status', [...input.query.status]);
      }
      if (input.query.engagementType !== undefined && input.query.engagementType.length > 0) {
        next = next.in('engagement_type', [...input.query.engagementType]);
      }
      return next;
    },
  });
  if (!staff) {
    return { data: page.data.map((row) => toEngagementDto(row, false)), pagination: page.pagination };
  }
  const extra = await enrichByIds(
    'engagements',
    page.data.map((row) => row.id),
    'contract_value, monthly_retainer, notes_internal',
  );
  return {
    data: page.data.map((row) =>
      toEngagementDto({ ...row, ...(extra.get(row.id) ?? {}) }, true),
    ),
    pagination: page.pagination,
  };
}

export async function getEngagement(id: string, auth: AuthContext): Promise<EngagementDto> {
  const row = await loadLive<Row>('engagements', id);
  return toDto(row, isStaff(auth));
}

export async function createEngagement(input: {
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: {
    readonly organizationId?: string | undefined;
    readonly code: string;
    readonly name: string;
    readonly engagementType: Row['engagement_type'];
    readonly currency: Row['currency'];
    readonly startDate: string;
    readonly endDate?: string | undefined;
    readonly renewalDate?: string | undefined;
    readonly contractValue?: number | undefined;
    readonly monthlyRetainer?: number | undefined;
    readonly notesInternal?: string | undefined;
    readonly accountManagerUserId?: string | undefined;
  };
}): Promise<EngagementDto> {
  const organizationId = requireParentId(input.body.organizationId, 'organizationId');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('engagements')
    .insert({
      organization_id: organizationId,
      code: input.body.code,
      name: input.body.name,
      engagement_type: input.body.engagementType,
      currency: input.body.currency,
      start_date: input.body.startDate,
      end_date: input.body.endDate ?? null,
      renewal_date: input.body.renewalDate ?? null,
      contract_value: input.body.contractValue ?? null,
      monthly_retainer: input.body.monthlyRetainer ?? null,
      notes_internal: input.body.notesInternal ?? null,
      account_manager_user_id: input.body.accountManagerUserId ?? null,
      ...actorStamp(input.auth),
    })
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) {
    throw ApiError.serviceUnavailable('The engagement could not be created.');
  }
  await recordMutation({
    action: 'CREATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'engagement',
    entityId: data.id,
    organizationId: data.organization_id,
    after: { code: data.code, name: data.name },
  });
  return toDto(data, true);
}

export async function patchEngagement(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
  readonly body: Record<string, unknown>;
}): Promise<EngagementDto> {
  const map: Record<string, string> = {
    name: 'name',
    engagementType: 'engagement_type',
    currency: 'currency',
    startDate: 'start_date',
    endDate: 'end_date',
    renewalDate: 'renewal_date',
    contractValue: 'contract_value',
    monthlyRetainer: 'monthly_retainer',
    notesInternal: 'notes_internal',
  };
  const patch: Record<string, unknown> = { updated_by: input.auth.userId };
  for (const [from, to] of Object.entries(map)) {
    if (input.body[from] !== undefined) patch[to] = input.body[from];
  }
  const updated = await updateLive<Row>('engagements', input.id, patch);
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'engagement',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: Object.keys(patch).filter((key) => key !== 'updated_by'),
  });
  return toDto(updated, isStaff(input.auth));
}

export async function deleteEngagement(input: {
  readonly id: string;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<void> {
  const row = await loadLive<Row>('engagements', input.id);
  await softDeleteLive('engagements', input.id, input.auth.userId);
  await recordMutation({
    action: 'SOFT_DELETE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'engagement',
    entityId: input.id,
    organizationId: row.organization_id,
  });
}

export async function assignEngagementManager(input: {
  readonly id: string;
  readonly accountManagerUserId: string | null;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<EngagementDto> {
  const updated = await updateLive<Row>('engagements', input.id, {
    account_manager_user_id: input.accountManagerUserId,
    updated_by: input.auth.userId,
  });
  await recordMutation({
    action: 'UPDATE',
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
    entityKind: 'engagement',
    entityId: input.id,
    organizationId: updated.organization_id,
    changedFields: ['account_manager_user_id'],
  });
  return toDto(updated, isStaff(input.auth));
}

export async function changeEngagementStatus(input: {
  readonly id: string;
  readonly status: string;
  readonly reason?: string | undefined;
  readonly auth: AuthContext;
  readonly request: Request;
  readonly requestId: string;
}): Promise<EngagementDto> {
  const updated = await changeStatus<Row>({
    table: 'engagements',
    entityKind: 'engagement',
    id: input.id,
    toStatus: input.status,
    reason: input.reason,
    auth: input.auth,
    request: input.request,
    requestId: input.requestId,
  });
  return toDto(updated, isStaff(input.auth));
}

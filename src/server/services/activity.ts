import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { toStatusTransitionDto, type ActivityDto, type StatusTransitionDto } from '@/lib/dto/mappers';
import { activityPaginationMeta, pageFromQuery } from '@/server/api/page';
import { throwIfError } from '@/server/db/errors';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { PaginationQuery } from '@/lib/validation/pagination';

export async function listStaffActivity(input: {
  readonly query: PaginationQuery & { readonly organizationId?: string | undefined; readonly entityKind?: string | undefined };
}): Promise<PageResult<ActivityDto>> {
  const page = pageFromQuery(input.query, 'occurredAt');
  const supabase = await createSupabaseServerClient();
  let q = supabase
    .from('audit_events')
    .select('occurred_at, entity_kind, entity_id, action, organization_id')
    .order('occurred_at', { ascending: false })
    .limit(page.limit + 1);
  if (input.query.organizationId !== undefined) {
    q = q.eq('organization_id', input.query.organizationId);
  }
  if (input.query.entityKind !== undefined) {
    q = q.eq('entity_kind', input.query.entityKind as never);
  }
  if (page.cursor !== null && typeof page.cursor.key === 'string') {
    q = q.lt('occurred_at', page.cursor.key);
  }
  const { data, error } = await q;
  throwIfError(error, 'read');
  const rows = data ?? [];
  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    data: pageRows.map((row) => ({
      occurredAt: row.occurred_at,
      entityKind: row.entity_kind,
      entityId: row.entity_id,
      action: row.action,
    })),
    pagination: {
      limit: page.limit,
      hasMore,
      nextCursor:
        hasMore && last !== undefined
          ? (await import('@/lib/pagination/cursor')).encodeCursor({
              key: last.occurred_at,
              id: last.entity_id,
              sort: page.sort,
            })
          : null,
    },
  };
}

export async function listClientActivity(input: {
  readonly organizationId: string;
  readonly limit?: number | undefined;
  readonly before?: string | undefined;
}): Promise<PageResult<ActivityDto>> {
  const limit = input.limit ?? 25;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('client_activity_feed', {
    p_organization_id: input.organizationId,
    p_limit: limit,
    p_before: input.before ?? null,
  });
  throwIfError(error, 'read');
  const rows = (data as
    | {
        occurred_at: string;
        entity_kind: string;
        entity_id: string;
        action: string;
        display_title: string;
      }[]
    | null) ?? [];
  const hasMore = rows.length === limit;
  const last = rows[rows.length - 1];
  return {
    data: rows.map((row) => ({
      occurredAt: row.occurred_at,
      entityKind: row.entity_kind,
      entityId: row.entity_id,
      action: row.action,
      displayTitle: row.display_title,
    })),
    pagination: activityPaginationMeta({
      limit,
      hasMore,
      nextBefore: hasMore && last !== undefined ? last.occurred_at : null,
    }),
  };
}

export async function listStatusTransitions(entityKind?: string | undefined): Promise<readonly StatusTransitionDto[]> {
  const supabase = await createSupabaseServerClient();
  let q = supabase.from('status_transitions').select('*').order('entity_kind').order('from_status');
  if (entityKind !== undefined) {
    q = q.eq('entity_kind', entityKind as never);
  }
  const { data, error } = await q;
  throwIfError(error, 'read');
  return (data ?? []).map(toStatusTransitionDto);
}

export type { AuthContext };

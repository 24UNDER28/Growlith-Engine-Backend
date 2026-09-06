import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { ApiError } from '@/server/api/errors';
import { pageFromQuery } from '@/server/api/page';
import { slicePage } from '@/server/db/page';
import { throwIfError } from '@/server/db/errors';
import { createSupabaseServerClient } from '@/server/supabase/client-server';
import type { PaginationQuery } from '@/lib/validation/pagination';

export function requireParentId(value: string | undefined, path: string): string {
  if (value === undefined || value.length === 0) {
    throw ApiError.validation(
      [{ path, code: 'required', message: `${path} is required.` }],
      'The request failed validation.',
    );
  }
  return value;
}

export async function loadLive<T>(
  table: string,
  id: string,
  notFoundMessage?: string | undefined,
  options: { readonly live?: boolean | undefined } = {},
): Promise<T> {
  const supabase = await createSupabaseServerClient();
  let query = supabase.from(table as never).select('*').eq('id', id);
  if (options.live !== false) {
    query = query.is('deleted_at', null);
  }
  const { data, error } = await query.maybeSingle();
  throwIfError(error, 'read');
  if (data === null) {
    throw ApiError.notFound(notFoundMessage);
  }
  return data as T;
}

export async function insertRow<T>(table: string, values: Record<string, unknown>): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from(table as never)
    .insert(values as never)
    .select('*')
    .single();
  throwIfError(error, 'write');
  if (data === null) {
    throw ApiError.serviceUnavailable('The change could not be saved.');
  }
  return data as T;
}

export async function updateLive<T>(
  table: string,
  id: string,
  values: Record<string, unknown>,
): Promise<T> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from(table as never)
    .update(values as never)
    .eq('id', id)
    .is('deleted_at', null)
    .select('*')
    .maybeSingle();
  throwIfError(error, 'write');
  if (data === null) {
    throw ApiError.notFound();
  }
  return data as T;
}

export async function softDeleteLive(
  table: string,
  id: string,
  actorUserId: string,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from(table as never)
    .update({ deleted_at: new Date().toISOString(), deleted_by: actorUserId } as never)
    .eq('id', id)
    .is('deleted_at', null)
    .select('id')
    .maybeSingle();
  throwIfError(error, 'write');
  if (data === null) {
    throw ApiError.notFound();
  }
}

export type FilterFn = (query: QueryLike) => QueryLike;

export interface QueryLike {
  eq: (column: string, value: unknown) => QueryLike;
  is: (column: string, value: unknown) => QueryLike;
  in: (column: string, values: unknown[]) => QueryLike;
  gte: (column: string, value: unknown) => QueryLike;
  lte: (column: string, value: unknown) => QueryLike;
  lt: (column: string, value: unknown) => QueryLike;
  or: (filters: string) => QueryLike;
  ilike: (column: string, value: string) => QueryLike;
  order: (column: string, options: { ascending: boolean }) => QueryLike;
  limit: (n: number) => QueryLike;
  select: (columns: string) => QueryLike;
}

const SORT_COLUMNS: Record<string, string> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  startDate: 'start_date',
  endDate: 'end_date',
  renewalDate: 'renewal_date',
  dueDate: 'due_date',
  targetDate: 'target_date',
  name: 'name',
  title: 'title',
  code: 'code',
  metricDate: 'metric_date',
  occurredAt: 'occurred_at',
  position: 'position',
};

export function sqlSortColumn(sort: string): string {
  return SORT_COLUMNS[sort] ?? 'created_at';
}

export async function listLive<T extends { readonly id: string }>(input: {
  readonly table: string;
  readonly select?: string | undefined;
  readonly query: PaginationQuery;
  readonly defaultSort?: string | undefined;
  readonly allowedSorts?: readonly string[] | undefined;
  readonly apply: (query: QueryLike) => QueryLike;
  readonly keyOf?: (row: T) => string | number | null;
  /** When false, skip the `deleted_at is null` filter (metrics, invitations). */
  readonly live?: boolean | undefined;
}): Promise<PageResult<T>> {
  const allowed = input.allowedSorts ?? ['createdAt'];
  const requested = input.query.sort ?? input.defaultSort ?? 'createdAt';
  if (!allowed.includes(requested)) {
    throw ApiError.validation(
      [
        {
          path: 'sort',
          code: 'invalid_enum_value',
          message: `sort must be one of: ${allowed.join(', ')}`,
        },
      ],
      'The query string is invalid.',
    );
  }
  const page = pageFromQuery(input.query, requested);
  const column = sqlSortColumn(page.sort);
  const supabase = await createSupabaseServerClient();
  let q = supabase.from(input.table as never).select(input.select ?? '*') as unknown as QueryLike;
  if (input.live !== false) {
    q = q.is('deleted_at', null);
  }
  q = input.apply(q);
  if (page.cursor !== null && page.cursor.key !== null) {
    const op = 'lt';
    q = q.or(
      `${column}.${op}.${page.cursor.key},and(${column}.eq.${page.cursor.key},id.${op}.${page.cursor.id})`,
    );
  }
  q = q.order(column, { ascending: false }).order('id', { ascending: false }).limit(page.limit + 1);

  const { data, error } = (await (q as unknown as PromiseLike<{
    data: T[] | null;
    error: { code?: string; message?: string } | null;
  }>)) as {
    data: T[] | null;
    error: { code?: string; message?: string } | null;
  };
  throwIfError(error, 'read');
  const sliced = slicePage(data ?? [], page, input.keyOf ?? ((row) => row.id));
  return { data: sliced.rows, pagination: sliced.pagination };
}

export function actorStamp(auth: AuthContext): { created_by: string; updated_by: string } {
  return { created_by: auth.userId, updated_by: auth.userId };
}

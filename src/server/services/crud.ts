import 'server-only';

import type { AuthContext } from '@/lib/auth/context';
import type { PageResult } from '@/lib/types/pagination';
import { ApiError } from '@/server/api/errors';
import { assertKeysetPayloadForFilter, pageFromQuery } from '@/server/api/page';
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
  let query = supabase
    .from(table as never)
    .select('*')
    .eq('id', id);
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
  order: (column: string, options: { ascending: boolean; nullsFirst?: boolean }) => QueryLike;
  limit: (n: number) => QueryLike;
  select: (columns: string) => QueryLike;
}

/**
 * The sort keys every list endpoint may name, mapped to real SQL columns.
 *
 * The map is deliberately closed and table-agnostic ONLY for columns whose
 * names are identical across the tables that sort on them (timestamps,
 * dates, `position`, …). TEXT sort keys (`name`, `title`, `full_name`) are
 * NOT listed: a keyset cursor must embed the last row's sort value into a
 * PostgREST `or(...)` filter, and text values containing `,`/`(`/`)` would
 * corrupt that filter — so text-sorted pagination is not representable and a
 * list that wants it must say so per-call with `sortColumns` and handle the
 * escaping there. Absence of a mapping is a 500 (deployment bug), never a
 * silent fallback to `created_at` that would silently sort by the wrong
 * column.
 */
export const SORT_COLUMNS: Readonly<Record<string, string>> = {
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  startDate: 'start_date',
  endDate: 'end_date',
  renewalDate: 'renewal_date',
  dueDate: 'due_date',
  targetDate: 'target_date',
  metricDate: 'metric_date',
  occurredAt: 'occurred_at',
  position: 'position',
  expiresAt: 'expires_at',
};

export function sqlSortColumn(sort: string): string {
  const column = SORT_COLUMNS[sort];
  if (column === undefined) {
    throw ApiError.internal(new Error(`listLive: sort key '${sort}' has no SQL column mapping`));
  }
  return column;
}

/**
 * The keyset value of a row: the row's value in the SORT column (not the
 * row's id and not a hard-coded `created_at`), so a cursor issued for
 * `sort=dueDate` continues from the due-date of the last row of the previous
 * page. Returns `null` for NULL sort values; callers ordering the sort column
 * with `nullsFirst: false` can then continue through the null tail with an
 * `is null` bound (see listLive).
 */
function rowKeyValue<T extends { readonly id: string }>(
  row: T,
  column: string,
): string | number | null {
  const value = (row as unknown as Record<string, unknown>)[column];
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  if (value === undefined || value === null) {
    return null;
  }
  // Dates returned by PostgREST are always ISO strings; anything else is a
  // shape drift that must fail loudly rather than mint a poisoned cursor.
  throw ApiError.internal(new Error(`listLive: sort column ${column} returned an unkeyable value`));
}

export async function listLive<T extends { readonly id: string }>(input: {
  readonly table: string;
  readonly select?: string | undefined;
  readonly query: PaginationQuery;
  readonly defaultSort?: string | undefined;
  readonly allowedSorts?: readonly string[] | undefined;
  /**
   * Sort keys whose natural direction is ASCENDING (deadline views, board
   * position, join-order rosters). Every other allowed key is DESCENDING
   * (newest-first, the API's default posture). The keyset bound and the
   * id tie-break follow the same direction, so paging an ascending sort
   * stays total and gapless.
   */
  readonly ascendingKeys?: readonly string[] | undefined;
  readonly apply: (query: QueryLike) => QueryLike;
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
  const ascending = (input.ascendingKeys ?? []).includes(page.sort);
  const boundOp = ascending ? 'gt' : 'lt';
  const idOp = ascending ? 'gt' : 'lt';
  const supabase = await createSupabaseServerClient();
  let q = supabase.from(input.table as never).select(input.select ?? '*') as unknown as QueryLike;
  if (input.live !== false) {
    q = q.is('deleted_at', null);
  }
  q = input.apply(q);
  if (page.cursor !== null) {
    // The cursor values are embedded into a PostgREST `or(...)` filter
    // below; reject values that could rewrite that filter before they reach
    // the database (see assertKeysetPayloadForFilter).
    assertKeysetPayloadForFilter(page.cursor);
    const key = page.cursor.key;
    if (key === null) {
      // The previous page ended inside the NULL tail of the sort column
      // (NULLs are ordered last in BOTH directions, so only NULL-valued rows
      // can follow). NULL rows are mutually ordered by id in the sort
      // direction, so the bound is (col IS NULL AND id <|> cursor.id).
      q = q.or(`and(${column}.is.null,id.${idOp}.${page.cursor.id})`);
    } else {
      q = q.or(`${column}.${boundOp}.${key},and(${column}.eq.${key},id.${idOp}.${page.cursor.id})`);
    }
  }
  // `nullsFirst: false` keeps NULL sort values at the end of a page in both
  // directions, so a non-NULL value is always at the page boundary until the
  // final NULL tail — and the NULL tail itself pages via the `is null` bound
  // above instead of silently repeating page one. The id tie-break shares the
  // sort direction so the ordering is total.
  q = q
    .order(column, { ascending, nullsFirst: false })
    .order('id', { ascending })
    .limit(page.limit + 1);

  const { data, error } = (await (q as unknown as PromiseLike<{
    data: T[] | null;
    error: { code?: string; message?: string } | null;
  }>)) as {
    data: T[] | null;
    error: { code?: string; message?: string } | null;
  };
  throwIfError(error, 'read');
  const sliced = slicePage(data ?? [], page, (row) => rowKeyValue(row, column));
  return { data: sliced.rows, pagination: sliced.pagination };
}

export function actorStamp(auth: AuthContext): { created_by: string; updated_by: string } {
  return { created_by: auth.userId, updated_by: auth.userId };
}

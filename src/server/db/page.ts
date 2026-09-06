import 'server-only';

import type { CursorPayload } from '@/lib/types/pagination';
import { paginationMeta, type ResolvedPage } from '@/server/api/page';
import type { PaginationMeta } from '@/lib/types/pagination';

type FilterBuilder = {
  or: (filters: string) => FilterBuilder;
};

/**
 * Apply a keyset lower/upper bound. Descending (`created_at DESC, id DESC`) is
 * the default for every collection in this API.
 */
export function applyCursor<T extends FilterBuilder>(
  query: T,
  cursor: CursorPayload | null,
  column: string,
  direction: 'desc' | 'asc' = 'desc',
): T {
  if (cursor === null) {
    return query;
  }
  const key = cursor.key;
  const id = cursor.id;
  if (key === null) {
    return query;
  }
  const op = direction === 'desc' ? 'lt' : 'gt';
  const eqOp = 'eq';
  // `(column,id)` tuple comparison expressed as PostgREST `or`.
  return query.or(`${column}.${op}.${key},and(${column}.${eqOp}.${key},id.${op}.${id})`) as T;
}

export function slicePage<T extends { readonly id: string }>(
  rows: readonly T[],
  page: ResolvedPage,
  keyOf: (row: T) => string | number | null,
): { readonly rows: readonly T[]; readonly pagination: PaginationMeta } {
  const hasMore = rows.length > page.limit;
  const pageRows = hasMore ? rows.slice(0, page.limit) : rows;
  const last = pageRows[pageRows.length - 1];
  return {
    rows: pageRows,
    pagination: paginationMeta({
      limit: page.limit,
      hasMore,
      sort: page.sort,
      next: hasMore && last !== undefined ? { key: keyOf(last), id: last.id } : null,
    }),
  };
}

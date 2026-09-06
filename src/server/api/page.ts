import 'server-only';

import { decodeCursor, encodeCursor } from '@/lib/pagination/cursor';
import { DEFAULT_PAGE_SIZE } from '@/lib/pagination/limits';
import type { CursorPayload, PaginationMeta } from '@/lib/types/pagination';
import type { PaginationQuery } from '@/lib/validation/pagination';
import { ApiError } from '@/server/api/errors';

export interface ResolvedPage {
  readonly limit: number;
  readonly cursor: CursorPayload | null;
  readonly sort: string;
}

/**
 * Decode and bind a list query to a sort. A tampered cursor is a 422, never a
 * silent restart (that would re-expose rows the client had already paged past).
 * A cursor issued under a different `sort` is `cursor_mismatch`.
 */
export function pageFromQuery(query: PaginationQuery, defaultSort = 'createdAt'): ResolvedPage {
  const limit = query.limit ?? DEFAULT_PAGE_SIZE;
  const sort = query.sort ?? defaultSort;

  if (query.cursor === undefined) {
    return { limit, cursor: null, sort };
  }

  const payload = decodeCursor(query.cursor);
  if (payload === null) {
    throw ApiError.validation(
      [
        {
          path: 'cursor',
          code: 'invalid_cursor',
          message: 'cursor is not a cursor this system issued.',
        },
      ],
      'The query string is invalid.',
    );
  }
  if (payload.sort !== undefined && payload.sort !== sort) {
    throw ApiError.validation(
      [
        {
          path: 'cursor',
          code: 'cursor_mismatch',
          message: 'cursor was issued for a different sort order.',
        },
      ],
      'The query string is invalid.',
    );
  }
  return { limit, cursor: payload, sort };
}

export function paginationMeta(input: {
  readonly limit: number;
  readonly hasMore: boolean;
  readonly next: { readonly key: string | number | null; readonly id: string } | null;
  readonly sort: string;
}): PaginationMeta {
  return {
    limit: input.limit,
    hasMore: input.hasMore,
    nextCursor:
      input.next === null
        ? null
        : encodeCursor({ key: input.next.key, id: input.next.id, sort: input.sort }),
  };
}

/** O-2: the client activity feed pages on a timestamp, not a keyset cursor. */
export function activityPaginationMeta(input: {
  readonly limit: number;
  readonly hasMore: boolean;
  readonly nextBefore: string | null;
}): PaginationMeta {
  return {
    limit: input.limit,
    hasMore: input.hasMore,
    nextCursor: null,
    nextBefore: input.nextBefore,
  };
}

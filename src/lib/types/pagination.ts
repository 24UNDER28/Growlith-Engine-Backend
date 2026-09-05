/**
 * Cursor pagination contract (ADR-0018).
 *
 * Offset pagination is rejected for this system: it degrades as tables grow, it
 * silently duplicates or skips rows when a client inserts concurrently, and
 * `COUNT(*)` over a tenant-scoped table leaks information about volume.
 */

/** An opaque, base64url-encoded keyset position. Never constructed by clients. */
export type Cursor = string;

/** What a list endpoint accepts. */
export interface PageRequest {
  readonly limit: number;
  readonly cursor: Cursor | null;
}

/** What a list endpoint returns alongside `data`. */
export interface PaginationMeta {
  readonly limit: number;
  /** `null` when the end of the collection has been reached. */
  readonly nextCursor: Cursor | null;
  readonly hasMore: boolean;
}

/**
 * The decoded contents of a cursor.
 *
 * `key` is the sort value of the last row on the previous page and `id` is that
 * row's identifier, which together make the keyset unique even when many rows
 * share a sort value (the common case for `created_at`).
 */
export interface CursorPayload {
  readonly key: string | number | null;
  readonly id: string;
}

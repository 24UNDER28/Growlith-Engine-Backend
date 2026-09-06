import { z } from 'zod';

import { MAX_PAGE_SIZE } from '@/lib/pagination/limits';

/**
 * The query-string schema shared by every list endpoint.
 *
 * `z.coerce` is required because query parameters always arrive as strings; the
 * coercion happens inside the schema so handlers never parse numbers by hand.
 *
 * `.strict()` means `?limitx=10000` is a 422 rather than a silently ignored
 * typo that returns an unbounded page.
 */
export const paginationQuerySchema = z
  .object({
    limit: z.coerce
      .number({ message: 'limit must be a number' })
      .int('limit must be a whole number')
      .min(1, 'limit must be at least 1')
      .max(MAX_PAGE_SIZE, `limit must be at most ${MAX_PAGE_SIZE}`)
      .optional(),
    cursor: z.string().min(1).max(512).optional(),
    sort: z.string().min(1).max(64).optional(),
  })
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

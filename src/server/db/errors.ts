import 'server-only';

import { ApiError } from '@/server/api/errors';

/**
 * Map a PostgREST / PostgreSQL error to a safe `ApiError`.
 *
 * The original message NEVER crosses the boundary: constraint names, table
 * names and SQLSTATE text are how an attacker learns the schema. We branch on
 * `code` (and, for RPCs, a closed set of errcodes) and emit a public sentence.
 */
export function mapDatabaseError(
  error: { readonly code?: string | null; readonly message?: string | null },
  fallback: 'read' | 'write' = 'write',
): never {
  const code = error.code ?? '';
  switch (code) {
    case '23505':
      throw ApiError.conflict('A resource with those unique values already exists.');
    case '23503':
      throw ApiError.conflict('The referenced resource does not exist or is not writable.');
    case '23514':
    case 'P0004': // check_violation via RAISE
      throw ApiError.conflict('The change violates a data constraint.');
    case '23502':
      throw ApiError.validation(
        [{ path: '(root)', code: 'not_null', message: 'A required field was missing.' }],
        'The request failed validation.',
      );
    case '42501':
    case 'P0001':
      // insufficient_privilege from a definer RPC. The API guard already ran;
      // this is the database re-checking authority. Same 403, no extra detail.
      throw ApiError.forbidden();
    case 'P0002':
      throw ApiError.notFound();
    case '22P02':
    case '22001':
      throw ApiError.validation(
        [{ path: '(root)', code: 'invalid', message: 'A field was not in the expected format.' }],
        'The request failed validation.',
      );
    default:
      if (fallback === 'read') {
        throw ApiError.serviceUnavailable('The resource could not be loaded.');
      }
      throw ApiError.serviceUnavailable('The change could not be saved.');
  }
}

export function throwIfError(
  error: { readonly code?: string | null; readonly message?: string | null } | null,
  fallback: 'read' | 'write' = 'write',
): void {
  if (error !== null) {
    mapDatabaseError(error, fallback);
  }
}

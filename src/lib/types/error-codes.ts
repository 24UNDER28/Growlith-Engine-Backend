/**
 * Machine-readable error codes.
 *
 * Declared in `src/lib` so that browser code can branch on a stable string
 * (`if (error.code === ErrorCode.Unauthenticated)`) without depending on the
 * server-only `ApiError` class or on HTTP status numbers, which are less
 * expressive than codes.
 *
 * Adding a code is backwards compatible. Renaming or removing one is a breaking
 * change to `/api/v1` and requires a version bump (ADR-0013).
 */
export const ErrorCode = {
  /** Request body was not parseable JSON, or a required part was absent. */
  MalformedRequest: 'MALFORMED_REQUEST',
  /** Body/query/params parsed but failed schema validation. */
  ValidationFailed: 'VALIDATION_FAILED',
  /** No valid session, or the session could not be verified. */
  Unauthenticated: 'UNAUTHENTICATED',
  /** Authenticated, but not permitted to perform this operation. */
  Forbidden: 'FORBIDDEN',
  /**
   * Resource does not exist *or is not visible to this actor*.
   *
   * These two cases are intentionally indistinguishable: returning 403 for a
   * row hidden by RLS would confirm that the row exists in another tenant,
   * which is a cross-tenant enumeration leak (ADR-0019).
   */
  NotFound: 'NOT_FOUND',
  MethodNotAllowed: 'METHOD_NOT_ALLOWED',
  /** Unique-constraint violation or an illegal state transition. */
  Conflict: 'CONFLICT',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  TooManyRequests: 'TOO_MANY_REQUESTS',
  AccountSuspended: 'ACCOUNT_SUSPENDED',
  /** Server-side environment is misconfigured. Safe to surface; details are not. */
  EnvMisconfigured: 'ENV_MISCONFIGURED',
  /** A downstream dependency (database, storage) is unavailable. */
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  /** Unexpected failure. The real cause is logged, never returned. */
  Internal: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

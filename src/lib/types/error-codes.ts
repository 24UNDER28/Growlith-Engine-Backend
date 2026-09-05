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
  /**
   * No valid session, or the session could not be verified.
   *
   * Status-gate variants below (`ACCOUNT_DEACTIVATED`, `MFA_REQUIRED`) reuse
   * 401/403-family semantics but name the account-holder-facing cause; they
   * face a person who is entitled to know their own account state and reveal
   * nothing about *other* addresses (design §3 rationale).
   */
  Unauthenticated: 'UNAUTHENTICATED',
  /**
   * Credentials did not verify. Deliberately identical for unknown email and
   * wrong password so the endpoint cannot be used to enumerate addresses.
   */
  InvalidCredentials: 'INVALID_CREDENTIALS',
  /** The account exists but is offboarded; authentication is refused. */
  AccountDeactivated: 'ACCOUNT_DEACTIVATED',
  /** The account accepted neither the invitation nor anything else yet. */
  InvitationPending: 'INVITATION_PENDING',
  /** A session exists but the surface requires the second authenticator. */
  MfaRequired: 'MFA_REQUIRED',
  /**
   * An invitation link is invalid, expired, revoked or already consumed.
   * Carries no indication of which: link states stay neutral (design §12).
   */
  InvitationInvalid: 'INVITATION_INVALID',
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

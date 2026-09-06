import 'server-only';

import { z } from 'zod';

import { EnvironmentError } from '@/lib/errors/environment';
import { ErrorCode } from '@/lib/types/error-codes';
import type { ApiErrorBody, ApiHttpStatusCode, ValidationIssue } from '@/lib/types/api-envelope';
import { toValidationIssues } from '@/lib/validation/format';

/**
 * The typed error contract for the API boundary.
 *
 * Three rules make this a security control rather than a convenience:
 *
 * 1. **Nothing internal crosses the boundary.** An `ApiError` carries a public
 *    `code`, a public `message` and optional validation `details`. The original
 *    failure is kept on `cause` for server-side logging and is *never*
 *    serialized. A raw PostgreSQL error, a Supabase error string or a stack
 *    trace reaching a client is an information-disclosure bug (Rule 24).
 *
 * 2. **"Not found" and "not visible" are the same response.** `notFound()` is
 *    used both when a row does not exist and when RLS hides it. Distinguishing
 *    them would confirm the existence of another tenant's resource and enable
 *    cross-tenant enumeration (ADR-0019).
 *
 * 3. **Every thrown value becomes an `ApiError`.** `toApiError()` normalises
 *    unknown throwables into a generic 500. A handler can therefore never leak
 *    by throwing something unexpected — the wrapper catches, logs and
 *    downgrades it.
 */

export interface ApiErrorOptions {
  readonly details?: readonly ValidationIssue[];
  readonly cause?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: ApiHttpStatusCode;
  readonly details: readonly ValidationIssue[] | undefined;
  /** Extra response headers, e.g. `Allow` on a 405 or `Retry-After` on a 429. */
  readonly headers: Readonly<Record<string, string>>;

  constructor(
    status: ApiHttpStatusCode,
    code: ErrorCode,
    message: string,
    options: ApiErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers ?? {};
  }

  /** The client-safe representation. This is the only form that may be sent. */
  toPublicBody(requestId?: string): ApiErrorBody {
    const body: {
      code: ErrorCode;
      message: string;
      details?: readonly ValidationIssue[];
      requestId?: string;
    } = { code: this.code, message: this.message };

    if (this.details !== undefined && this.details.length > 0) {
      body.details = this.details;
    }
    if (requestId !== undefined) {
      body.requestId = requestId;
    }

    return body;
  }

  static badRequest(message: string, cause?: unknown): ApiError {
    return new ApiError(400, ErrorCode.MalformedRequest, message, { cause });
  }

  static validation(
    issues: readonly ValidationIssue[],
    message = 'The request failed validation.',
  ): ApiError {
    return new ApiError(422, ErrorCode.ValidationFailed, message, { details: issues });
  }

  static unauthenticated(message = 'Authentication is required.'): ApiError {
    return new ApiError(401, ErrorCode.Unauthenticated, message);
  }

  /**
   * Credentials did not verify. The message is deliberately identical for an
   * unknown address and a wrong password, so the endpoint cannot be used to
   * enumerate which addresses hold accounts (design §3, §12).
   */
  static invalidCredentials(
    message = 'The email address or password is incorrect.',
    cause?: unknown,
  ): ApiError {
    return new ApiError(401, ErrorCode.InvalidCredentials, message, { cause });
  }

  /**
   * The account is offboarded. 401 with a named code so the account holder
   * learns their own state; nothing here reveals whether an address exists
   * (wrong-password attempts never reach this code).
   */
  static accountDeactivated(
    message = 'This account has been deactivated.',
    cause?: unknown,
  ): ApiError {
    return new ApiError(401, ErrorCode.AccountDeactivated, message, { cause });
  }

  /** The invitation is still pending; only acceptance may proceed. */
  static invitationPending(
    message = 'This account has not accepted its invitation yet.',
    cause?: unknown,
  ): ApiError {
    return new ApiError(403, ErrorCode.InvitationPending, message, { cause });
  }

  /** The session is alive at aal1 but the surface requires the second factor. */
  static mfaRequired(
    message = 'A second authentication factor is required for this action.',
    cause?: unknown,
  ): ApiError {
    return new ApiError(401, ErrorCode.MfaRequired, message, { cause });
  }

  static forbidden(message = 'You do not have permission to perform this action.'): ApiError {
    return new ApiError(403, ErrorCode.Forbidden, message);
  }

  /**
   * Resource missing **or** hidden by RLS. Do not add a variant that reveals
   * which of the two occurred (ADR-0019).
   */
  static notFound(message = 'The requested resource was not found.'): ApiError {
    return new ApiError(404, ErrorCode.NotFound, message);
  }

  static methodNotAllowed(allowed: readonly string[]): ApiError {
    return new ApiError(
      405,
      ErrorCode.MethodNotAllowed,
      'This HTTP method is not supported here.',
      {
        headers: { Allow: allowed.join(', ') },
      },
    );
  }

  static conflict(message: string, cause?: unknown): ApiError {
    return new ApiError(409, ErrorCode.Conflict, message, { cause });
  }

  static payloadTooLarge(message = 'The request body is too large.'): ApiError {
    return new ApiError(413, ErrorCode.PayloadTooLarge, message);
  }

  static tooManyRequests(
    message = 'Too many requests. Please retry later.',
    retryAfterSeconds = 30,
  ): ApiError {
    return new ApiError(429, ErrorCode.TooManyRequests, message, {
      headers: { 'Retry-After': String(retryAfterSeconds) },
    });
  }

  static accountSuspended(message = 'This account is suspended.'): ApiError {
    return new ApiError(423, ErrorCode.AccountSuspended, message);
  }

  static envMisconfigured(cause?: unknown): ApiError {
    // The message is deliberately generic: naming the missing variable would
    // disclose server configuration to any caller. The detail goes to the log.
    return new ApiError(500, ErrorCode.EnvMisconfigured, 'The server is misconfigured.', { cause });
  }

  static serviceUnavailable(message = 'A required service is temporarily unavailable.'): ApiError {
    return new ApiError(503, ErrorCode.ServiceUnavailable, message, {
      headers: { 'Retry-After': '5' },
    });
  }

  static internal(cause?: unknown): ApiError {
    return new ApiError(500, ErrorCode.Internal, 'An unexpected error occurred.', { cause });
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * Normalise anything thrown into an `ApiError` that is safe to return.
 *
 * Recognised failure types keep their meaning; everything else becomes a
 * generic 500 with the original attached as `cause` for logging only.
 */
export function toApiError(value: unknown): ApiError {
  if (isApiError(value)) {
    return value;
  }

  if (value instanceof EnvironmentError) {
    return ApiError.envMisconfigured(value);
  }

  if (value instanceof z.ZodError) {
    // Safety net. `withRoute` validates with `safeParse` and never lets a
    // ZodError escape, so reaching here means a service parsed untrusted input
    // directly — still handled, still not leaked.
    return ApiError.validation(toValidationIssues(value.issues));
  }

  return ApiError.internal(value);
}

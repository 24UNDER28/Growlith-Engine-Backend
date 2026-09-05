/**
 * The isomorphic API-fetch foundation (design §6, item 3).
 *
 * There is no browser Supabase client (ADR-0026), so every browser interaction
 * with the API is plain `fetch` against `/api/v1/**` with cookie
 * authentication. This wrapper is the Phase 3 foundation the Phase 9 UI
 * consumes: it unwraps the envelope and maps the *codes* — not HTTP numbers,
 * which are less expressive — to navigation destinations.
 *
 * It performs no navigation itself. Returning a destination keeps the module
 * isomorphic and testable; the Phase 9 UI applies it with its router.
 */

import { ACCOUNT_RESTRICTED_PATH, LOGIN_PATH, safeNextPath } from '@/lib/auth/routes';
import type { ApiErrorBody, ApiSuccessEnvelope } from '@/lib/types/api-envelope';
import { ErrorCode } from '@/lib/types/error-codes';

/** Where the browser should go given an error envelope, or `null` to surface it. */
export function destinationForErrorBody(
  body: ApiErrorBody,
  input: { readonly currentPath: string },
): string | null {
  switch (body.code) {
    case ErrorCode.Unauthenticated:
    case ErrorCode.InvalidCredentials:
      // Re-login, then return to where the user was.
      return `${LOGIN_PATH}?next=${encodeURIComponent(safeNextPath(input.currentPath, '/'))}`;
    case ErrorCode.AccountSuspended:
    case ErrorCode.AccountDeactivated:
      // The account holder must learn their state; the restricted page explains it.
      return ACCOUNT_RESTRICTED_PATH;
    case ErrorCode.MfaRequired:
      // Step-up, not re-login: the session is alive at aal1.
      return `${LOGIN_PATH}?reason=mfa_required&next=${encodeURIComponent(
        safeNextPath(input.currentPath, '/'),
      )}`;
    default:
      // Everything else (validation, conflict, rate limit, outage) is surfaced
      // as-is by the caller. This function never guesses.
      return null;
  }
}

/**
 * Fetch an API endpoint and return the envelope, discriminated.
 *
 * Network-level failures (offline, DNS) return a synthetic
 * `SERVICE_UNAVAILABLE` error body rather than throwing, so consumers have one
 * error shape to handle.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<
  { ok: true; data: T; meta: ApiSuccessEnvelope<T>['meta'] } | { ok: false; error: ApiErrorBody }
> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      // The session cookie travels with same-origin fetch by default; stating
      // it keeps that deliberate and survives a future `credentials` default.
      credentials: 'same-origin',
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...init?.headers,
      },
    });
  } catch {
    return {
      ok: false,
      error: {
        code: ErrorCode.ServiceUnavailable,
        message: 'The request could not reach the server. Please retry.',
      },
    };
  }

  if (response.status === 204) {
    // 204 carries no body; the envelope contract accepts an empty data payload.
    return { ok: true, data: undefined as T, meta: { requestId: 'n/a', tookMs: 0 } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      error: {
        code: ErrorCode.Internal,
        message: 'The server returned a response this client could not parse.',
      },
    };
  }

  if (!response.ok) {
    const error = (payload as { error?: ApiErrorBody }).error;
    if (error === undefined || typeof error.code !== 'string') {
      return {
        ok: false,
        error: { code: ErrorCode.Internal, message: 'The server returned an unrecognized error.' },
      };
    }
    return { ok: false, error };
  }

  const envelope = payload as ApiSuccessEnvelope<T>;
  return { ok: true, data: envelope.data, meta: envelope.meta };
}

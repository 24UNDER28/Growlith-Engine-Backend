import { describe, expect, it } from 'vitest';

import { destinationForErrorBody } from '@/lib/auth/api-client';
import { ErrorCode } from '@/lib/types/error-codes';

/**
 * The client-side error → navigation mapping (§6, §3, §8).
 *
 * When the browser's `apiFetch` wrapper receives an error envelope, it calls
 * `destinationForErrorBody` to decide whether the user should be sent to a
 * different page. This test pins the mapping:
 *   - 401 UNAUTHENTICATED → /login with safe `next`
 *   - 401 INVALID_CREDENTIALS → /login (re-login after wrong password)
 *   - 423 ACCOUNT_SUSPENDED → /account-restricted
 *   - 401 ACCOUNT_DEACTIVATED → /account-restricted
 *   - 401 MFA_REQUIRED → /login with reason=mfa_required
 *   - Everything else → null (surface the error, don't navigate)
 *
 * The `safeNextPath` guard inside must prevent open redirects (§12).
 */

describe('destinationForErrorBody — error-code → navigation mapping', () => {
  it('maps UNAUTHENTICATED to the login page with a safe next parameter', () => {
    const dest = destinationForErrorBody(
      { code: ErrorCode.Unauthenticated, message: 'session required' },
      { currentPath: '/admin/settings' },
    );
    expect(dest).toBe('/login?next=%2Fadmin%2Fsettings');
  });

  it('maps INVALID_CREDENTIALS to the login page', () => {
    const dest = destinationForErrorBody(
      { code: ErrorCode.InvalidCredentials, message: 'wrong password' },
      { currentPath: '/portal' },
    );
    expect(dest).toMatch(/^\/login\?next=/);
  });

  it('maps ACCOUNT_SUSPENDED to /account-restricted', () => {
    const dest = destinationForErrorBody(
      { code: ErrorCode.AccountSuspended, message: 'suspended' },
      { currentPath: '/admin' },
    );
    expect(dest).toBe('/account-restricted');
  });

  it('maps ACCOUNT_DEACTIVATED to /account-restricted', () => {
    const dest = destinationForErrorBody(
      { code: ErrorCode.AccountDeactivated, message: 'deactivated' },
      { currentPath: '/portal/projects' },
    );
    expect(dest).toBe('/account-restricted');
  });

  it('maps MFA_REQUIRED to login with reason=mfa_required', () => {
    const dest = destinationForErrorBody(
      { code: ErrorCode.MfaRequired, message: 'step up' },
      { currentPath: '/admin' },
    );
    expect(dest).toMatch(/reason=mfa_required/);
    expect(dest).toMatch(/next=/);
  });

  it('returns null for unrecognized error codes (surface, do not navigate)', () => {
    for (const code of [
      ErrorCode.ValidationFailed,
      ErrorCode.Forbidden,
      ErrorCode.NotFound,
      ErrorCode.Conflict,
      ErrorCode.TooManyRequests,
      ErrorCode.ServiceUnavailable,
      ErrorCode.Internal,
    ] as const) {
      expect(
        destinationForErrorBody({ code, message: 'x' }, { currentPath: '/admin' }),
      ).toBeNull();
    }
  });

  it('guards against open redirects in the currentPath via safeNextPath', () => {
    const dest = destinationForErrorBody(
      { code: ErrorCode.Unauthenticated, message: 'x' },
      { currentPath: '//evil.example/phish' },
    );
    // safeNextPath falls back to '/', so the next is encoded /
    expect(dest).toBe('/login?next=%2F');
    expect(dest).not.toContain('evil.example');
  });

  it('guards against backslash-open-redirect in currentPath', () => {
    const dest = destinationForErrorBody(
      { code: ErrorCode.Unauthenticated, message: 'x' },
      { currentPath: '/\\evil.example' },
    );
    expect(dest).not.toContain('evil.example');
    expect(dest).toMatch(/^\/login\?next=/);
  });
});

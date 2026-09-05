import 'server-only';

import { redirect } from 'next/navigation';

import type { AuthContext } from '@/lib/auth/context';
import { hasActiveMembership } from '@/lib/auth/context';
import {
  ACCOUNT_RESTRICTED_PATH,
  ADMIN_ROOT_PATH,
  MFA_CHALLENGE_PATH,
  MFA_ENROLL_PATH,
  PORTAL_ROOT_PATH,
  loginRedirectPath,
} from '@/lib/auth/routes';
import { ApiError } from '@/server/api/errors';
import { requireAuthContext } from '@/server/auth/context';

/**
 * Route-protection guards for the Phase 9 layout roots (design §15, Layer 2).
 *
 * Phase 3 ships the guard modules and their unit tests; the layouts that call
 * them and every page arrive with Phase 9 — so no protected page can later be
 * rendered without an authority check that already works.
 *
 * Semantics: these run in Server Components, where the way to answer is a
 * REDIRECT (thrown by `next/navigation`), not an HTTP envelope. The mapping is
 * the §8 behaviour matrix for pages:
 *
 * | State                       | Admin guard          | Portal guard         |
 * | --------------------------- | -------------------- | -------------------- |
 * | no session                  | /login?next=…        | /login?next=…        |
 * | SUSPENDED / DEACTIVATED     | /account-restricted  | /account-restricted  |
 * | INVITED                     | /account-restricted?reason=invitation_pending (same) |
 * | wrong side of the wall      | → landing path       | → landing path       |
 * | CLIENT without active org   | n/a                  | /account-restricted  |
 * | INTERNAL staff              | + MFA policy (§6c)   | allowed through to portal only with membership — impossible (enforce_membership_user_type), so internal users are sent to /admin |
 *
 * MFA policy on /admin: staff with ZERO verified factors at aal1 are sent to
 * ENROLLMENT, not denial — the alternative locks staff out before they can
 * act (§6c). Staff WITH factors but a aal1 session are sent to the challenge.
 */

export interface GuardOptions {
  /** The guarded path, used as the safe `next` target back after login. */
  readonly currentPath: string;
}

/** Admin layout guard: session + INTERNAL + MFA (aal2 or forced enrollment). */
export async function requireAdminContext(options: GuardOptions): Promise<AuthContext> {
  const context = await resolveOrRedirect(options);

  if (context.userType !== 'INTERNAL') {
    // The authoritative user_type (database, not the JWT hint) says this is a
    // client user: send them to their own landing path.
    redirect(hasActiveMembership(context) ? PORTAL_ROOT_PATH : ACCOUNT_RESTRICTED_PATH);
  }

  // MFA is mandatory for SUPER_ADMIN and ADMIN (§13 control 8).
  if (!context.mfaEnrolled) {
    redirect(MFA_ENROLL_PATH);
  }
  if (context.aal !== 'aal2') {
    redirect(MFA_CHALLENGE_PATH);
  }

  return context;
}

/** Portal layout guard: session + CLIENT + at least one ACTIVE membership. */
export async function requirePortalContext(options: GuardOptions): Promise<AuthContext> {
  const context = await resolveOrRedirect(options);

  if (context.userType !== 'CLIENT') {
    redirect(ADMIN_ROOT_PATH);
  }
  if (!hasActiveMembership(context)) {
    // Account fine, tenant surfaces denied: the honest page is the restricted
    // one, not an empty portal (§8 membership-axis behaviour).
    redirect(ACCOUNT_RESTRICTED_PATH);
  }

  return context;
}

/**
 * Shared resolution + page-shaped failure mapping. Every ApiError from the
 * authority (`requireAuthContext`) becomes a redirect; nothing is surfaced as
 * an error page, because each of these states has a page that explains it.
 */
async function resolveOrRedirect(options: GuardOptions): Promise<AuthContext> {
  try {
    return await requireAuthContext();
  } catch (error) {
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'UNAUTHENTICATED':
        case 'MFA_REQUIRED':
          redirect(loginRedirectPath(options.currentPath));
        case 'ACCOUNT_SUSPENDED':
        case 'ACCOUNT_DEACTIVATED':
          redirect(ACCOUNT_RESTRICTED_PATH);
        case 'INVITATION_PENDING':
          redirect(`${ACCOUNT_RESTRICTED_PATH}?reason=invitation_pending`);
        case 'SERVICE_UNAVAILABLE':
          // Outage on a protected page: fail closed with the 503 page
          // middleware would have produced (§7), via the same mechanism.
          redirect(`${ACCOUNT_RESTRICTED_PATH}?reason=unavailable`);
        default:
          redirect(ACCOUNT_RESTRICTED_PATH);
      }
    }
    throw error;
  }
}

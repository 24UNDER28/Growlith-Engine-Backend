/**
 * Route vocabulary for authentication and route protection (design §15).
 *
 * THE TAXONOMY, stated once so middleware, guard modules and tests all read the
 * same constants:
 *
 * | Surface                                    | Class            |
 * | ------------------------------------------ | ---------------- |
 * | `/login`, `/forgot-password`, `/link-invalid`, `/account-restricted`, `/auth/set-password`, `/auth/reset-password`, `/auth/mfa-*` | public pages |
 * | `/auth/confirm`                            | public route handler (self-guarding token exchange) |
 * | `/admin/**`                                | protected (INTERNAL + aal2) |
 * | `/portal/**`                               | protected (CLIENT + an ACTIVE membership) |
 *
 * The dashboards themselves are Phase 9. Phase 3 ships the constants, the
 * landing derivation and the open-redirect guard so that middleware and the
 * layout guards have one authority to consult.
 */

/** Where an unauthenticated request to a protected page is sent. */
export const LOGIN_PATH = '/login' as const;

/** Where a suspended/deactivated account is sent (application access blocked). */
export const ACCOUNT_RESTRICTED_PATH = '/account-restricted' as const;

/** Neutral destination for invalid, expired or revoked email links. */
export const LINK_INVALID_PATH = '/link-invalid' as const;

/** Password screens reached with a session (post-invitation / post-recovery). */
export const SET_PASSWORD_PATH = '/auth/set-password' as const;
export const RESET_PASSWORD_PATH = '/auth/reset-password' as const;
export const FORGOT_PASSWORD_PATH = '/forgot-password' as const;

/** MFA step-up and enrollment screens (Phase 9 renders them). */
export const MFA_CHALLENGE_PATH = '/auth/mfa-challenge' as const;
export const MFA_ENROLL_PATH = '/auth/mfa-enroll' as const;

/** Landing roots. The layouts that render them arrive in Phase 9. */
export const ADMIN_ROOT_PATH = '/admin' as const;
export const PORTAL_ROOT_PATH = '/portal' as const;

/** Route prefixes that require a session before middleware lets the request through. */
export const PROTECTED_PREFIXES = ['/admin', '/portal'] as const;

/**
 * Public pages: no session required, and an authenticated visitor is redirected
 * onward to their landing page rather than staring at a login form they do not
 * need (middleware behaviour, §7 — a UX nicety, never a security check).
 */
export const PUBLIC_AUTH_PAGES = [
  LOGIN_PATH,
  FORGOT_PASSWORD_PATH,
  SET_PASSWORD_PATH,
  RESET_PASSWORD_PATH,
  MFA_CHALLENGE_PATH,
  MFA_ENROLL_PATH,
  LINK_INVALID_PATH,
  ACCOUNT_RESTRICTED_PATH,
] as const;

/** True when the path sits under a protected prefix. */
export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** True when the path is one of the public auth pages (exact match, not nested). */
export function isPublicAuthPage(pathname: string): boolean {
  return (PUBLIC_AUTH_PAGES as readonly string[]).includes(pathname);
}

/**
 * The `next` parameter accepts same-origin relative paths ONLY: it must start
 * with `/` and must not start with `//` (protocol-relative → another origin).
 * Anything else — a full URL, a back-navigation trick, `/\evil.com` — falls back
 * to the provided default. This is the open-redirect guard every redirect that
 * carries a caller-controlled destination goes through (middleware §7, the
 * confirm callback §2.2, the Phase 9 fetch wrapper §6).
 */
export function safeNextPath(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return fallback;
  }
  return value;
}

/**
 * Derive the landing path for an authenticated identity.
 *
 * `userType` here is the *authoritative* value from the resolved auth context
 * (`profiles.user_type`) when available. Middleware passes the non-authoritative
 * `app_metadata.user_type` hint instead — a stale hint can at worst send someone
 * to the wrong landing page, where the layout guard (authoritative) corrects the
 * routing (ADR-0011, §7).
 *
 * A CLIENT identity whose memberships are all inactive has no surface to land
 * on: the account itself is fine, but every tenant surface is denied, so the
 * honest destination is the restricted page (§8 membership-axis behaviour).
 */
export function landingPathFor(input: {
  readonly userType: 'INTERNAL' | 'CLIENT';
  /** Whether the identity holds at least one ACTIVE organization membership. */
  readonly hasActiveMembership: boolean;
}): string {
  if (input.userType === 'INTERNAL') {
    return ADMIN_ROOT_PATH;
  }
  return input.hasActiveMembership ? PORTAL_ROOT_PATH : ACCOUNT_RESTRICTED_PATH;
}

/**
 * The coarse landing derivation middleware uses. Takes the NON-authoritative
 * `app_metadata.user_type` hint (ADR-0011): INTERNAL → `/admin`, CLIENT →
 * `/portal`, no hint → `null` (pass through; the page resolves the truth).
 * Membership state is deliberately NOT consulted — middleware makes no
 * database reads (§7), so a CLIENT without an active membership lands on
 * `/portal` and is corrected by the portal layout guard.
 */
export function landingHintFor(userType: 'INTERNAL' | 'CLIENT' | null): string | null {
  if (userType === 'INTERNAL') {
    return ADMIN_ROOT_PATH;
  }
  if (userType === 'CLIENT') {
    return PORTAL_ROOT_PATH;
  }
  return null;
}

/**
 * Build a redirect to the login page with a safe `next` target.
 *
 * `reason` is a fixed vocabulary consumed by the Phase 9 login page copy
 * (`session_expired`, `mfa_required`, …); it is never caller-controlled free
 * text, so it cannot become a log-injection or phishing vector.
 */
export function loginRedirectPath(next: string, reason?: string): string {
  const safeNext = safeNextPath(next, '/');
  const suffix =
    reason === undefined || reason.length === 0 ? '' : `&reason=${encodeURIComponent(reason)}`;
  return `${LOGIN_PATH}?next=${encodeURIComponent(safeNext)}${suffix}`;
}

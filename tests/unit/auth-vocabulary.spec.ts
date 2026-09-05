import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_ACCESS,
  ACCOUNT_STATUS_TRANSITIONS,
  accountTransitionPolicy,
  isActiveStatus,
} from '@/lib/auth/account-status';
import {
  ACCOUNT_RESTRICTED_PATH,
  ADMIN_ROOT_PATH,
  FORGOT_PASSWORD_PATH,
  LOGIN_PATH,
  PORTAL_ROOT_PATH,
  PUBLIC_AUTH_PAGES,
  isProtectedPath,
  isPublicAuthPage,
  landingHintFor,
  landingPathFor,
  loginRedirectPath,
  safeNextPath,
} from '@/lib/auth/routes';

/**
 * The auth vocabulary layer is pure data + pure functions — the whole surface
 * is unit-testable with no doubles (§J: contract vocabulary before routes).
 */

describe('safeNextPath — the open-redirect guard', () => {
  it('accepts same-origin absolute paths', () => {
    expect(safeNextPath('/admin', '/')).toBe('/admin');
    expect(safeNextPath('/portal/orgs/33?page=2', '/')).toBe('/portal/orgs/33?page=2');
    expect(safeNextPath('/account-restricted', '/admin')).toBe('/account-restricted');
  });

  it('falls back on null, empty and non-string values', () => {
    expect(safeNextPath(null, '/admin')).toBe('/admin');
    expect(safeNextPath(undefined, '/admin')).toBe('/admin');
    expect(safeNextPath('', '/admin')).toBe('/admin');
  });

  it('rejects cross-origin shapes', () => {
    expect(safeNextPath('https://evil.example/phish', '/')).toBe('/');
    expect(safeNextPath('//evil.example', '/')).toBe('/'); // protocol-relative
    expect(safeNextPath('/\\evil.example', '/')).toBe('/'); // backslash trick
    expect(safeNextPath('relative/path', '/')).toBe('/');
    expect(safeNextPath(' ', '/')).toBe('/');
  });

  it('is total: never returns anything that is not /-rooted', () => {
    for (const hostile of ['\u0000/admin', '/%2f%2fevil', 'javascript:alert(1)']) {
      const result = safeNextPath(hostile, '/fallback');
      expect(result.startsWith('/')).toBe(true);
    }
  });
});

describe('protected prefixes and public auth pages', () => {
  it('treats exact and nested protected paths as protected, neighbours not', () => {
    expect(isProtectedPath('/admin')).toBe(true);
    expect(isProtectedPath('/admin/settings/roles')).toBe(true);
    expect(isProtectedPath('/portal')).toBe(true);
    expect(isProtectedPath('/portal/org/33')).toBe(true);
    expect(isProtectedPath('/adminx')).toBe(false); // prefix boundary
    expect(isProtectedPath('/portal-docs')).toBe(false);
    expect(isProtectedPath('/')).toBe(false);
    expect(isProtectedPath(LOGIN_PATH)).toBe(false);
  });

  it('recognises exactly the public auth pages, no nesting below them', () => {
    for (const page of PUBLIC_AUTH_PAGES) {
      expect(isPublicAuthPage(page)).toBe(true);
    }
    expect(isPublicAuthPage(`${LOGIN_PATH}/nested`)).toBe(false);
    expect(isPublicAuthPage('/admin')).toBe(false);
    expect(isPublicAuthPage('/')).toBe(false);
    expect(isPublicAuthPage(ACCOUNT_RESTRICTED_PATH)).toBe(true);
    expect(isPublicAuthPage(FORGOT_PASSWORD_PATH)).toBe(true);
  });
});

describe('landingPathFor — authoritative landing derivation', () => {
  it('INTERNAL always lands on /admin, membership notwithstanding', () => {
    expect(landingPathFor({ userType: 'INTERNAL', hasActiveMembership: false })).toBe(
      ADMIN_ROOT_PATH,
    );
    expect(landingPathFor({ userType: 'INTERNAL', hasActiveMembership: true })).toBe(
      ADMIN_ROOT_PATH,
    );
  });

  it('CLIENT lands on /portal with an active membership, restricted without', () => {
    expect(landingPathFor({ userType: 'CLIENT', hasActiveMembership: true })).toBe(
      PORTAL_ROOT_PATH,
    );
    expect(landingPathFor({ userType: 'CLIENT', hasActiveMembership: false })).toBe(
      ACCOUNT_RESTRICTED_PATH,
    );
  });
});

describe('landingHintFor — the middleware (non-authoritative) hint', () => {
  it('maps the hint to a landing page or null', () => {
    expect(landingHintFor('INTERNAL')).toBe(ADMIN_ROOT_PATH);
    expect(landingHintFor('CLIENT')).toBe(PORTAL_ROOT_PATH);
    expect(landingHintFor(null)).toBe(null);
  });
});

describe('loginRedirectPath', () => {
  it('carries a sanitised next and an optional fixed-vocabulary reason', () => {
    expect(loginRedirectPath('/portal')).toBe(`${LOGIN_PATH}?next=%2Fportal`);
    expect(loginRedirectPath('/portal', 'session_expired')).toBe(
      `${LOGIN_PATH}?next=%2Fportal&reason=session_expired`,
    );
  });

  it('sanitises the next parameter itself, so it composes with raw input', () => {
    expect(loginRedirectPath('//evil.example')).toBe(`${LOGIN_PATH}?next=%2F`);
    expect(loginRedirectPath('https://evil.example')).toBe(`${LOGIN_PATH}?next=%2F`);
  });
});

describe('account statuses — vocabulary invariants', () => {
  it('lists the four statuses exactly once each', () => {
    expect([...ACCOUNT_STATUSES].sort()).toEqual(['ACTIVE', 'DEACTIVATED', 'INVITED', 'SUSPENDED']);
  });

  it('grants full access to ACTIVE only', () => {
    expect(isActiveStatus('ACTIVE')).toBe(true);
    for (const status of ACCOUNT_STATUSES.filter((s) => s !== 'ACTIVE')) {
      expect(isActiveStatus(status)).toBe(false);
    }
    expect(ACCOUNT_STATUS_ACCESS.ACTIVE).toBe('allowed');
    expect(ACCOUNT_STATUS_ACCESS.INVITED).toBe('invitation-pending');
    expect(ACCOUNT_STATUS_ACCESS.SUSPENDED).toBe('suspended');
    expect(ACCOUNT_STATUS_ACCESS.DEACTIVATED).toBe('blocked');
  });
});

describe('accountTransitionPolicy — the §8 transition graph', () => {
  it('contains exactly one accept-invitation edge and it is not operator-driven', () => {
    const accept = ACCOUNT_STATUS_TRANSITIONS.filter((t) => t.via === 'accept-invitation');
    expect(accept).toHaveLength(1);
    expect(accept[0]).toMatchObject({ from: 'INVITED', to: 'ACTIVE', operatorDriven: false });
  });

  it('allows the operator-driven edges for a platform role', () => {
    expect(accountTransitionPolicy('ACTIVE', 'SUSPENDED', 'ADMIN')).toMatchObject({
      allowed: true,
    });
    expect(accountTransitionPolicy('SUSPENDED', 'ACTIVE', 'ADMIN')).toMatchObject({
      allowed: true,
    });
    expect(accountTransitionPolicy('ACTIVE', 'DEACTIVATED', 'ADMIN')).toMatchObject({
      allowed: true,
    });
    expect(accountTransitionPolicy('SUSPENDED', 'DEACTIVATED', 'ADMIN')).toMatchObject({
      allowed: true,
    });
  });

  it('gates reactivate on SUPER_ADMIN only', () => {
    expect(accountTransitionPolicy('DEACTIVATED', 'ACTIVE', 'SUPER_ADMIN')).toMatchObject({
      allowed: true,
    });
    expect(accountTransitionPolicy('DEACTIVATED', 'ACTIVE', 'ADMIN')).toMatchObject({
      allowed: false,
    });
    expect(accountTransitionPolicy('DEACTIVATED', 'ACTIVE', null)).toMatchObject({
      allowed: false,
    });
  });

  it('refuses INVITED → ACTIVE for operators — acceptance belongs to the RPC', () => {
    expect(accountTransitionPolicy('INVITED', 'ACTIVE', 'SUPER_ADMIN')).toMatchObject({
      allowed: false,
    });
  });

  it('refuses every role-less (client) transition and every illegal edge', () => {
    expect(accountTransitionPolicy('ACTIVE', 'SUSPENDED', null)).toMatchObject({ allowed: false });
    expect(accountTransitionPolicy('INVITED', 'SUSPENDED', 'ADMIN')).toMatchObject({
      allowed: false,
    });
    expect(accountTransitionPolicy('DEACTIVATED', 'SUSPENDED', 'SUPER_ADMIN')).toMatchObject({
      allowed: false,
    });
    expect(accountTransitionPolicy('ACTIVE', 'INVITED', 'SUPER_ADMIN')).toMatchObject({
      allowed: false,
    });
  });
});

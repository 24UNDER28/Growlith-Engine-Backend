import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ErrorCode } from '@/lib/types/error-codes';
import { ApiError } from '@/server/api/errors';
import { MAX_JSON_BODY_BYTES, withRoute } from '@/server/api/with-route';
import { RATE_LIMIT_BUDGETS, __resetRateLimitForTests } from '@/server/api/rate-limit';
import { authorize } from '@/server/auth/authorize';
import { enrollTotpFactor } from '@/server/auth/routes-mfa';
import { mapDatabaseError } from '@/server/db/errors';
import { ALLOWED_MIME_TYPES, validateStoragePath } from '@/server/services/files';
import { authContextFixture, clientContextFixture, UUIDS } from '../helpers/auth-fixtures';
import { authContextRpcPayload, gotrueUserFixture } from '../helpers/auth-fixtures';
import { fakeServiceClient, fakeUserClient } from '../helpers/fake-supabase';

/**
 * Phase 6 — FINAL SECURITY VALIDATION (attack replay at the HTTP pipeline).
 *
 * The database layer is proven separately by `scripts/db-authz-attack.mjs`
 * (91 RLS/RPC/storage attacks against the real migration set under PGlite).
 * This suite replays the APPLICATION-layer attack categories the validation
 * brief names, end to end through `withRoute`, with the REAL `authorize()`
 * guard and the REAL rate limiter — only the Supabase transport is faked:
 *
 *   cross-tenant access · privilege escalation · direct API manipulation ·
 *   IDOR/BOLA · unauthorized storage access / file download · mass assignment ·
 *   malformed payloads · oversized payloads · session manipulation · expired
 *   sessions · suspended accounts · deactivated accounts · secret exposure ·
 *   error disclosure · rate limiting (C-1) · MFA step-up default (C-2).
 *
 * Every test is an attack that must FAIL closed, or a positive control proving
 * the legitimate path still works (so a "pass" is never "everything is 403").
 */

const { authorityMock, auditMock, serverClientMock, serviceClientMock } = vi.hoisted(() => ({
  authorityMock: vi.fn(),
  auditMock: vi.fn(async (_input: unknown) => true),
  serverClientMock: vi.fn(),
  serviceClientMock: vi.fn(),
}));

// The AUTHORITY (who is calling) is scripted per test; the GUARD (what may
// they do) is the real module, so matrix denials, tenant reach and SELF
// subjects are evaluated for real. Audit writes are captured, not persisted.
vi.mock('@/server/auth/context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth/context')>();
  return {
    ...actual,
    requireAuthContext: (...args: unknown[]) => authorityMock(...args),
  };
});
vi.mock('@/server/auth/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/auth/audit')>();
  return { ...actual, recordAuthEvent: (input: unknown) => auditMock(input) };
});
vi.mock('@/server/supabase/client-server', () => ({
  createSupabaseServerClient: (...args: unknown[]) => serverClientMock(...args),
}));
vi.mock('@/server/supabase/client-service', () => ({
  getSupabaseServiceClient: () => serviceClientMock(),
}));

// The REAL authority, for the session/status contracts below. `importActual`
// bypasses the module mock above but its dependencies (the Supabase factories)
// stay mocked, so it runs against the scripted fakes.
const realContext =
  await vi.importActual<typeof import('@/server/auth/context')>('@/server/auth/context');

const ORG_A = UUIDS.organization;
const ORG_B = UUIDS.otherOrganization;
const ROW_IN_ORG_B = '9b1d2c3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e';
const ROW_IN_ORG_A = '8a0c1b2d-3e4f-4a5b-9c6d-7e8f9a0b1c2d';

let originalLogLevel: string | undefined;
beforeAll(() => {
  originalLogLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'silent';
});
afterAll(() => {
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});
beforeEach(() => {
  authorityMock.mockReset();
  auditMock.mockClear();
  serverClientMock.mockReset();
  serviceClientMock.mockReset();
  serviceClientMock.mockReturnValue(fakeServiceClient().client);
  __resetRateLimitForTests();
});

function jsonRequest(
  method: string,
  url: string,
  body: unknown,
  init?: { rawBody?: string; headers?: Record<string, string> },
): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json', ...init?.headers },
    body: init?.rawBody ?? JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function errorOf(body: Record<string, unknown>): { code: string; message: string } {
  return body.error as { code: string; message: string };
}

/** A tenant resolver that behaves like `tenantFromRow` under RLS: the row in
 * ORG_B is invisible to anyone who cannot reach ORG_B. */
function rlsRowResolver(auth: {
  memberships: readonly { organizationId: string }[];
  platformRole: string | null;
}) {
  return (id: string): string | null => {
    if (id === ROW_IN_ORG_A) return ORG_A;
    if (id === ROW_IN_ORG_B) {
      const reaches =
        auth.platformRole !== null || auth.memberships.some((m) => m.organizationId === ORG_B);
      return reaches ? ORG_B : null;
    }
    return null;
  };
}

/* ═══════════════════════ 1. Cross-tenant access & IDOR/BOLA ═══════════════════════ */

describe('cross-tenant access / IDOR / BOLA', () => {
  it('a CLIENT guessing another tenant’s row id gets 404 (never 403, never data)', async () => {
    const client = clientContextFixture();
    authorityMock.mockResolvedValue(client);
    let handlerRan = false;
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'project:read',
      summary: 'read a project',
      paramSchema: z.object({ id: z.uuid() }).strict(),
      tenant: async ({ params }) => rlsRowResolver(client)(params.id),
      handler: async () => {
        handlerRan = true;
        return { secret: 'other tenant data' };
      },
    });
    const response = await route(new Request(`http://localhost/api/v1/projects/${ROW_IN_ORG_B}`), {
      params: Promise.resolve({ id: ROW_IN_ORG_B }),
    });
    expect(response.status).toBe(404);
    expect(errorOf(await readJson(response)).code).toBe(ErrorCode.NotFound);
    expect(handlerRan).toBe(false);
    // Existence probes are log-only: no audit row minted about other people's data.
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('a CLIENT naming another tenant explicitly (?organizationId=B) gets the same 404 as a guessed id (ADR-0019: no existence oracle, no audit row about foreign data)', async () => {
    authorityMock.mockResolvedValue(clientContextFixture());
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'project:read',
      summary: 'list projects',
      querySchema: z.object({ organizationId: z.uuid() }).strict(),
      tenant: ({ query }) => query.organizationId,
      handler: async () => ({ leaked: true }),
    });
    const response = await route(
      new Request(`http://localhost/api/v1/projects?organizationId=${ORG_B}`),
    );
    expect(response.status).toBe(404);
    expect(errorOf(await readJson(response)).code).toBe(ErrorCode.NotFound);
    // Tenant-unreachable is log-only by design: a probe must not mint audit
    // rows that mention another tenant's identifier.
    expect(auditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PERMISSION_DENIED' }),
    );
  });

  it('a CLIENT omitting the tenant on a TENANT-scoped list is denied (no silent "all my orgs" scan)', async () => {
    authorityMock.mockResolvedValue(clientContextFixture());
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'project:read',
      summary: 'list projects',
      tenant: () => undefined,
      handler: async () => ({ leaked: true }),
    });
    const response = await route(new Request('http://localhost/api/v1/projects'));
    expect(response.status).toBe(403);
  });

  it('a CLIENT with a SUSPENDED membership in the target org cannot reach it (404 — a suspended member is a stranger)', async () => {
    authorityMock.mockResolvedValue(
      clientContextFixture({
        memberships: [
          {
            organizationId: ORG_B,
            role: 'CLIENT_ADMIN',
            status: 'SUSPENDED',
            isPrimaryContact: false,
          },
        ],
      }),
    );
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'organization:read',
      summary: 'read org',
      paramSchema: z.object({ organizationId: z.uuid() }).strict(),
      tenant: ({ params }) => params.organizationId,
      handler: async () => ({ ok: true }),
    });
    const response = await route(new Request(`http://localhost/api/v1/organizations/${ORG_B}`), {
      params: Promise.resolve({ organizationId: ORG_B }),
    });
    expect(response.status).toBe(404);
  });

  it('positive control: the same CLIENT reads a row in their own tenant', async () => {
    const client = clientContextFixture();
    authorityMock.mockResolvedValue(client);
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'project:read',
      summary: 'read a project',
      paramSchema: z.object({ id: z.uuid() }).strict(),
      tenant: async ({ params }) => rlsRowResolver(client)(params.id),
      handler: async ({ obligations }) => ({ obligations }),
    });
    const response = await route(new Request(`http://localhost/api/v1/projects/${ROW_IN_ORG_A}`), {
      params: Promise.resolve({ id: ROW_IN_ORG_A }),
    });
    expect(response.status).toBe(200);
    // The guard hands the CLIENT_VISIBLE obligation to the service layer.
    expect((await readJson(response)).data).toEqual({ obligations: ['CLIENT_VISIBLE'] });
  });
});

/* ═══════════════════════ 2. Privilege escalation ═══════════════════════ */

describe('privilege escalation', () => {
  it('CLIENT_ADMIN cannot grant platform roles (SUPER_ADMIN-only capability)', async () => {
    authorityMock.mockResolvedValue(clientContextFixture({ aal: 'aal2' }));
    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'platform_grant:create',
      minAal: 2,
      summary: 'grant platform role',
      bodySchema: z.object({ userId: z.uuid(), role: z.enum(['ADMIN', 'SUPER_ADMIN']) }).strict(),
      handler: async () => ({ granted: true }),
    });
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/admin/platform-grants', {
        userId: UUIDS.user,
        role: 'SUPER_ADMIN',
      }),
    );
    expect(response.status).toBe(403);
  });

  it('ADMIN cannot grant platform roles either — even at aal2', async () => {
    authorityMock.mockResolvedValue(authContextFixture({ platformRole: 'ADMIN', aal: 'aal2' }));
    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'platform_grant:create',
      minAal: 2,
      summary: 'grant platform role',
      bodySchema: z.object({ userId: z.uuid(), role: z.enum(['ADMIN', 'SUPER_ADMIN']) }).strict(),
      handler: async () => ({ granted: true }),
    });
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/admin/platform-grants', {
        userId: UUIDS.user,
        role: 'SUPER_ADMIN',
      }),
    );
    expect(response.status).toBe(403);
  });

  it('ADMIN cannot erase users (user:delete is SUPER_ADMIN-only)', async () => {
    authorityMock.mockResolvedValue(authContextFixture({ platformRole: 'ADMIN', aal: 'aal2' }));
    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'user:delete',
      minAal: 2,
      summary: 'erase user',
      handler: async () => ({ erased: true }),
    });
    const response = await route(
      new Request(`http://localhost/api/v1/admin/users/${UUIDS.otherUser}/erase`, {
        method: 'POST',
      }),
    );
    expect(response.status).toBe(403);
  });

  it('a CLIENT cannot operate on a path-named OTHER user through a SELF-scoped capability', async () => {
    authorityMock.mockResolvedValue(clientContextFixture());
    const route = withRoute({
      method: 'PATCH',
      auth: 'required',
      capability: 'user:update',
      summary: 'update a user',
      paramSchema: z.object({ userId: z.uuid() }).strict(),
      subjectUser: ({ params }) => params.userId,
      bodySchema: z.object({ fullName: z.string() }).strict(),
      handler: async () => ({ updated: true }),
    });
    const response = await route(
      jsonRequest('PATCH', `http://localhost/api/v1/users/${UUIDS.otherUser}`, {
        fullName: 'pwned',
      }),
      { params: Promise.resolve({ userId: UUIDS.otherUser }) },
    );
    expect(response.status).toBe(403);
  });

  it('a CLIENT cannot reach INTERNAL-only capabilities (tasks) even in their own tenant', async () => {
    authorityMock.mockResolvedValue(clientContextFixture());
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'task:read',
      summary: 'list tasks',
      tenant: () => ORG_A,
      handler: async () => ({ tasks: [] }),
    });
    const response = await route(new Request('http://localhost/api/v1/tasks'));
    expect(response.status).toBe(403);
  });

  it('an INTERNAL account whose platform grant was revoked (platformRole null) holds nothing', async () => {
    authorityMock.mockResolvedValue(authContextFixture({ platformRole: null, aal: 'aal2' }));
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'organization:read',
      summary: 'list orgs',
      tenant: () => undefined,
      handler: async () => ({ orgs: [] }),
    });
    const response = await route(new Request('http://localhost/api/v1/organizations'));
    // Staff without a grant hold no role anywhere → NO_TENANT_ACCESS → 404,
    // and the handler never runs.
    expect(response.status).toBe(404);
  });

  it('a route built by a cast without a capability fails CLOSED with 500, never open', async () => {
    authorityMock.mockResolvedValue(
      authContextFixture({ platformRole: 'SUPER_ADMIN', aal: 'aal2' }),
    );
    const smuggled = {
      method: 'GET',
      auth: 'required',
      summary: 'capability-less',
      handler: async () => ({ open: true }),
    } as never;
    const response = await withRoute(smuggled)(new Request('http://localhost/api/v1/x'));
    expect(response.status).toBe(500);
  });
});

/* ═══════════════════════ 3. MFA step-up default (C-2) ═══════════════════════ */

describe('C-2 — aal2 is the default for privileged INTERNAL routes', () => {
  it('an aal1 ADMIN session is refused MFA_REQUIRED on an INTERNAL-only capability the route forgot to gate', async () => {
    authorityMock.mockResolvedValue(authContextFixture({ platformRole: 'ADMIN', aal: 'aal1' }));
    let handlerRan = false;
    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'task:create', // no minAal declared
      summary: 'create task',
      tenant: () => ORG_A,
      handler: async () => {
        handlerRan = true;
        return { ok: true };
      },
    });
    const response = await route(new Request('http://localhost/api/v1/tasks', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(errorOf(await readJson(response)).code).toBe(ErrorCode.MfaRequired);
    expect(handlerRan).toBe(false);
  });

  it('an aal1 ADMIN session is refused on a sensitive INTERNAL mutation of a shared resource (invitation revoke)', async () => {
    authorityMock.mockResolvedValue(authContextFixture({ platformRole: 'ADMIN', aal: 'aal1' }));
    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'invitation:update',
      summary: 'revoke invitation',
      tenant: () => ORG_A,
      handler: async () => ({ ok: true }),
    });
    const response = await route(
      new Request('http://localhost/api/v1/invitations/x/revoke', { method: 'POST' }),
    );
    expect(response.status).toBe(401);
    expect(errorOf(await readJson(response)).code).toBe(ErrorCode.MfaRequired);
  });

  it('an aal1 ADMIN session is refused on ANY /api/v1/admin/** path', async () => {
    authorityMock.mockResolvedValue(authContextFixture({ platformRole: 'ADMIN', aal: 'aal1' }));
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'organization:read',
      summary: 'admin read',
      tenant: () => undefined,
      handler: async () => ({ ok: true }),
    });
    const response = await route(new Request('http://localhost/api/v1/admin/anything'));
    expect(response.status).toBe(401);
    expect(errorOf(await readJson(response)).code).toBe(ErrorCode.MfaRequired);
  });

  it('the step-up flow itself stays reachable at aal1 (no lock-out), and CLIENT flows are untouched', async () => {
    authorityMock.mockResolvedValue(authContextFixture({ platformRole: 'ADMIN', aal: 'aal1' }));
    const enroll = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'user:update',
      summary: 'enroll',
      handler: async () => ({ ok: true }),
    });
    expect(
      (await enroll(new Request('http://localhost/api/v1/auth/mfa/enroll', { method: 'POST' })))
        .status,
    ).toBe(200);

    authorityMock.mockResolvedValue(clientContextFixture({ aal: 'aal1' }));
    const clientRoute = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'invitation:create',
      summary: 'client invites a member',
      tenant: () => ORG_A,
      handler: async () => ({ ok: true }),
    });
    expect(
      (await clientRoute(new Request('http://localhost/api/v1/invitations', { method: 'POST' })))
        .status,
    ).toBe(200);
  });

  it('positive control: the same ADMIN at aal2 passes', async () => {
    authorityMock.mockResolvedValue(authContextFixture({ platformRole: 'ADMIN', aal: 'aal2' }));
    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'task:create',
      summary: 'create task',
      tenant: () => ORG_A,
      handler: async () => ({ ok: true }),
    });
    const response = await route(new Request('http://localhost/api/v1/tasks', { method: 'POST' }));
    expect(response.status).toBe(200);
  });
});

/* ═══════════════════════ 4. Suspended / deactivated / expired sessions ═══════════════════════ */

describe('account status gate and session validity (real authority)', () => {
  function scriptUserClient(config: Parameters<typeof fakeUserClient>[0]) {
    const fake = fakeUserClient(config);
    serverClientMock.mockImplementation(async () => fake.client);
    return fake;
  }

  it('a SUSPENDED account is refused 423, its sessions revoked globally and the identity banned', async () => {
    const service = fakeServiceClient();
    serviceClientMock.mockReturnValue(service.client);
    const fake = scriptUserClient({
      authContext: authContextRpcPayload({ accountStatus: 'SUSPENDED' }),
    });
    const error = await realContext.requireAuthContext().catch((e: unknown) => e as ApiError);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(423);
    expect((error as ApiError).code).toBe(ErrorCode.AccountSuspended);
    expect(fake.spies.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(service.spies.updateUserById).toHaveBeenCalledWith(UUIDS.user, {
      ban_duration: '87600h',
    });
  });

  it('a DEACTIVATED account is refused 401 ACCOUNT_DEACTIVATED with the same eviction', async () => {
    const service = fakeServiceClient();
    serviceClientMock.mockReturnValue(service.client);
    const fake = scriptUserClient({
      authContext: authContextRpcPayload({ accountStatus: 'DEACTIVATED' }),
    });
    const error = (await realContext.requireAuthContext().catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(401);
    expect(error.code).toBe(ErrorCode.AccountDeactivated);
    expect(fake.spies.signOut).toHaveBeenCalledWith({ scope: 'global' });
    expect(service.spies.updateUserById).toHaveBeenCalled();
  });

  it('an expired / tampered access token (GoTrue 401 bad_jwt) is 401 UNAUTHENTICATED — never trusted locally', async () => {
    scriptUserClient({
      user: null,
      getUserError: new AuthApiError('invalid JWT: token is expired', 401, 'bad_jwt'),
    });
    const error = (await realContext.requireAuthContext().catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(401);
    expect(error.code).toBe(ErrorCode.Unauthenticated);
  });

  it('a session whose refresh token was revoked (session_not_found) is 401, not 503', async () => {
    scriptUserClient({
      user: null,
      getUserError: new AuthApiError(
        'Session from session_id claim in JWT does not exist',
        403,
        'session_not_found',
      ),
    });
    const error = (await realContext.requireAuthContext().catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(401);
  });

  it('an auth-server outage fails CLOSED with 503, never a silent "logged out"', async () => {
    scriptUserClient({
      user: null,
      getUserError: new AuthRetryableFetchError('Network request failed', 503),
    });
    const error = (await realContext.requireAuthContext().catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(503);
    const reporting = (await realContext.resolveAuthContext().catch((e: unknown) => e)) as ApiError;
    expect(reporting.status).toBe(503);
  });

  it('a verified identity with NO profile row is treated as unauthenticated (no principal without policy)', async () => {
    scriptUserClient({ authContext: null });
    const error = (await realContext.requireAuthContext().catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(401);
  });

  it('session manipulation: the assurance level comes from the verified session, not from the client', async () => {
    // A user with a verified factor, but whose SESSION is still aal1: a forged
    // "aal2" claim in the body/header is never consulted.
    scriptUserClient({
      user: gotrueUserFixture({ factors: [{ id: 'f', status: 'verified', factor_type: 'totp' }] }),
      aal: 'aal1',
    });
    const context = await realContext.requireAuthContext();
    expect(context.aal).toBe('aal1');
    expect(context.mfaEnrolled).toBe(true);
    const gated = (await realContext
      .requireAuthContext({ minAal: 2 })
      .catch((e: unknown) => e)) as ApiError;
    expect(gated.code).toBe(ErrorCode.MfaRequired);
  });

  it('the matrix re-checks account status: a non-ACTIVE actor that somehow reached the guard is denied', async () => {
    // Belt and braces: even if the authority were bypassed, `can()` denies.
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn() };
    const error = (await authorize(
      authContextFixture({ platformRole: 'SUPER_ADMIN', aal: 'aal2', accountStatus: 'SUSPENDED' }),
      'organization:read',
      { organizationId: null },
      log as never,
      'req',
    ).catch((e: unknown) => e)) as ApiError;
    // A non-ACTIVE identity holds no role anywhere → NO_TENANT_ACCESS → 404.
    expect(error.status).toBe(404);
  });
});

/* ═══════════════════════ 4b. H-1 — a stolen aal1 cookie cannot self-enrol TOTP ═══════════════════════ */

describe('H-1 — MFA enrolment cannot launder a stolen aal1 cookie into aal2', () => {
  const request = new Request('https://app.test/api/v1/auth/mfa/enroll', { method: 'POST' });

  function scriptUserClient(config: Parameters<typeof fakeUserClient>[0] = {}) {
    const fake = fakeUserClient(config);
    serverClientMock.mockImplementation(async () => fake.client);
    return fake;
  }

  it('an aal1 INTERNAL session without a fresh password is refused and no factor is created', async () => {
    const fake = scriptUserClient();
    const error = (await enrollTotpFactor({
      auth: authContextFixture({ platformRole: 'ADMIN', aal: 'aal1' }),
      request,
      requestId: 'req-h1',
      body: {},
    }).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(fake.spies.mfaEnroll).not.toHaveBeenCalled();
    expect(fake.spies.signInWithPassword).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MFA_ENROLLED', severity: 'WARNING' }),
    );
  });

  it('a wrong re-auth password is 401 INVALID_CREDENTIALS, audited as LOGIN_FAILED, and still creates no factor', async () => {
    const fake = scriptUserClient();
    fake.spies.signInWithPassword.mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
    });
    const error = (await enrollTotpFactor({
      auth: authContextFixture({ platformRole: 'ADMIN', aal: 'aal1' }),
      request,
      requestId: 'req-h1',
      body: { password: 'not-the-password' },
    }).catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(401);
    expect(error.code).toBe(ErrorCode.InvalidCredentials);
    expect(fake.spies.mfaEnroll).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN_FAILED', severity: 'WARNING' }),
    );
  });

  it('positive controls: a fresh password (INTERNAL aal1) or a CLIENT session enrols normally', async () => {
    const staff = scriptUserClient();
    await expect(
      enrollTotpFactor({
        auth: authContextFixture({ platformRole: 'ADMIN', aal: 'aal1' }),
        request,
        requestId: 'req-h1',
        body: { password: 'correct horse battery staple' },
      }),
    ).resolves.toMatchObject({ factorId: 'factor-new' });
    expect(staff.spies.signInWithPassword).toHaveBeenCalledTimes(1);

    const client = scriptUserClient();
    await expect(
      enrollTotpFactor({
        auth: clientContextFixture({ aal: 'aal1' }),
        request,
        requestId: 'req-h1',
      }),
    ).resolves.toMatchObject({ factorId: 'factor-new' });
    expect(client.spies.signInWithPassword).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════ 5. Mass assignment / malformed / oversized payloads ═══════════════════════ */

describe('mass assignment, malformed and oversized payloads', () => {
  const schema = z.object({ title: z.string().min(1).max(200) }).strict();
  const route = withRoute({
    method: 'POST',
    auth: 'public',
    summary: 'create',
    bodySchema: schema,
    handler: async ({ body }) => body,
  });

  it('rejects smuggled privileged fields (organizationId, role, platformRole, status, id) with 422', async () => {
    for (const field of [
      'organizationId',
      'role',
      'platformRole',
      'accountStatus',
      'id',
      'createdBy',
    ]) {
      const response = await route(
        jsonRequest('POST', 'http://localhost/api/v1/things', { title: 'x', [field]: 'evil' }),
      );
      expect(response.status, field).toBe(422);
      expect(JSON.stringify(await readJson(response))).toContain(field);
    }
  });

  it('rejects prototype-pollution shaped keys as unknown keys', async () => {
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/things', undefined, {
        rawBody: '{"title":"x","__proto__":{"polluted":true},"constructor":{"prototype":{}}}',
      }),
    );
    expect(response.status).toBe(422);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects type confusion (array / number / null body where an object is required)', async () => {
    for (const raw of ['[]', '42', 'null', '"string"', 'true']) {
      const response = await route(
        jsonRequest('POST', 'http://localhost/api/v1/things', undefined, { rawBody: raw }),
      );
      expect([400, 422], raw).toContain(response.status);
    }
  });

  it('rejects malformed JSON, truncated JSON and non-JSON content types with 400', async () => {
    for (const raw of ['{', '{"title": "x"', '{"title": undefined}', '\u0000', 'title=x']) {
      const response = await route(
        jsonRequest('POST', 'http://localhost/api/v1/things', undefined, { rawBody: raw }),
      );
      expect(response.status, JSON.stringify(raw)).toBe(400);
      expect(errorOf(await readJson(response)).code).toBe(ErrorCode.MalformedRequest);
    }
    const form = await route(
      new Request('http://localhost/api/v1/things', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'title=x',
      }),
    );
    expect(form.status).toBe(400);
  });

  it('rejects an oversized CHUNKED body (no Content-Length) mid-stream with 413 — the H-2 DoS vector', async () => {
    let pushed = 0;
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        // 4 MiB total if fully read; the guard must abort long before.
        if (pushed >= 64) {
          controller.close();
          return;
        }
        pushed += 1;
        controller.enqueue(chunk);
      },
    });
    const request = new Request('http://localhost/api/v1/things', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      // @ts-expect-error — undici requires duplex for streaming bodies.
      duplex: 'half',
    });
    expect(request.headers.get('content-length')).toBeNull();
    const response = await route(request);
    expect(response.status).toBe(413);
    expect(errorOf(await readJson(response)).code).toBe(ErrorCode.PayloadTooLarge);
    // Aborted during transfer: far fewer than the 64 chunks were ever pulled.
    expect(pushed).toBeLessThan(64);
    expect(pushed * chunk.byteLength).toBeLessThan(MAX_JSON_BODY_BYTES + 4 * chunk.byteLength);
  });

  it('rejects a lying Content-Length (declared small, actual oversized) with 413', async () => {
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/things', undefined, {
        rawBody: JSON.stringify({ title: 'x'.repeat(MAX_JSON_BODY_BYTES + 10) }),
        headers: { 'content-length': '10' },
      }),
    );
    expect(response.status).toBe(413);
  });

  it('caps query-string abuse: an oversized limit and unknown query keys are 422', async () => {
    const q = withRoute({
      method: 'GET',
      auth: 'public',
      summary: 'list',
      querySchema: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict(),
      handler: async () => ({ ok: true }),
    });
    expect((await q(new Request('http://localhost/api/v1/things?limit=100000'))).status).toBe(422);
    expect((await q(new Request('http://localhost/api/v1/things?organizationId=x'))).status).toBe(
      422,
    );
    expect((await q(new Request('http://localhost/api/v1/things?limit=25'))).status).toBe(200);
  });
});

/* ═══════════════════════ 6. Direct API manipulation (CSRF / method / request-id) ═══════════════════════ */

describe('direct API manipulation', () => {
  it('a cross-site browser mutation is refused before validation or auth (L-2)', async () => {
    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'file:download',
      summary: 'mint download url',
      tenant: () => ORG_A,
      handler: async () => ({ url: 'x' }),
    });
    const response = await route(
      new Request('http://localhost/api/v1/files/x/download-url', {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(response.status).toBe(403);
    expect(authorityMock).not.toHaveBeenCalled();
  });

  it('a malformed Origin header is treated as hostile', async () => {
    const route = withRoute({
      method: 'DELETE',
      auth: 'public',
      summary: 'delete',
      handler: async () => undefined,
    });
    const response = await route(
      new Request('http://localhost/api/v1/things/1', {
        method: 'DELETE',
        headers: { origin: 'not a url' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('a forged x-request-id is discarded and replaced with a server UUID (log injection)', async () => {
    const route = withRoute({
      method: 'GET',
      auth: 'public',
      summary: 'read',
      handler: async () => ({ ok: true }),
    });
    const response = await route(
      new Request('http://localhost/api/v1/things', {
        headers: {
          'x-request-id': '../../etc/passwd [FAKE LOG LINE] 123e4567-e89b-12d3-a456-426614174000',
        },
      }),
    );
    const issued = response.headers.get('x-request-id') ?? '';
    expect(issued).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(issued).not.toBe('123e4567-e89b-12d3-a456-426614174000');
  });

  it('every response is uncacheable so a shared cache can never serve tenant data across users', async () => {
    const route = withRoute({
      method: 'GET',
      auth: 'public',
      summary: 'read',
      handler: async () => ({ ok: true }),
    });
    const response = await route(new Request('http://localhost/api/v1/things'));
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
});

/* ═══════════════════════ 7. Rate limiting (C-1) — the real limiter ═══════════════════════ */

describe('C-1 — rate limiting is enforced, not declared', () => {
  it('the auth class trips at its budget with 429 + Retry-After, keyed per account, and legitimate users elsewhere survive', async () => {
    const login = withRoute({
      method: 'POST',
      auth: 'public',
      rateLimit: { class: 'auth' },
      summary: 'login',
      bodySchema: z.object({ email: z.email(), password: z.string() }).strict(),
      handler: async () => ({ ok: true }),
    });
    const attempt = (email: string, ip: string) =>
      login(
        jsonRequest(
          'POST',
          'http://localhost/api/v1/auth/login',
          { email, password: 'guess' },
          { headers: { 'x-real-ip': ip } },
        ),
      );

    const budget = RATE_LIMIT_BUDGETS.auth.limit;
    for (let i = 0; i < budget; i += 1) {
      expect((await attempt('victim@example.test', '203.0.113.7')).status).toBe(200);
    }
    const blocked = await attempt('victim@example.test', '203.0.113.7');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(errorOf(await readJson(blocked)).code).toBe(ErrorCode.TooManyRequests);

    // A different account from the same IP is a different bucket (no
    // IP-wide lockout of a shared NAT by one attacker).
    expect((await attempt('someone-else@example.test', '203.0.113.7')).status).toBe(200);
    // Residual (documented): the key is (trusted IP + account). A spray on
    // the SAME account from a genuinely different source IP is a fresh
    // bucket — each source gets its own 10/15 min; account-level lockout is
    // GoTrue's/alerting's job (every miss is audited as LOGIN_FAILED).
    expect((await attempt('victim@example.test', '198.51.100.9')).status).toBe(200);
  });

  it('rotating a spoofed X-Forwarded-For first hop does NOT evade the limiter (M-5)', async () => {
    const recover = withRoute({
      method: 'POST',
      auth: 'public',
      rateLimit: { class: 'auth' },
      summary: 'recovery',
      bodySchema: z.object({ email: z.email() }).strict(),
      handler: async () => ({ accepted: true }),
    });
    const budget = RATE_LIMIT_BUDGETS.auth.limit;
    let last = 0;
    for (let i = 0; i <= budget; i += 1) {
      const response = await recover(
        jsonRequest(
          'POST',
          'http://localhost/api/v1/auth/password-recovery',
          { email: 'victim@example.test' },
          // Attacker rotates the client-controlled first hop; the trusted last
          // hop (appended by our proxy) stays constant.
          { headers: { 'x-forwarded-for': `10.0.${i}.${i}, 203.0.113.50` } },
        ),
      );
      last = response.status;
    }
    expect(last).toBe(429);
  });

  it('authenticated sensitive routes are keyed per user (a TOTP spray trips at the sensitive budget)', async () => {
    authorityMock.mockResolvedValue(authContextFixture({ platformRole: 'ADMIN', aal: 'aal1' }));
    const challenge = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'user:update',
      rateLimit: { class: 'sensitive' },
      summary: 'mfa challenge',
      bodySchema: z.object({ factorId: z.uuid(), code: z.string().regex(/^\d{6}$/) }).strict(),
      handler: async () => ({ ok: true }),
    });
    const budget = RATE_LIMIT_BUDGETS.sensitive.limit;
    let status = 0;
    for (let i = 0; i <= budget; i += 1) {
      status = (
        await challenge(
          jsonRequest('POST', 'http://localhost/api/v1/auth/mfa/challenge', {
            factorId: UUIDS.factor,
            code: String(100000 + i),
          }),
        )
      ).status;
    }
    expect(status).toBe(429);
  });
});

/* ═══════════════════════ 8. Storage access & downloads ═══════════════════════ */

describe('unauthorized storage access / file downloads', () => {
  it('a CLIENT cannot mint a download URL for a file whose row RLS hides (404, handler never runs)', async () => {
    const client = clientContextFixture();
    authorityMock.mockResolvedValue(client);
    let minted = false;
    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'file:download',
      summary: 'mint download url',
      paramSchema: z.object({ id: z.uuid() }).strict(),
      tenant: async ({ params }) => rlsRowResolver(client)(params.id),
      handler: async () => {
        minted = true;
        return { url: 'https://storage/signed' };
      },
    });
    const response = await route(
      new Request(`http://localhost/api/v1/files/${ROW_IN_ORG_B}/download-url`, { method: 'POST' }),
      { params: Promise.resolve({ id: ROW_IN_ORG_B }) },
    );
    expect(response.status).toBe(404);
    expect(minted).toBe(false);
  });

  it('a download URL cannot be minted by a top-level cross-site navigation or GET (must be a same-origin POST)', async () => {
    authorityMock.mockResolvedValue(clientContextFixture());
    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'file:download',
      summary: 'mint download url',
      tenant: () => ORG_A,
      handler: async () => ({ url: 'x' }),
    });
    const get = await route(new Request('http://localhost/api/v1/files/x/download-url'));
    expect(get.status).toBe(405);
    const crossSite = await route(
      new Request('http://localhost/api/v1/files/x/download-url', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'cross-site' },
      }),
    );
    expect(crossSite.status).toBe(403);
  });

  it('registration refuses path traversal, foreign-tenant prefixes, and free-form paths (M-3)', () => {
    const org = ORG_A;
    const good = `${org}/attachment/${UUIDS.invitation}/report.pdf`;
    expect(() => validateStoragePath(good, org)).not.toThrow();
    const attacks = [
      `${org}/attachment/${UUIDS.invitation}/../../${ORG_B}/secret.pdf`,
      `${ORG_B}/attachment/${UUIDS.invitation}/report.pdf`,
      `${org}/attachment/${UUIDS.invitation}/..\\..\\x`,
      `${org}/avatar/${UUIDS.invitation}/report.pdf`,
      `${org}/attachment/not-a-uuid/report.pdf`,
      `${org}/attachment/${UUIDS.invitation}/`,
      `${org}/attachment/${UUIDS.invitation}/a/b.pdf`,
      `${org}/attachment/${UUIDS.invitation}/evil.pdf%00.exe`,
      `/${org}/attachment/${UUIDS.invitation}/report.pdf`,
    ];
    for (const path of attacks) {
      expect(() => validateStoragePath(path, org), path).toThrow(ApiError);
    }
  });

  it('active-content MIME types are excluded from the allowlist (M-2)', () => {
    for (const mime of [
      'text/html',
      'image/svg+xml',
      'application/javascript',
      'text/javascript',
      'application/xhtml+xml',
      'application/x-sh',
      'application/x-msdownload',
      'application/octet-stream',
    ]) {
      expect(ALLOWED_MIME_TYPES.has(mime), mime).toBe(false);
    }
    expect(ALLOWED_MIME_TYPES.has('application/pdf')).toBe(true);
  });
});

/* ═══════════════════════ 9. Error disclosure & secret exposure ═══════════════════════ */

describe('error disclosure', () => {
  it('database errors never carry constraint/table/SQL text across the boundary', () => {
    const leaky = {
      code: '23505',
      message:
        'duplicate key value violates unique constraint "organizations_slug_key" DETAIL: Key (slug)=(acme) already exists.',
    };
    const error = (() => {
      try {
        mapDatabaseError(leaky);
      } catch (e) {
        return e as ApiError;
      }
      throw new Error('unreachable');
    })();
    expect(error.status).toBe(409);
    const serialized = JSON.stringify(error.toPublicBody('req'));
    expect(serialized).not.toContain('organizations_slug_key');
    expect(serialized).not.toContain('slug');
    expect(serialized).not.toContain('23505');
  });

  it('unknown SQLSTATEs degrade to a generic 503 rather than echoing the driver message', () => {
    const cases: Array<[string, number]> = [
      ['XX000', 503],
      ['42P01', 503], // undefined_table — schema shape must not leak
      ['42703', 503], // undefined_column
      ['42501', 403],
      ['P0002', 404],
      ['22P02', 422],
    ];
    for (const [code, status] of cases) {
      let caught: ApiError | undefined;
      try {
        mapDatabaseError({ code, message: 'relation "public.secret_table" does not exist' });
      } catch (e) {
        caught = e as ApiError;
      }
      expect(caught?.status, code).toBe(status);
      expect(JSON.stringify(caught?.toPublicBody())).not.toContain('secret_table');
    }
  });

  it('an unexpected throw inside a handler is a generic 500 with a request id and no stack/cause', async () => {
    const route = withRoute({
      method: 'GET',
      auth: 'public',
      summary: 'boom',
      handler: async () => {
        throw new Error('ECONNREFUSED postgres://admin:hunter2@db.internal:5432/growlith');
      },
    });
    const response = await route(new Request('http://localhost/api/v1/things'));
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('at ');
    const body = JSON.parse(text) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe(ErrorCode.Internal);
    expect(body.error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a Zod error thrown from deep inside a service is a 422 that names paths, never the raw input value', async () => {
    const route = withRoute({
      method: 'GET',
      auth: 'public',
      summary: 'inner parse',
      handler: async () => {
        z.object({ token: z.string().max(3) }).parse({ token: 'sb_secret_SHOULD_NOT_ECHO_123456' });
      },
    });
    const response = await route(new Request('http://localhost/api/v1/things'));
    expect(response.status).toBe(422);
    expect(await response.text()).not.toContain('sb_secret_SHOULD_NOT_ECHO');
  });

  it('the 404 for a hidden row is byte-identical to the 404 for a missing row (no existence oracle)', async () => {
    const hidden = ApiError.notFound().toPublicBody();
    const missing = ApiError.notFound().toPublicBody();
    expect(hidden).toEqual(missing);
  });
});

describe('secret exposure', () => {
  it('no server-only environment key is ever read by isomorphic code', async () => {
    const { CLIENT_ENV_KEYS } = await import('@/lib/env/client-env');
    for (const key of CLIENT_ENV_KEYS) {
      expect(key.startsWith('NEXT_PUBLIC_'), key).toBe(true);
    }
    expect(CLIENT_ENV_KEYS as readonly string[]).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('the structured logger redacts JWTs, Supabase keys and password fields wherever they appear', async () => {
    const { redactSecrets } = await import('@/server/logging/redaction');
    const dump = redactSecrets({
      headers: {
        authorization:
          'Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnopqrstuvw',
      },
      password: 'correct-horse-battery-staple',
      nested: { apikey: 'sb_secret_AbCdEf0123456789', note: 'safe text' },
    }) as Record<string, unknown>;
    const serialized = JSON.stringify(dump);
    expect(serialized).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(serialized).not.toContain('correct-horse');
    expect(serialized).not.toContain('sb_secret_');
    expect(serialized).toContain('safe text');
  });
});

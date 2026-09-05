import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@/lib/types/error-codes';
import { REQUEST_ID_HEADER } from '@/lib/utils/request-id';
import { ApiError } from '@/server/api/errors';
import { MAX_JSON_BODY_BYTES, withRoute, type NextRouteContext } from '@/server/api/with-route';
import { authContextFixture } from '../helpers/auth-fixtures';

/**
 * Contract tests for the single API entry point.
 *
 * The point of `withRoute` is that validation, error mapping and correlation are
 * structural rather than per-handler discipline. These tests therefore assert
 * the *guarantees* a consumer relies on — not the handler's own logic, which is
 * covered by service tests in later phases.
 *
 * Authentication and authorization: AUTHENTICATION (Phase 3) is wired through
 * the required `auth` field; AUTHORIZATION (Phase 4) through the required
 * `capability`. Both authorities are mocked here so the WRAPPER's wiring is
 * what is under test — the guard's own decision table lives in
 * `tests/unit/authorize.spec.ts`-level coverage and the authority's matrix in
 * `tests/contract/auth-context.spec.ts`. What this file does assert about
 * Phase 4, beyond wiring, is the TYPE-LEVEL contract: a protected route
 * without a capability must not compile, and a public route must not be able
 * to grow authorization machinery.
 */

const VALID_UUID = '3f2b8c1a-9d4e-4a7b-8c2f-1e6d5b4a3920';

// The auth authority is mocked so the WRAPPER's wiring is what is under test:
// that it consults the authority exactly when the route declares 'required',
// that the handler receives the resolved principal, and that the authority's
// rejections surface as envelopes. The authority's own matrix is tested
// against faked Supabase clients in auth-context.spec.ts.
const { requireAuthContextMock, authorizeMock } = vi.hoisted(() => ({
  requireAuthContextMock: vi.fn(),
  authorizeMock: vi.fn(),
}));

vi.mock('@/server/auth/context', () => ({
  requireAuthContext: (...args: unknown[]) => requireAuthContextMock(...args),
}));

// The guard is mocked for the same reason the authority is: what is under
// test is that withRoute consults it with the declared capability and the
// resolved tenant/subject, and that its denial wins over the handler.
vi.mock('@/server/auth/authorize', () => ({
  authorize: (...args: unknown[]) => authorizeMock(...args),
}));

let originalLogLevel: string | undefined;

beforeAll(() => {
  originalLogLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'silent';
});

afterAll(() => {
  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLogLevel;
  }
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

describe('successful responses', () => {
  const route = withRoute({
    method: 'GET',
    summary: 'return a greeting',
    auth: 'public',
    handler: async () => ({ greeting: 'hello' }),
  });

  it('wraps the handler result in the success envelope', async () => {
    const response = await route(new Request('http://localhost/api/v1/thing'));
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ greeting: 'hello' });
    expect(body.meta).toMatchObject({ requestId: expect.any(String) });
    expect(typeof (body.meta as { tookMs: number }).tookMs).toBe('number');
  });

  it('returns the request id in both the envelope and the response header', async () => {
    const response = await route(new Request('http://localhost/api/v1/thing'));
    const body = await readJson(response);

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(
      (body.meta as { requestId: string }).requestId,
    );
  });

  it('reuses a well-formed inbound request id for end-to-end correlation', async () => {
    const response = await route(
      new Request('http://localhost/api/v1/thing', {
        headers: { [REQUEST_ID_HEADER]: VALID_UUID },
      }),
    );
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(VALID_UUID);
  });

  it('ignores a malformed inbound request id instead of echoing attacker input', async () => {
    const response = await route(
      new Request('http://localhost/api/v1/thing', {
        headers: { [REQUEST_ID_HEADER]: 'forged-id' },
      }),
    );
    const header = response.headers.get(REQUEST_ID_HEADER) ?? '';
    expect(header).not.toBe('forged-id');
    expect(header).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('forbids caching of tenant-scoped responses', async () => {
    const response = await route(new Request('http://localhost/api/v1/thing'));
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('honours a declared success status', async () => {
    const created = withRoute({
      method: 'POST',
      summary: 'create a thing',
      auth: 'public',
      successStatus: 201,
      handler: async () => ({ id: 'new' }),
    });

    const response = await created(
      jsonRequest('POST', 'http://localhost/api/v1/thing', undefined, { rawBody: '' }),
    );
    expect(response.status).toBe(201);
  });

  it('emits no body for 204', async () => {
    const deleted = withRoute({
      method: 'DELETE',
      summary: 'delete a thing',
      auth: 'public',
      successStatus: 204,
      handler: async () => undefined,
    });

    const response = await deleted(
      new Request('http://localhost/api/v1/thing', { method: 'DELETE' }),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });
});

describe('declaration/export mismatch guard', () => {
  // SCOPE NOTE, verified against a running production build: Next.js rejects a
  // method the route file does not export BEFORE invoking the handler, so a
  // `POST` to a `GET`-only route never reaches `withRoute` and returns an
  // empty-bodied 405 from the framework. This suite calls the handler directly,
  // so what it proves is the narrower — but still real — property that a route
  // declaring one method and exported as another fails loudly instead of
  // silently serving the wrong semantics.
  const route = withRoute({
    method: 'POST',
    summary: 'create a thing',
    auth: 'public',
    handler: async () => ({ ok: true }),
  });

  it('rejects a mismatched method with 405 and an Allow header', async () => {
    const response = await route(new Request('http://localhost/api/v1/thing', { method: 'GET' }));
    const body = await readJson(response);

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect((body.error as { code: string }).code).toBe(ErrorCode.MethodNotAllowed);
  });
});

describe('body validation', () => {
  const schema = z
    .object({ title: z.string().min(1), priority: z.number().int().optional() })
    .strict();
  type Body = z.infer<typeof schema>;

  const route = withRoute<undefined, undefined, Body, { title: string }>({
    method: 'POST',
    auth: 'public',
    summary: 'create a task',
    bodySchema: schema,
    handler: async ({ body }) => ({ title: body.title }),
  });

  it('passes a valid body to the handler', async () => {
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/tasks', { title: 'Audit hreflang' }),
    );
    expect(response.status).toBe(200);
    expect((await readJson(response)).data).toEqual({ title: 'Audit hreflang' });
  });

  it('rejects an invalid body with 422 and field-level details', async () => {
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/tasks', { title: 42 }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(422);
    const error = body.error as { code: string; details: Array<{ path: string }> };
    expect(error.code).toBe(ErrorCode.ValidationFailed);
    expect(error.details[0]?.path).toBe('title');
  });

  it('rejects unknown keys, which is what makes mass assignment impossible', async () => {
    // A client smuggling `organizationId` or `role` must be rejected outright,
    // not silently stripped: silent stripping hides an attack attempt that
    // should appear in the log as a 422.
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/tasks', {
        title: 'ok',
        organizationId: 'other-tenant',
      }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(422);
    expect(JSON.stringify(body)).toContain('organizationId');
  });

  it('rejects malformed JSON with 400', async () => {
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/tasks', undefined, { rawBody: '{not json' }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect((body.error as { code: string }).code).toBe(ErrorCode.MalformedRequest);
  });

  it('rejects an absent body when one is required', async () => {
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/tasks', undefined, { rawBody: '' }),
    );
    expect(response.status).toBe(400);
  });

  it('rejects an oversized body with 413 and points at the upload path', async () => {
    const oversized = 'x'.repeat(MAX_JSON_BODY_BYTES + 1024);
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/tasks', undefined, {
        rawBody: JSON.stringify({ title: oversized }),
      }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(413);
    expect((body.error as { code: string }).code).toBe(ErrorCode.PayloadTooLarge);
    expect((body.error as { message: string }).message).toContain('signed URL');
  });

  it('refuses a body whose declared Content-Length exceeds the limit, without buffering it', async () => {
    // The test above proves the post-read check works, but that check runs *after*
    // `request.text()` has allocated the entire body — so on its own the limit
    // would fail at precisely the moment it exists to help: a 500 MB upload would
    // be fully resident in the heap before being rejected. This asserts the cheap
    // path, using a tiny body that merely *declares* an oversized length.
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/tasks', undefined, {
        rawBody: JSON.stringify({ title: 'small body, large claim' }),
        headers: { 'content-length': String(MAX_JSON_BODY_BYTES + 1) },
      }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(413);
    expect((body.error as { code: string }).code).toBe(ErrorCode.PayloadTooLarge);
    expect((body.error as { message: string }).message).toContain('signed URL');
  });

  it('still accepts a body that honestly declares a length within the limit', async () => {
    // Guards the other direction: the pre-check must not become a reason valid
    // requests fail. A correct Content-Length is the normal case for every real
    // client, so this is the path production traffic actually takes.
    const payload = JSON.stringify({ title: 'Audit hreflang' });
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/tasks', undefined, {
        rawBody: payload,
        headers: { 'content-length': String(Buffer.byteLength(payload, 'utf8')) },
      }),
    );

    expect(response.status).toBe(200);
    expect((await readJson(response)).data).toEqual({ title: 'Audit hreflang' });
  });

  it('rejects a malformed Content-Length with 400 rather than guessing', async () => {
    // A nonsense length could be read as 0, which would let an arbitrarily large
    // body through the pre-check. Refusing it is cheaper than interpreting it, and
    // the post-read check remains as the backstop for a client that omits the
    // header entirely (Transfer-Encoding: chunked).
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/tasks', undefined, {
        rawBody: JSON.stringify({ title: 'whatever' }),
        headers: { 'content-length': 'not-a-number' },
      }),
    );
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect((body.error as { code: string }).code).toBe(ErrorCode.MalformedRequest);
  });

  it('rejects a negative Content-Length with 400', async () => {
    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/tasks', undefined, {
        rawBody: JSON.stringify({ title: 'whatever' }),
        headers: { 'content-length': '-1' },
      }),
    );

    expect(response.status).toBe(400);
  });
});

describe('query and parameter validation', () => {
  it('validates the query string', async () => {
    const schema = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
    const route = withRoute<
      undefined,
      z.infer<typeof schema>,
      undefined,
      { limit: number | undefined }
    >({
      method: 'GET',
      auth: 'public',
      summary: 'list things',
      querySchema: schema,
      handler: async ({ query }) => ({ limit: query.limit }),
    });

    const ok = await route(new Request('http://localhost/api/v1/things?limit=50'));
    expect((await readJson(ok)).data).toEqual({ limit: 50 });

    const bad = await route(new Request('http://localhost/api/v1/things?limit=abc'));
    expect(bad.status).toBe(422);

    const unknown = await route(new Request('http://localhost/api/v1/things?limitx=10000'));
    expect(unknown.status).toBe(422);
  });

  it('awaits and validates Next.js dynamic route params', async () => {
    const schema = z.object({ orgId: z.uuid() }).strict();
    const route = withRoute<z.infer<typeof schema>, undefined, undefined, { orgId: string }>({
      method: 'GET',
      auth: 'public',
      summary: 'read one organization',
      paramSchema: schema,
      handler: async ({ params }) => ({ orgId: params.orgId }),
    });

    const context: NextRouteContext = { params: Promise.resolve({ orgId: VALID_UUID }) };
    const ok = await route(
      new Request(`http://localhost/api/v1/organizations/${VALID_UUID}`),
      context,
    );
    expect((await readJson(ok)).data).toEqual({ orgId: VALID_UUID });

    const badContext: NextRouteContext = { params: Promise.resolve({ orgId: 'not-a-uuid' }) };
    const bad = await route(
      new Request('http://localhost/api/v1/organizations/not-a-uuid'),
      badContext,
    );
    expect(bad.status).toBe(422);
  });
});

describe('error mapping', () => {
  it('maps a thrown ApiError to its status, code and message', async () => {
    const route = withRoute({
      method: 'GET',
      summary: 'fail with a domain error',
      auth: 'public',
      handler: async () => {
        throw ApiError.conflict('That code is already in use.');
      },
    });

    const response = await route(new Request('http://localhost/api/v1/thing'));
    const body = await readJson(response);

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({
      code: ErrorCode.Conflict,
      message: 'That code is already in use.',
      requestId: expect.any(String),
    });
  });

  it('downgrades an unexpected throw to a generic 500 without leaking the cause', async () => {
    const route = withRoute({
      method: 'GET',
      summary: 'fail unexpectedly',
      auth: 'public',
      handler: async () => {
        throw new Error('relation "public.deliverables" does not exist');
      },
    });

    const response = await route(new Request('http://localhost/api/v1/thing'));
    const body = await readJson(response);
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(500);
    expect((body.error as { code: string }).code).toBe(ErrorCode.Internal);
    expect(serialized).not.toContain('public.deliverables');
    expect(serialized).not.toContain('does not exist');
  });

  it('still correlates a 500 to its request id so it can be diagnosed', async () => {
    const route = withRoute({
      method: 'GET',
      summary: 'fail unexpectedly',
      auth: 'public',
      handler: async () => {
        throw new Error('boom');
      },
    });

    const response = await route(
      new Request('http://localhost/api/v1/thing', {
        headers: { [REQUEST_ID_HEADER]: VALID_UUID },
      }),
    );
    const body = await readJson(response);

    expect((body.error as { requestId: string }).requestId).toBe(VALID_UUID);
  });

  it('maps a non-Error throwable without crashing the handler', async () => {
    const route = withRoute({
      method: 'GET',
      summary: 'throw a string',
      auth: 'public',
      handler: async () => {
        // Deliberately pathological: a non-Error throwable must still be mapped
        // to a generic 500 rather than escaping to the caller.
        throw 'a raw string';
      },
    });

    const response = await route(new Request('http://localhost/api/v1/thing'));
    expect(response.status).toBe(500);
  });
});

describe('authentication step (Phase 3)', () => {
  it('resolves the principal for required routes and hands it to the handler', async () => {
    const context = authContextFixture();
    requireAuthContextMock.mockResolvedValueOnce(context);
    authorizeMock.mockResolvedValueOnce({ allowed: true, obligations: [] });

    let received: unknown = 'not called';
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'user:update',
      summary: 'a protected read',
      handler: async (ctx) => {
        received = ctx.auth;
        return { ok: true };
      },
    });

    const response = await route(new Request('http://localhost/api/v1/thing'));
    expect(response.status).toBe(200);
    expect(requireAuthContextMock).toHaveBeenCalledTimes(1);
    expect(received).toBe(context);
  });

  it('surfaces an authority rejection as the error envelope without running the handler', async () => {
    requireAuthContextMock.mockRejectedValueOnce(ApiError.accountSuspended());

    let handlerRan = false;
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'user:update',
      summary: 'a protected read',
      handler: async () => {
        handlerRan = true;
      },
    });

    const response = await route(new Request('http://localhost/api/v1/thing'));
    const body = await readJson(response);

    expect(response.status).toBe(423);
    expect((body.error as { code: string }).code).toBe(ErrorCode.AccountSuspended);
    expect(handlerRan).toBe(false);
  });

  it('never consults the authority for public routes', async () => {
    const route = withRoute({
      method: 'GET',
      auth: 'public',
      summary: 'an open read',
      handler: async () => ({ ok: true }),
    });

    const response = await route(new Request('http://localhost/api/v1/thing'));
    expect(response.status).toBe(200);
    expect(requireAuthContextMock).not.toHaveBeenCalled();
  });

  it('authenticates after validation: an invalid body on a required route rejects before resolving', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture());

    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'user:update',
      summary: 'a protected write',
      bodySchema: z.object({ name: z.string().min(1) }).strict(),
      handler: async () => ({ ok: true }),
    });

    const response = await route(
      jsonRequest('POST', 'http://localhost/api/v1/thing', { name: '' }),
    );

    expect(response.status).toBe(422);
    expect(requireAuthContextMock).not.toHaveBeenCalled();
  });
});

describe('authorization step (Phase 4)', () => {
  const ORG_UUID = '7c9e0a3d-5b1f-4e8a-9d6c-2f4a7b1e8d90';

  it('consults the guard with the declared capability, resolved tenant and subject, and forwards obligations', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture());
    authorizeMock.mockResolvedValueOnce({ allowed: true, obligations: ['OWN_ROW'] });

    let obligations: readonly string[] | undefined;
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'user:update',
      summary: 'a guarded read',
      paramSchema: z.object({ userId: z.uuid() }).strict(),
      tenant: ({ params }) => (params.userId === VALID_UUID ? ORG_UUID : null),
      subjectUser: ({ params }) => params.userId,
      denialSubject: { entityKind: 'profile', id: ({ params }) => params.userId },
      handler: async (ctx) => {
        obligations = ctx.obligations;
        return { ok: true };
      },
    });

    const response = await route(new Request(`http://localhost/api/v1/accounts/${VALID_UUID}`), {
      params: Promise.resolve({ userId: VALID_UUID }),
    });
    expect(response.status).toBe(200);
    const scope = authorizeMock.mock.lastCall?.[2] as Record<string, unknown>;
    expect(scope).toMatchObject({ organizationId: ORG_UUID, subjectUserId: VALID_UUID });
    expect(authorizeMock.mock.lastCall?.[1]).toBe('user:update');
    expect(obligations).toEqual(['OWN_ROW']);
  });

  it('answers 404 (log-only, before the guard) when a row-based tenant resolver finds nothing', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture());

    let handlerRan = false;
    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'invitation:update',
      summary: 'guarded row mutation',
      paramSchema: z.object({ id: z.uuid() }).strict(),
      tenant: () => null,
      handler: async () => {
        handlerRan = true;
      },
    });

    const response = await route(
      new Request('http://localhost/api/v1/invitations/x/revoke', { method: 'POST' }),
      {
        params: Promise.resolve({ id: VALID_UUID }),
      },
    );
    expect(response.status).toBe(404);
    expect(handlerRan).toBe(false);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it('an `undefined` tenant (no tenant named) still consults the guard with organizationId null', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture());
    authorizeMock.mockResolvedValueOnce({ allowed: true, obligations: [] });

    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'invitation:create',
      summary: 'invite without naming a tenant',
      bodySchema: z.object({ organizationId: z.uuid().optional() }).strict(),
      tenant: ({ body }) => body.organizationId,
      handler: async () => ({ ok: true }),
    });

    const response = await route(jsonRequest('POST', 'http://localhost/api/v1/invitations', {}));
    expect(response.status).toBe(200);
    expect(authorizeMock.mock.lastCall?.[2]).toMatchObject({ organizationId: null });
  });

  it('passes minAal through to both the authority and the guard', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture());
    authorizeMock.mockResolvedValueOnce({ allowed: true, obligations: [] });

    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'user:update',
      minAal: 2,
      summary: 'a privileged write',
      handler: async () => ({ ok: true }),
    });

    const response = await route(new Request('http://localhost/api/v1/thing', { method: 'POST' }));
    expect(response.status).toBe(200);
    expect(requireAuthContextMock).toHaveBeenCalledWith({ minAal: 2 });
    expect(authorizeMock.mock.lastCall?.[2]).toMatchObject({ requiredAal: 2 });
  });

  it('surfaces a guard denial as its envelope without running the handler', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture());
    authorizeMock.mockRejectedValueOnce(ApiError.forbidden('not yours'));

    let handlerRan = false;
    const route = withRoute({
      method: 'GET',
      auth: 'required',
      capability: 'user:update',
      summary: 'guarded read',
      handler: async () => {
        handlerRan = true;
      },
    });

    const response = await route(new Request('http://localhost/api/v1/thing'));
    const body = await readJson(response);
    expect(response.status).toBe(403);
    expect((body.error as { code: string }).code).toBe(ErrorCode.Forbidden);
    expect(handlerRan).toBe(false);
  });

  it('refuses to serve (500) a protected route whose capability was removed by a cast', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture());
    // The one thing the type system forbids, asserted through the runtime
    // backstop: a definition smuggled in with a cast must fail CLOSED.
    const smuggled = {
      method: 'GET',
      auth: 'required',
      summary: 'capability-less',
      handler: async () => ({ ok: true }),
    } as never;
    const route = withRoute(smuggled);
    const response = await route(new Request('http://localhost/api/v1/thing'));
    expect(response.status).toBe(500);
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it('is skipped entirely for public routes', async () => {
    const route = withRoute({
      method: 'GET',
      auth: 'public',
      summary: 'an open read',
      handler: async () => ({ ok: true }),
    });
    await route(new Request('http://localhost/api/v1/thing'));
    expect(authorizeMock).not.toHaveBeenCalled();
  });

  it('enforces the capability contract at compile time', () => {
    // @ts-expect-error — Phase 4 contract: 'required' without a capability does not compile.
    withRoute({
      method: 'GET',
      auth: 'required',
      summary: 'unguarded',
      handler: async () => undefined,
    });
    withRoute({
      method: 'GET',
      auth: 'public',
      summary: 'open',
      // @ts-expect-error — a public route cannot carry a capability…
      capability: 'user:update',
      handler: async () => undefined,
    });
    withRoute({
      method: 'GET',
      auth: 'public',
      summary: 'open',
      // @ts-expect-error — …nor any authorization machinery at all.
      tenant: () => null,
      handler: async () => undefined,
    });
    withRoute({
      method: 'GET',
      auth: 'public',
      summary: 'open',
      // @ts-expect-error — a public route cannot demand an assurance floor it never reads.
      minAal: 2,
      handler: async () => undefined,
    });
    expect(true).toBe(true);
  });
});

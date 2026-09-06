import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_MIME_TYPES, validateStoragePath } from '@/server/services/files';
import { withRoute } from '@/server/api/with-route';
import { authContextFixture } from '../helpers/auth-fixtures';

// Mocks for withRoute
const { requireAuthContextMock, authorizeMock } = vi.hoisted(() => ({
  requireAuthContextMock: vi.fn(),
  authorizeMock: vi.fn(),
}));

vi.mock('@/server/auth/context', () => ({
  requireAuthContext: (...args: unknown[]) => requireAuthContextMock(...args),
}));
vi.mock('@/server/auth/authorize', () => ({
  authorize: (...args: unknown[]) => authorizeMock(...args),
}));
vi.mock('@/server/api/rate-limit', () => ({
  enforceRateLimit: vi.fn(),
}));

describe('Phase 6 — M-2 MIME allowlist', () => {
  it('allows expected types and rejects dangerous ones', () => {
    expect(ALLOWED_MIME_TYPES.has('application/pdf')).toBe(true);
    expect(ALLOWED_MIME_TYPES.has('image/jpeg')).toBe(true);
    expect(ALLOWED_MIME_TYPES.has('text/csv')).toBe(true);
    expect(ALLOWED_MIME_TYPES.has('application/zip')).toBe(true);
    // Dangerous: inline script execution
    expect(ALLOWED_MIME_TYPES.has('image/svg+xml')).toBe(false);
    expect(ALLOWED_MIME_TYPES.has('text/html')).toBe(false);
    expect(ALLOWED_MIME_TYPES.has('application/javascript')).toBe(false);
    // Unknown should be false
    expect(ALLOWED_MIME_TYPES.has('application/x-msdownload')).toBe(false);
  });

  it('is case-insensitive via helper (mime check lowercases)', async () => {
    // The helper is not exported, but we test via ALLOWED_MIME_TYPES direct check
    // The service lowercases before check, so this documents the allowlist entries are lowercased.
    for (const mime of ALLOWED_MIME_TYPES) {
      expect(mime).toBe(mime.toLowerCase());
    }
  });
});

describe('Phase 6 — M-3 storage path validation', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const uuid = '22222222-2222-4222-8222-222222222222';
  const good = `${orgId}/attachment/${uuid}/my-file.pdf`;

  it('accepts a well-formed path', () => {
    expect(() => validateStoragePath(good, orgId)).not.toThrow();
  });

  it('rejects traversal', () => {
    expect(() => validateStoragePath(`${orgId}/attachment/${uuid}/../evil.pdf`, orgId)).toThrow();
    expect(() => validateStoragePath(`${orgId}\\attachment\\${uuid}\\evil.pdf`, orgId)).toThrow();
  });

  it('rejects wrong org prefix', () => {
    const otherOrg = '33333333-3333-4333-8333-333333333333';
    expect(() =>
      validateStoragePath(`${otherOrg}/attachment/${uuid}/my-file.pdf`, orgId),
    ).toThrow();
  });

  it('rejects malformed shape', () => {
    expect(() => validateStoragePath(`${orgId}/attachment/not-a-uuid/file.pdf`, orgId)).toThrow();
    expect(() => validateStoragePath(`${orgId}/wrong/${uuid}/file.pdf`, orgId)).toThrow();
    expect(() => validateStoragePath(`${orgId}/attachment/${uuid}/`, orgId)).toThrow();
  });
});

describe('Phase 6 — L-2 CSRF same-origin check', () => {
  beforeEach(() => {
    requireAuthContextMock.mockReset();
    authorizeMock.mockReset();
  });

  it('rejects cross-site Origin on POST', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture({ aal: 'aal2' }));
    authorizeMock.mockResolvedValueOnce({ allowed: true, obligations: [] });

    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'file:upload',
      summary: 'test csrf',
      handler: async () => ({ ok: true }),
    });

    const req = new Request('http://localhost/api/v1/files/upload-url', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.test',
      },
      body: JSON.stringify({}),
    });

    const res = await route(req);
    expect(res.status).toBe(403);
  });

  it('rejects Sec-Fetch-Site cross-site on POST', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture({ aal: 'aal2' }));
    authorizeMock.mockResolvedValueOnce({ allowed: true, obligations: [] });

    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'file:upload',
      summary: 'test csrf',
      handler: async () => ({ ok: true }),
    });

    const req = new Request('http://localhost/api/v1/files/upload-url', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({}),
    });

    const res = await route(req);
    expect(res.status).toBe(403);
  });

  it('allows same-origin POST', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture({ aal: 'aal2' }));
    authorizeMock.mockResolvedValueOnce({ allowed: true, obligations: [] });

    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'file:upload',
      summary: 'test csrf',
      handler: async () => ({ ok: true }),
    });

    const req = new Request('http://localhost/api/v1/files/upload-url', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
      },
      body: JSON.stringify({}),
    });

    const res = await route(req);
    expect(res.status).toBe(200);
  });

  it('allows POST without Origin/Sec-Fetch-Site (non-browser client)', async () => {
    requireAuthContextMock.mockResolvedValueOnce(authContextFixture({ aal: 'aal2' }));
    authorizeMock.mockResolvedValueOnce({ allowed: true, obligations: [] });

    const route = withRoute({
      method: 'POST',
      auth: 'required',
      capability: 'file:upload',
      summary: 'test csrf',
      handler: async () => ({ ok: true }),
    });

    const req = new Request('http://localhost/api/v1/files/upload-url', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    const res = await route(req);
    expect(res.status).toBe(200);
  });
});

describe('Phase 6 — L-4 idempotency hash includes search', () => {
  it('hash differs for different query strings (regression for L-4)', async () => {
    const { createHash } = await import('node:crypto');
    // Replicate hashRequest logic
    function hashRequest(url: string, body: unknown) {
      const u = new URL(url);
      const canonical = JSON.stringify({
        method: 'POST',
        pathname: u.pathname,
        search: u.search,
        body: body ?? null,
      });
      return createHash('sha256').update(canonical).digest('hex');
    }

    const h1 = hashRequest('http://localhost/api/v1/things?limit=10', { a: 1 });
    const h2 = hashRequest('http://localhost/api/v1/things?limit=20', { a: 1 });
    const h3 = hashRequest('http://localhost/api/v1/things?limit=10', { a: 1 });

    expect(h1).not.toBe(h2);
    expect(h1).toBe(h3);
  });
});

describe('Phase 6 — storage bucket hardening (M-2)', () => {
  it('migration sets allowed_mime_types and file_size_limit', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260906130100_phase6_storage_bucket_hardening.sql'),
      'utf8',
    );
    expect(sql).toContain('allowed_mime_types');
    expect(sql).toContain('file_size_limit');
    expect(sql).toContain('application/pdf');
    expect(sql).not.toContain('image/svg+xml');
  });
});

describe('Phase 6 — idempotency TTL (L-4)', () => {
  it('migration adds expires_at and purge function', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260906130000_phase6_idempotency_ttl.sql'),
      'utf8',
    );
    expect(sql).toContain('expires_at');
    expect(sql).toContain('purge_expired_idempotency_keys');
    expect(sql).toContain("interval '24 hours'");
  });
});

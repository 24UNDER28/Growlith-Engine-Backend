import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { EnvironmentError } from '@/lib/errors/environment';
import { ErrorCode } from '@/lib/types/error-codes';
import { ApiError, isApiError, toApiError } from '@/server/api/errors';

/**
 * These tests are primarily an information-disclosure suite.
 *
 * The functional mapping matters, but the load-bearing assertions are the ones
 * proving that a server-side cause never reaches the response body: a leaked
 * PostgreSQL error or file path is how an attacker learns the shape of a schema
 * they cannot read.
 */

const REQUEST_ID = '11111111-2222-3333-4444-555555555555';

describe('ApiError factories', () => {
  it('maps each factory to its documented status and code', () => {
    const cases = [
      [ApiError.badRequest('bad'), 400, ErrorCode.MalformedRequest],
      [ApiError.validation([]), 422, ErrorCode.ValidationFailed],
      [ApiError.unauthenticated(), 401, ErrorCode.Unauthenticated],
      [ApiError.forbidden(), 403, ErrorCode.Forbidden],
      [ApiError.notFound(), 404, ErrorCode.NotFound],
      [ApiError.methodNotAllowed(['POST']), 405, ErrorCode.MethodNotAllowed],
      [ApiError.conflict('dup'), 409, ErrorCode.Conflict],
      [ApiError.payloadTooLarge(), 413, ErrorCode.PayloadTooLarge],
      [ApiError.tooManyRequests(), 429, ErrorCode.TooManyRequests],
      [ApiError.accountSuspended(), 423, ErrorCode.AccountSuspended],
      [ApiError.envMisconfigured(), 500, ErrorCode.EnvMisconfigured],
      [ApiError.serviceUnavailable(), 503, ErrorCode.ServiceUnavailable],
      [ApiError.internal(), 500, ErrorCode.Internal],
    ] as const;

    for (const [error, status, code] of cases) {
      expect(error.status).toBe(status);
      expect(error.code).toBe(code);
      expect(isApiError(error)).toBe(true);
    }
  });

  it('sets an Allow header on 405 so the client can self-correct', () => {
    const error = ApiError.methodNotAllowed(['POST', 'PUT']);
    expect(error.headers.Allow).toBe('POST, PUT');
  });

  it('reports "does not exist" and "hidden by RLS" identically (ADR-0019)', () => {
    // Both situations must produce the same status, code and message. A distinct
    // response for an RLS-hidden row would confirm that the row exists in
    // another tenant and enable cross-tenant enumeration by UUID.
    const doesNotExist = ApiError.notFound();
    const hiddenByRls = ApiError.notFound();

    expect(doesNotExist.status).toBe(hiddenByRls.status);
    expect(doesNotExist.code).toBe(hiddenByRls.code);
    expect(doesNotExist.message).toBe('The requested resource was not found.');
    expect(doesNotExist.message).not.toMatch(/permission|forbidden|tenant|organization|rls/i);
  });
});

describe('public body construction', () => {
  it('includes the request id so a user report correlates to a log line', () => {
    const body = ApiError.internal().toPublicBody(REQUEST_ID);
    expect(body.requestId).toBe(REQUEST_ID);
  });

  it('omits optional fields rather than emitting them as null', () => {
    const body = ApiError.notFound().toPublicBody();
    expect(Object.keys(body).sort()).toEqual(['code', 'message']);
  });

  it('includes validation details when present', () => {
    const body = ApiError.validation([
      { path: 'title', message: 'required', code: 'too_small' },
    ]).toPublicBody();
    expect(body.details).toEqual([{ path: 'title', message: 'required', code: 'too_small' }]);
  });

  it('omits an empty details array so clients see one shape, not two', () => {
    expect('details' in ApiError.validation([]).toPublicBody()).toBe(false);
  });
});

describe('information disclosure', () => {
  const sensitive = [
    'relation "public.tasks" does not exist',
    'duplicate key value violates unique constraint "organizations_slug_key"',
    'new row violates row-level security policy for table "deliverables"',
    '/var/app/src/server/supabase/client-service.ts',
    'ECONNREFUSED db.internal:5432',
  ];

  it.each(sensitive)('never returns a server-side cause: %s', (message) => {
    const body = ApiError.internal(new Error(message)).toPublicBody(REQUEST_ID);
    const serialized = JSON.stringify(body);

    expect(serialized).not.toContain(message);
    expect(body.message).toBe('An unexpected error occurred.');
    expect(body.code).toBe(ErrorCode.Internal);
  });

  it('keeps the cause available for logging but out of the serialized body', () => {
    const cause = new Error('secret internal detail');
    const error = ApiError.internal(cause);

    expect(error.cause).toBe(cause);
    expect(JSON.stringify(error.toPublicBody())).not.toContain('secret internal detail');
    // `cause` is not an own enumerable property of the body, so it cannot be
    // leaked by a future spread of the envelope.
    expect(JSON.stringify(error.toPublicBody())).not.toContain('cause');
  });

  it('does not name the missing variable when the environment is misconfigured', () => {
    const body = ApiError.envMisconfigured(
      new EnvironmentError('  - SUPABASE_SERVICE_ROLE_KEY: required'),
    ).toPublicBody();

    expect(body.message).toBe('The server is misconfigured.');
    expect(JSON.stringify(body)).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});

describe('toApiError', () => {
  it('passes an ApiError through untouched', () => {
    const error = ApiError.conflict('already exists');
    expect(toApiError(error)).toBe(error);
  });

  it('maps an EnvironmentError to a 500 with the env code', () => {
    const result = toApiError(new EnvironmentError('  - APP_ENV: invalid'));
    expect(result.status).toBe(500);
    expect(result.code).toBe(ErrorCode.EnvMisconfigured);
  });

  it('maps a ZodError to a 422 carrying field-level details', () => {
    const parsed = z.object({ title: z.string() }).safeParse({ title: 42 });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    const result = toApiError(parsed.error);
    expect(result.status).toBe(422);
    expect(result.code).toBe(ErrorCode.ValidationFailed);
    expect(result.details?.[0]?.path).toBe('title');
  });

  it('downgrades an unknown throwable to a generic 500 and preserves it as cause', () => {
    const weird = { message: 'not an Error', code: 'WEIRD' };
    const result = toApiError(weird);

    expect(result.status).toBe(500);
    expect(result.code).toBe(ErrorCode.Internal);
    expect(result.cause).toBe(weird);
    expect(result.message).not.toContain('WEIRD');
  });

  it('handles null and undefined without throwing', () => {
    expect(toApiError(null).status).toBe(500);
    expect(toApiError(undefined).status).toBe(500);
  });
});

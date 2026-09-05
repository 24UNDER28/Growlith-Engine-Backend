import 'server-only';

import { z } from 'zod';

import type { AuthContext } from '@/lib/auth/context';
import type { HttpMethod } from '@/lib/types/http';
import type { SuccessStatusCode } from '@/lib/types/api-envelope';
import { toValidationIssues } from '@/lib/validation/format';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/utils/request-id';
import { ApiError, toApiError } from '@/server/api/errors';
import { requireAuthContext } from '@/server/auth/context';
import { createLogger, type Logger } from '@/server/logging/logger';

/**
 * `withRoute` — the single entry point for every `/api/v1/**` handler.
 *
 * WHY A WRAPPER (ADR-0013)
 * Authorization, validation and error handling are exactly the things an
 * individual handler forgets under deadline pressure, and forgetting one is an
 * incident rather than a bug. Making them structural means a handler author
 * cannot skip a step: the steps are not in their code.
 *
 * Enforced order, identical for every route:
 *   request id → method check → param/query/body validation → AUTHENTICATION →
 *   handler → envelope → response headers → structured log
 *
 * AUTHENTICATION (Phase 3)
 * Every route declares `auth: 'public' | 'required'` — a REQUIRED field, so a
 * route that forgets its posture does not compile (the same structural
 * enforcement `method` and `summary` already get, and the exact seam Phase 4
 * uses for `capability`). `'required'` resolves `requireAuthContext()` after
 * validation and before the handler: network-verified identity, database-
 * resolved status and roles, the §8 status gate, and a memoised context the
 * handler receives as a non-optional `auth` field. `'public'` skips resolution —
 * the initial public set is the health probe and the auth endpoints
 * (login/logout/session/password-recovery); everything under `/api/v1/**` else
 * is denied by construction.
 *
 * WHAT IS DELIBERATELY ABSENT (Phase 4)
 * No capability check yet — fine-grained authorization is Phase 4 by
 * instruction, and the `capability` field will slot in beside `auth` with the
 * same required-field enforcement.
 */

/**
 * Hard cap on a JSON request body, in bytes.
 *
 * File uploads never pass through here: they use signed URLs directly to
 * Supabase Storage (ADR-0016), so this cap applies only to JSON mutations and
 * can stay small.
 */
export const MAX_JSON_BODY_BYTES = 1_048_576; // 1 MiB

/** The authentication posture every route must declare. */
export type RouteAuth = 'public' | 'required';

export interface RouteHandlerContext<TParams, TQuery, TBody, TAuth extends RouteAuth = RouteAuth> {
  readonly request: Request;
  readonly params: TParams;
  readonly query: TQuery;
  readonly body: TBody;
  readonly requestId: string;
  readonly log: Logger;
  /**
   * The resolved principal. Non-optional when the route declares
   * `auth: 'required'`; `undefined` for public routes. Typing it conditionally
   * (rather than `AuthContext | undefined` everywhere) means a protected
   * handler simply reads `context.auth.userId` — no guard, no cast.
   */
  readonly auth: TAuth extends 'required' ? AuthContext : undefined;
}

export interface RouteDefinition<
  TParams,
  TQuery,
  TBody,
  TData,
  TAuth extends RouteAuth = RouteAuth,
> {
  /**
   * The one HTTP method this handler serves.
   *
   * IMPORTANT — this does NOT make the API responsible for every 405.
   * Next.js rejects a method that the route file does not export *before* the
   * handler is invoked, returning an empty-bodied 405 with no `x-request-id` and
   * no `Allow` header. Verified against a running production build: a `POST` to a
   * route exporting only `GET` never reaches this code and never appears in the
   * server log.
   *
   * What this check therefore catches is a **declaration/export mismatch** —
   * `export { GET }` built from `withRoute({ method: 'POST' })`, a copy-paste
   * bug that would otherwise serve the wrong semantics on the wrong verb. It is
   * defence against our own error, not the primary 405 mechanism.
   *
   * Clients must tolerate a body-less 405 from this API. See
   * docs/architecture/README.md §H (open item carried into Phase 5).
   */
  readonly method: HttpMethod;
  /**
   * One sentence describing the operation. Required, not decorative: it is
   * logged with every request, which is what makes an access log readable
   * without cross-referencing source.
   */
  readonly summary: string;
  /**
   * Authentication posture — required, so the default for a new route is a
   * COMPILE ERROR, not silent public access (design §5, §15).
   */
  readonly auth: TAuth;
  readonly paramSchema?: z.ZodType<TParams>;
  readonly querySchema?: z.ZodType<TQuery>;
  readonly bodySchema?: z.ZodType<TBody>;
  readonly successStatus?: SuccessStatusCode;
  readonly handler: (
    context: RouteHandlerContext<TParams, TQuery, TBody, TAuth>,
  ) => Promise<TData> | TData;
}

/** The second argument Next.js passes to an App Router route handler. */
export interface NextRouteContext {
  readonly params: Promise<Record<string, string>>;
}

export type RouteHandler = (request: Request, context?: NextRouteContext) => Promise<Response>;

export function withRoute<
  TParams = undefined,
  TQuery = undefined,
  TBody = undefined,
  TData = void,
  TAuth extends RouteAuth = RouteAuth,
>(definition: RouteDefinition<TParams, TQuery, TBody, TData, TAuth>): RouteHandler {
  return async (request, context) => {
    const requestId = resolveRequestId(request.headers);
    const pathname = safePathname(request.url);
    const log = createLogger({ requestId, route: `${definition.method} ${pathname}` });
    const startedAt = performance.now();

    try {
      // See `RouteDefinition.method`: this guards against a declaration/export
      // mismatch, not against unsupported verbs in general — Next.js intercepts
      // those first, and the handler is never invoked.
      if (request.method !== definition.method) {
        throw ApiError.methodNotAllowed([definition.method]);
      }

      // The three assertions below are sound by construction: `read*` returns
      // `undefined` only when the matching schema is absent, and when no schema
      // is declared the corresponding generic parameter defaults to `undefined`.
      // Corollary for authors: if you pass an explicit type argument for
      // TParams/TQuery/TBody you MUST also supply the matching schema.
      const params = (await readParams(definition.paramSchema, context)) as TParams;
      const query = readQuery(definition.querySchema, request) as TQuery;
      const body = (await readBody(definition.bodySchema, request)) as TBody;

      // The authentication step (Phase 3). After validation (cheap, local, no
      // side effects) and before the handler, so a rejected request costs one
      // validation pass and no privileged work. `requireAuthContext()` performs
      // network verification, the database round trip, the §8 status gate and
      // the presence touch; its rejections surface as normal `ApiError`
      // envelopes through the shared catch below.
      const auth = (
        definition.auth === 'required' ? await requireAuthContext() : undefined
      ) as TAuth extends 'required' ? AuthContext : undefined;

      const data = await definition.handler({
        request,
        params,
        query,
        body,
        requestId,
        log,
        auth,
      });

      const status = definition.successStatus ?? 200;
      const tookMs = elapsed(startedAt);
      log.info(`request completed — ${definition.summary}`, { status, tookMs });

      return buildResponse(status, { data: data ?? null, meta: { requestId, tookMs } }, requestId);
    } catch (error) {
      const apiError = toApiError(error);
      const tookMs = elapsed(startedAt);

      // 5xx means we broke, so the cause is logged with its stack. 4xx means the
      // client sent something we rejected, which is normal traffic: logged at
      // info level without a stack, so real failures stay visible in the noise.
      if (apiError.status >= 500) {
        log.error(`request failed — ${definition.summary}`, {
          status: apiError.status,
          code: apiError.code,
          tookMs,
          cause: apiError.cause instanceof Error ? apiError.cause : undefined,
          errorName: apiError.cause instanceof Error ? apiError.cause.name : typeof apiError.cause,
        });
      } else {
        log.info(`request rejected — ${definition.summary}`, {
          status: apiError.status,
          code: apiError.code,
          tookMs,
        });
      }

      // The public body must be wrapped in `error`, per `ApiErrorEnvelope`.
      // Emitting the fields at the top level would produce a second, undocumented
      // response shape that clients cannot discriminate from a success envelope.
      return buildResponse(
        apiError.status,
        { error: apiError.toPublicBody(requestId) },
        requestId,
        { headers: apiError.headers },
      );
    }
  };
}

/* ───────────────────────────── input handling ───────────────────────────── */

/**
 * Each reader takes the schema rather than the whole definition.
 *
 * Passing `RouteDefinition<…>` would require the helper's own generics to be
 * assignable to the caller's, which TypeScript cannot prove in the presence of
 * optional properties — and widening to `unknown` would silently discard the
 * parsed type. Taking just the schema keeps the inferred type exact.
 */

async function readParams<TParams>(
  schema: z.ZodType<TParams> | undefined,
  context: NextRouteContext | undefined,
): Promise<TParams | undefined> {
  if (schema === undefined) {
    return undefined;
  }

  // Next.js 15+ delivers dynamic route params asynchronously.
  const raw: Record<string, string> = context?.params ? await context.params : {};
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw ApiError.validation(
      toValidationIssues(result.error.issues),
      'The route parameters are invalid.',
    );
  }

  return result.data;
}

function readQuery<TQuery>(
  schema: z.ZodType<TQuery> | undefined,
  request: Request,
): TQuery | undefined {
  if (schema === undefined) {
    return undefined;
  }

  // LIMITATION (documented, not hidden): `Object.fromEntries` collapses a
  // repeated parameter to its last value, so `?status=a&status=b` cannot express
  // an array. Multi-value filters must be modelled as a comma-separated string
  // in their own schema, or parsed from `searchParams` explicitly in Phase 5.
  const raw = Object.fromEntries(new URL(request.url).searchParams);
  const result = schema.safeParse(raw);

  if (!result.success) {
    throw ApiError.validation(
      toValidationIssues(result.error.issues),
      'The query string is invalid.',
    );
  }

  return result.data;
}

/** Single source of truth for the 413 detail, so both checks cannot drift. */
const BODY_TOO_LARGE_DETAIL = `The request body must not exceed ${MAX_JSON_BODY_BYTES} bytes. Large files are uploaded directly to storage via a signed URL.`;

/**
 * Reject an oversized body from its declared `Content-Length` **before** the
 * body is buffered into memory.
 *
 * The post-read check in `readBody` is authoritative but not protective: by the
 * time `Buffer.byteLength(text)` runs, the entire body is already resident in
 * the process heap. A 500 MB upload would be fully allocated and only then
 * rejected, so the limit would fail at precisely the moment it exists to help —
 * a memory-exhaustion vector rather than a guard against one.
 *
 * `Content-Length` is a client *declaration*, not a guarantee. It is absent for
 * `Transfer-Encoding: chunked`, and a hostile client may understate it. That is
 * why both checks are kept: this one is the cheap fast path that makes ordinary
 * oversized uploads cost nothing, and the post-read check is what actually binds
 * memory for a body that arrives without an honest length.
 *
 * A hard allocation ceiling for chunked bodies is an infrastructure concern, not
 * an application one — Node's header limits do not cover bodies. Tracked for
 * Phase 6 (security hardening) together with rate limiting.
 */
function assertDeclaredBodySizeWithinLimit(request: Request): void {
  const declared = request.headers.get('content-length');
  if (declared === null || declared === '') {
    return; // Unknown length: the post-read check is the only option.
  }

  const bytes = Number(declared);
  if (!Number.isInteger(bytes) || bytes < 0) {
    // A malformed length is a client error. Guessing at it would let a
    // nonsensical value through to allocation.
    throw ApiError.badRequest('The Content-Length header is not a valid byte count.');
  }
  if (bytes > MAX_JSON_BODY_BYTES) {
    throw ApiError.payloadTooLarge(BODY_TOO_LARGE_DETAIL);
  }
}

async function readBody<TBody>(
  schema: z.ZodType<TBody> | undefined,
  request: Request,
): Promise<TBody | undefined> {
  if (schema === undefined) {
    return undefined;
  }

  assertDeclaredBodySizeWithinLimit(request);

  const text = await request.text();

  if (text.length === 0) {
    throw ApiError.badRequest('A JSON request body is required.');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BODY_BYTES) {
    throw ApiError.payloadTooLarge(BODY_TOO_LARGE_DETAIL);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw ApiError.badRequest('The request body is not valid JSON.', error);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw ApiError.validation(toValidationIssues(result.error.issues));
  }

  return result.data;
}

/* ───────────────────────────── output handling ──────────────────────────── */

interface ResponseOptions {
  readonly headers?: Readonly<Record<string, string>>;
}

function buildResponse(
  status: number,
  payload: unknown,
  requestId: string,
  options: ResponseOptions = {},
): Response {
  const headers: Record<string, string> = {
    [REQUEST_ID_HEADER]: requestId,
    // Tenant-scoped data must never be retained by a shared or browser cache.
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
    ...options.headers,
  };

  // A 204 must not carry a body; `Response.json` would reject it.
  if (status === 204) {
    return new Response(null, { status, headers });
  }

  return Response.json(payload, { status, headers });
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/**
 * Extract the pathname for logging.
 *
 * `new URL()` throws on a malformed absolute URL. That must not turn a logging
 * concern into a 500, so the raw value is used as a fallback.
 */
function safePathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

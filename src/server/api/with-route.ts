import 'server-only';

import { z } from 'zod';

import type { AuthContext } from '@/lib/auth/context';
import {
  PERMISSION_MATRIX,
  type Capability,
  type PermissionQualifier,
} from '@/lib/domain/permissions';
import type { EntityKind } from '@/lib/domain/entities';
import type { PageResult } from '@/lib/types/pagination';
import { authorize } from '@/server/auth/authorize';
import type { HttpMethod } from '@/lib/types/http';
import type { SuccessStatusCode } from '@/lib/types/api-envelope';
import { toValidationIssues } from '@/lib/validation/format';
import { REQUEST_ID_HEADER, resolveRequestId } from '@/lib/utils/request-id';
import { ApiError, toApiError } from '@/server/api/errors';
import { replayIdempotent, storeIdempotent } from '@/server/api/idempotency';
import { requireAuthContext } from '@/server/auth/context';
import { createLogger, type Logger } from '@/server/logging/logger';
import { enforceRateLimit } from '@/server/api/rate-limit';

/**
 * Rate-limit class. Enforced by `enforceRateLimit` (C-1): absent means GET ⇒
 * `read`, everything else ⇒ `mutation`; budgets live in `rate-limit.ts`.
 */
export const RATE_CLASSES = ['auth', 'sensitive', 'mutation', 'read', 'export'] as const;
export type RateClass = (typeof RATE_CLASSES)[number];

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
 * AUTHORIZATION (Phase 4)
 * Beside `auth`, every protected route now also declares `capability` — a
 * `{resource}:{action}` string from the single source-of-truth matrix
 * (`src/lib/domain/permissions.ts`). The declared type makes it a COMPILE
 * ERROR for a protected route to omit one, the mirror of the `auth` posture
 * rule. Order inside the wrapper, after authentication:
 *
 *   tenant resolution → capability check → obligations → handler.
 *
 * `tenant` maps a request to the organization it targets; an actor who cannot
 * reach that tenant gets a 404 (the 404-before-403 rule, ADR-0019) — a route
 * never learns "does this belong to someone else?". Capability denials answer
 * 403 and write the PERMISSION_DENIED audit row before the response goes out
 * (§11). What the guard cannot see without loading the row — CLIENT_VISIBLE,
 * object-side PROJECT_MEMBER, STATE_MACHINE, RPC_ONLY, COLUMN_RESTRICTED —
 * arrives in the handler context as OBLIGATIONS the service layer must honour
 * (§I.2); RLS enforces the rows regardless of whether anyone forgot.
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

/** Everything a capability/tenant resolver may consult at guard time. */
export interface RouteAuthorizationContext<TParams, TQuery, TBody> {
  readonly params: TParams;
  readonly query: TQuery;
  readonly body: TBody;
  readonly auth: AuthContext;
}

export type RouteTenantResolver<TParams, TQuery, TBody> = (
  context: RouteAuthorizationContext<TParams, TQuery, TBody>,
) => string | null | undefined | Promise<string | null | undefined>;

/** Fields that qualify HOW the capability is checked. Legitimate on protected
 * routes only; the public branch of the definition type pins each to
 * `undefined` so a public route cannot grow authorization machinery. */
export interface RouteAuthorizationFields<TParams, TQuery, TBody> {
  /** Resolve the tenant the operation targets — from a request field when
   * the request names it, from the ROW (via the caller's own RLS) when only
   * the row knows (§I.3 step 4: "Routes that address a row by id receive the
   * tenant from the row, not from the caller"). A null result is a 404: an
   * invisible row and a missing row are one answer; returning `undefined`
   * instead asserts "the request names no tenant" and lets the matrix cell
   * answer — a TENANT-scoped cell denies, a GLOBAL/SELF cell proceeds (the
   * platform branch of invitation creation is the shape this exists for).
   * Required whenever the
   * capability is TENANT-scoped (enforced by the contract suite against the
   * matrix; enforced at runtime by the guard refusing to guess). */
  readonly tenant?: RouteTenantResolver<TParams, TQuery, TBody>;
  /** The project a `[P]`-qualified capability consults for the one
   * actor-side rule the matrix can evaluate (§5 rule 3). */
  readonly project?: RouteTenantResolver<TParams, TQuery, TBody>;
  /** For SELF-scoped capabilities whose subject is a path-named person. */
  readonly subjectUser?: RouteTenantResolver<TParams, TQuery, TBody>;
  /** Authenticator assurance floor (§6c: /admin surfaces require aal2). */
  readonly minAal?: 1 | 2;
  /** The audit subject for a capability denial, when the route can name
   * it without loading the row. Omitting it degrades the audit to
   * "actor was denied", never to a fabricated row reference. */
  readonly denialSubject?: {
    readonly entityKind?: EntityKind;
    readonly id?: (context: RouteAuthorizationContext<TParams, TQuery, TBody>) => string | null;
  };
}

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
  /**
   * The obligations the guard recorded but could not itself evaluate
   * (§I.2): CLIENT_VISIBLE means "scope this read with the client gate",
   * PROJECT_MEMBER means "the object rule belongs to you/the trigger",
   * STATE_MACHINE means "run the transition past the catalogue", RPC_ONLY
   * means "the sanctioned write path is the definer RPC". An empty array
   * means the guard decided everything it could.
   */
  readonly obligations: readonly PermissionQualifier[];
}

export interface RouteDefinitionCore<
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
  readonly paramSchema?: z.ZodType<TParams>;
  readonly querySchema?: z.ZodType<TQuery>;
  readonly bodySchema?: z.ZodType<TBody>;
  readonly successStatus?: SuccessStatusCode;
  /**
   * Rate class enforced after authentication and before authorization
   * (C-1): 429 + `Retry-After` once the class budget is spent, keyed by
   * user id (or trusted IP, plus the account for the `auth` class). Also
   * logged on every access line.
   */
  readonly rateLimit?: { readonly class: RateClass };
  /** Serialize the handler result as a list envelope `{ data, pagination, meta }`. */
  readonly pageResult?: boolean;
  /** `Location` header on 201 — the created resource's canonical path. */
  readonly location?: (data: TData) => string;
  /** ADR-0028: require `Idempotency-Key` and replay stored successes. */
  readonly idempotency?: boolean;
  readonly handler: (
    context: RouteHandlerContext<TParams, TQuery, TBody, TAuth>,
  ) => Promise<TData> | TData;
}

/** The second argument Next.js passes to an App Router route handler. */
export interface NextRouteContext {
  readonly params: Promise<Record<string, string>>;
}

/**
 * A route's definition is its core shape INTERSECTED with the authorization
 * declaration for its posture. The conditional type is the enforcement:
 * `auth: 'required'` without `capability` does not type-check, and
 * `auth: 'public'` with one does not either.
 */
export type RouteDefinition<
  TParams = undefined,
  TQuery = undefined,
  TBody = undefined,
  TData = void,
  TAuth extends RouteAuth = RouteAuth,
> = RouteDefinitionCore<TParams, TQuery, TBody, TData, TAuth> & {
  readonly auth: TAuth;
} & (TAuth extends 'required'
    ? RouteAuthorizationFields<TParams, TQuery, TBody> & { readonly capability: Capability }
    : { readonly capability?: undefined } & Partial<
        Record<'tenant' | 'project' | 'subjectUser' | 'minAal' | 'denialSubject', undefined>
      >);

/** The implementation-facing shape: every branch, all optional, one type. */
type AnyRouteDefinition = RouteDefinitionCore<
  Record<string, unknown> | undefined,
  Record<string, unknown> | undefined,
  unknown,
  unknown
> & {
  readonly auth: RouteAuth;
  readonly capability?: Capability;
  readonly rateLimit?: { readonly class: RateClass };
  readonly pageResult?: boolean;
  readonly location?: (data: unknown) => string;
  readonly idempotency?: boolean;
} & RouteAuthorizationFields<unknown, unknown, unknown>;

/** Convenience resolvers: the two shapes nearly every route uses. */
export function tenantFromField(
  source: 'params' | 'query',
  key: string,
): <TParams, TQuery, TBody>(
  context: RouteAuthorizationContext<TParams, TQuery, TBody>,
) => string | null {
  return (context) => {
    const container = (source === 'params' ? context.params : context.query) as
      Record<string, unknown> | undefined;
    const value = container?.[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
}

export type RouteHandler = (request: Request, context?: NextRouteContext) => Promise<Response>;

/**
 * One generic signature; the CONDITIONAL in `RouteDefinition` does the
 * enforcement — `TAuth` is inferred from the literal `auth` field, so a
 * route declaring `'required'` gets `capability: Capability` REQUIRED at the
 * type level and a route declaring `'public'` cannot supply one at all.
 * Inside, the authorization fields are read through a widened view of the
 * definition (`authz`): TypeScript cannot resolve a conditional on a generic
 * at the declaration site, and the cast is sound because the only shapes the
 * overloads' conditional admits are the ones the view contains.
 */
export function withRoute<
  TParams = undefined,
  TQuery = undefined,
  TBody = undefined,
  TData = void,
  TAuth extends RouteAuth = RouteAuth,
>(definition: RouteDefinition<TParams, TQuery, TBody, TData, TAuth>): RouteHandler {
  return async (request, context) => {
    const authz = definition as unknown as AnyRouteDefinition;
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

      // CSRF hardening (L-2): mutating methods must be same-origin when
      // Origin or Sec-Fetch-Site is present. Cross-site form POSTs cannot set
      // application/json (blocked by preflight), but this provides defense-in-depth
      // for any future GET with side effects and for non-browser clients that
      // might inadvertently be tricked.
      assertSameOriginForMutations(request);

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
        definition.auth === 'required'
          ? await requireAuthContext(authz.minAal === 2 ? { minAal: 2 } : {})
          : undefined
      ) as TAuth extends 'required' ? AuthContext : undefined;

      // ── Rate limiting (C-1) ────────────────────────────────────────────
      // Enforced after authentication so the key can be userId when available,
      // falling back to trusted IP for anonymous traffic (M-5). Body is
      // included so auth-class limits can additionally bind to account email.
      {
        const rateClass =
          authz.rateLimit?.class ?? (definition.method === 'GET' ? 'read' : 'mutation');
        enforceRateLimit({
          request,
          rateClass,
          route: `${definition.method} ${pathname}`,
          actorUserId: (auth as AuthContext | undefined)?.userId ?? null,
          body,
          requestId,
        });
      }

      // ── MFA step-up enforcement (C-2) ──────────────────────────────────
      // Invert default: INTERNAL-only capabilities and sensitive internal
      // mutations require aal2 unless explicitly exempted. This makes TOTP
      // mandatory for privileged operations even when a route forgets to
      // declare minAal. Exemptions are limited to the step-up flows themselves
      // and self-service endpoints.
      if (definition.auth === 'required' && auth !== undefined) {
        const effectiveAalRequired = effectiveMinAalForRequest({
          declared: authz.minAal,
          capability: authz.capability as Capability | undefined,
          method: definition.method,
          pathname,
          auth: auth as AuthContext,
        });
        if (effectiveAalRequired === 2 && (auth as AuthContext).aal !== 'aal2') {
          throw ApiError.mfaRequired();
        }
      }

      // ── The authorization steps (Phase 4) ──────────────────────────────
      let obligations: readonly PermissionQualifier[] = [];
      if (definition.auth === 'required') {
        if (authz.capability === undefined) {
          // Type-level impossibility with a runtime backstop: a route built
          // through `as` casts must not ship open. 500 names it as the
          // deployment bug it is, rather than answering the caller at all.
          throw ApiError.internal(
            new Error(`protected route ${definition.method} ${pathname} declares no capability`),
          );
        }
        const guardContext = { params, query, body, auth: auth as AuthContext };
        let organizationId: string | null = null;
        if (authz.tenant !== undefined) {
          const resolvedTenant = await authz.tenant(guardContext);
          if (resolvedTenant === null) {
            // The resolver LOOKED (at a row, through the caller's RLS) and
            // found nothing — "not visible to you", and the 404-before-403
            // rule allows no sharper answer (ADR-0019). Log-only: a probe
            // must not mint audit rows about other people's data.
            log.info('tenant unresolvable — answered 404', {
              capability: authz.capability,
            });
            throw ApiError.notFound();
          }
          organizationId = resolvedTenant ?? null;
        }
        const projectId = authz.project ? await authz.project(guardContext) : null;
        const subjectUserId = authz.subjectUser ? await authz.subjectUser(guardContext) : null;
        const denialEntityId = authz.denialSubject?.id
          ? await authz.denialSubject.id(guardContext)
          : null;

        const guard = await authorize(
          auth as AuthContext,
          authz.capability,
          {
            organizationId,
            projectId,
            subjectUserId,
            ...(authz.minAal === undefined ? {} : { requiredAal: authz.minAal }),
          },
          log,
          requestId,
          request,
          authz.denialSubject === undefined
            ? undefined
            : {
                ...(authz.denialSubject.entityKind === undefined
                  ? {}
                  : { entityKind: authz.denialSubject.entityKind }),
                entityId: denialEntityId,
              },
        );
        obligations = guard.obligations;
      }

      // Idempotency (ADR-0028) runs AFTER the capability check so a denied
      // request cannot mint or consume a key, and BEFORE the handler so a
      // replay never re-executes the mutation.
      let idempotencyKey: string | null = null;
      if (authz.idempotency === true) {
        if (definition.auth !== 'required' || auth === undefined) {
          throw ApiError.internal(
            new Error(`idempotent route ${definition.method} ${pathname} is not authenticated`),
          );
        }
        const replay = await replayIdempotent({
          request,
          actorUserId: (auth as AuthContext).userId,
          route: `${definition.method} ${pathname}`,
          body,
        });
        if (replay.kind === 'replay') {
          const tookMs = elapsed(startedAt);
          log.info(`request completed — ${definition.summary} (idempotent replay)`, {
            status: replay.status,
            tookMs,
            rateClass: authz.rateLimit?.class,
          });
          return buildResponse(replay.status, replay.payload, requestId, {
            headers: replay.headers,
          });
        }
        idempotencyKey = replay.key;
      }

      const data = await definition.handler({
        request,
        params,
        query,
        body,
        requestId,
        log,
        auth,
        obligations,
      });

      const status = definition.successStatus ?? 200;
      const tookMs = elapsed(startedAt);
      log.info(`request completed — ${definition.summary}`, {
        status,
        tookMs,
        ...(authz.rateLimit === undefined ? {} : { rateClass: authz.rateLimit.class }),
      });

      const extraHeaders: Record<string, string> = {};
      if (status === 201 && authz.location !== undefined && data !== undefined && data !== null) {
        extraHeaders.Location = authz.location(data);
      }

      const payload = authz.pageResult
        ? pageEnvelope(data, requestId, tookMs)
        : { data: data ?? null, meta: { requestId, tookMs } };

      if (idempotencyKey !== null && definition.auth === 'required' && auth !== undefined) {
        await storeIdempotent({
          actorUserId: (auth as AuthContext).userId,
          route: `${definition.method} ${pathname}`,
          key: idempotencyKey,
          request,
          body,
          status,
          payload,
          headers: extraHeaders,
        });
      }

      return buildResponse(status, payload, requestId, { headers: extraHeaders });
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
 * The streaming read in `readBody` is the authoritative guard for chunked bodies,
 * but this pre-check makes ordinary oversized uploads cost nothing — they are
 * rejected before any allocation.
 *
 * `Content-Length` is a client *declaration*, not a guarantee. It is absent for
 * `Transfer-Encoding: chunked`, and a hostile client may understate it. The
 * streaming read covers that case by aborting mid-transfer.
 */
function assertDeclaredBodySizeWithinLimit(request: Request): void {
  const declared = request.headers.get('content-length');
  if (declared === null || declared === '') {
    return; // Unknown length: the streaming read is the guard.
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

/**
 * Read the request body through a counting stream, aborting at MAX_JSON_BODY_BYTES
 * *during* transfer (H-2 hardening). This prevents chunked bodies from being
 * fully buffered before rejection — an unauthenticated memory DoS.
 */
async function readBodyText(request: Request): Promise<string> {
  // No body stream (e.g., GET or already consumed) — fallback to text().
  if (request.body === null || request.body === undefined) {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_JSON_BODY_BYTES) {
      throw ApiError.payloadTooLarge(BODY_TOO_LARGE_DETAIL);
    }
    return text;
  }
  const reader = request.body.getReader();
  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_JSON_BODY_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // ignore cancel error
          }
          throw ApiError.payloadTooLarge(BODY_TOO_LARGE_DETAIL);
        }
        chunks.push(value);
      }
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    // If streaming fails (e.g., body locked), try text() as fallback.
    // This still enforces the limit via Buffer.byteLength.
    try {
      const fallback = await request.text();
      if (Buffer.byteLength(fallback, 'utf8') > MAX_JSON_BODY_BYTES) {
        throw ApiError.payloadTooLarge(BODY_TOO_LARGE_DETAIL);
      }
      return fallback;
    } catch (fallbackError) {
      if (fallbackError instanceof ApiError) throw fallbackError;
      throw error;
    }
  }
  if (chunks.length === 0) {
    return '';
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function readBody<TBody>(
  schema: z.ZodType<TBody> | undefined,
  request: Request,
): Promise<TBody | undefined> {
  if (schema === undefined) {
    return undefined;
  }

  assertDeclaredBodySizeWithinLimit(request);

  const text = await readBodyText(request);

  if (text.length === 0) {
    throw ApiError.badRequest('A JSON request body is required.');
  }
  // Content-Type is required only when a body is actually present. An empty
  // body is already rejected above; charset is allowed (`application/json; charset=utf-8`).
  assertJsonContentType(request);
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

function pageEnvelope(data: unknown, requestId: string, tookMs: number): unknown {
  const result = data as PageResult<unknown>;
  return {
    data: result.data,
    pagination: result.pagination,
    meta: { requestId, tookMs },
  };
}

function assertJsonContentType(request: Request): void {
  const raw = request.headers.get('content-type');
  if (raw === null || raw === '') {
    throw ApiError.badRequest('A JSON Content-Type is required.');
  }
  const media = raw.split(';')[0]?.trim().toLowerCase();
  if (media !== 'application/json') {
    throw ApiError.badRequest('A JSON Content-Type is required.');
  }
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

function assertSameOriginForMutations(request: Request): void {
  const method = request.method.toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return;
  }
  const origin = request.headers.get('origin');
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (origin !== null && origin !== '') {
    try {
      const originUrl = new URL(origin);
      const requestUrl = new URL(request.url);
      if (originUrl.host !== requestUrl.host) {
        throw ApiError.forbidden();
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Malformed Origin — treat as untrusted
      throw ApiError.forbidden();
    }
  }
  if (secFetchSite !== null && secFetchSite !== '') {
    const normalized = secFetchSite.toLowerCase();
    if (normalized === 'cross-site') {
      throw ApiError.forbidden();
    }
  }
}

/* ────────────────────────── MFA step-up helpers (C-2) ───────────────────────── */

/**
 * Whether the capability is INTERNAL-only (no client role holds it).
 */
function isInternalOnlyCapability(capability: Capability): boolean {
  const separator = capability.indexOf(':');
  if (separator === -1) return false;
  const resource = capability.slice(0, separator) as keyof typeof PERMISSION_MATRIX.SUPER_ADMIN;
  const action = capability.slice(separator + 1) as string;
  // Type-safe access via matrix
  const anyMatrix = PERMISSION_MATRIX as unknown as Record<
    string,
    Record<string, Record<string, { kind: string }>>
  >;
  const superAllow = anyMatrix.SUPER_ADMIN?.[resource]?.[action]?.kind === 'ALLOW';
  const adminAllow = anyMatrix.ADMIN?.[resource]?.[action]?.kind === 'ALLOW';
  const clientAdminAllow = anyMatrix.CLIENT_ADMIN?.[resource]?.[action]?.kind === 'ALLOW';
  const clientMemberAllow = anyMatrix.CLIENT_MEMBER?.[resource]?.[action]?.kind === 'ALLOW';
  return (superAllow || adminAllow) && !clientAdminAllow && !clientMemberAllow;
}

/**
 * Effective minAal for a request (C-2 hardening).
 *
 * Invert default: INTERNAL-only capabilities and sensitive internal mutations
 * require aal2 unless explicitly exempted. Only INTERNAL actors are affected
 * — CLIENT flows remain aal1.
 */
function effectiveMinAalForRequest(input: {
  readonly declared: 1 | 2 | undefined;
  readonly capability: Capability | undefined;
  readonly method: HttpMethod;
  readonly pathname: string;
  readonly auth: AuthContext;
}): 1 | 2 | undefined {
  // Explicit declaration wins — including explicit `1` to exempt.
  if (input.declared !== undefined) {
    return input.declared;
  }
  // Only INTERNAL staff are subject to step-up
  if (input.auth.userType !== 'INTERNAL') {
    return undefined;
  }
  // Exemptions: the step-up flows themselves and self-service
  const exemptPaths = [
    '/api/v1/auth/mfa/enroll',
    '/api/v1/auth/mfa/challenge',
    '/api/v1/auth/mfa/factors',
    '/api/v1/auth/mfa/unenroll',
    '/api/v1/auth/password',
    '/api/v1/me',
  ];
  if (
    exemptPaths.some(
      (prefix) =>
        input.pathname === prefix ||
        input.pathname.startsWith(prefix + '/') ||
        input.pathname.startsWith(prefix + '?'),
    )
  ) {
    return undefined;
  }
  // More precise: exact match for known exempt routes
  if (
    input.pathname === '/api/v1/auth/mfa/enroll' ||
    input.pathname === '/api/v1/auth/mfa/challenge' ||
    input.pathname === '/api/v1/auth/mfa/factors' ||
    input.pathname === '/api/v1/auth/password' ||
    input.pathname.startsWith('/api/v1/me')
  ) {
    return undefined;
  }

  if (input.capability === undefined) {
    return undefined;
  }

  // INTERNAL-only capabilities always require aal2 (even reads — admin surfaces)
  if (isInternalOnlyCapability(input.capability)) {
    return 2;
  }

  // Sensitive mutations for INTERNAL: any non-GET on sensitive resources
  if (input.method !== 'GET') {
    const resource = input.capability.split(':')[0] ?? '';
    const sensitiveResources = new Set([
      'organization',
      'invitation',
      'user',
      'engagement',
      'service',
      'project',
      'project_membership',
      'task',
      'deliverable',
      'report',
      'team_membership',
      'platform_grant',
      'membership',
      'activity',
    ]);
    if (sensitiveResources.has(resource)) {
      return 2;
    }
  }

  // Any /api/v1/admin/** path requires aal2
  if (input.pathname.startsWith('/api/v1/admin')) {
    return 2;
  }

  return undefined;
}

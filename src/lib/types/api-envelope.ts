/**
 * The API envelope — the single wire contract for every `/api/v1/**` response.
 *
 * These types are isomorphic: the server builds them (`src/server/api`) and the
 * browser consumes them (`src/lib/api-client`, Phase 5). Keeping them here means
 * neither side can drift from the other (ADR-0013).
 */

import type { ErrorCode } from '@/lib/types/error-codes';
import type { PaginationMeta } from '@/lib/types/pagination';

/** A single field-level validation problem, safe to show to an end user. */
export interface ValidationIssue {
  /** Dot-separated path to the offending field, e.g. `engagements.0.startDate`. */
  readonly path: string;
  readonly message: string;
  /** Stable machine-readable issue code, e.g. `invalid_type`, `too_small`. */
  readonly code: string;
}

/** Present on every response so a client report can be correlated to logs. */
export interface ResponseMeta {
  readonly requestId: string;
  /** Server-side processing time in milliseconds. */
  readonly tookMs: number;
}

/**
 * The public error body.
 *
 * Deliberately excludes anything an attacker could use: no stack traces, no SQL,
 * no row contents, no upstream Supabase error text. The underlying cause is
 * logged server-side against `requestId` and never returned (Rule 24).
 */
export interface ApiErrorBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: readonly ValidationIssue[];
  readonly requestId?: string;
}

export interface ApiSuccessEnvelope<T> {
  readonly data: T;
  readonly meta: ResponseMeta;
}

export interface ApiListEnvelope<T> {
  readonly data: readonly T[];
  readonly pagination: PaginationMeta;
  readonly meta: ResponseMeta;
}

export interface ApiErrorEnvelope {
  readonly error: ApiErrorBody;
}

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;
export type ApiListResponse<T> = ApiListEnvelope<T> | ApiErrorEnvelope;

/** HTTP status codes this API is permitted to emit. */
export type ApiHttpStatusCode =
  200 | 201 | 202 | 204 | 400 | 401 | 403 | 404 | 405 | 409 | 413 | 422 | 423 | 429 | 500 | 503;

/** Statuses usable for a successful response. */
export type SuccessStatusCode = 200 | 201 | 202 | 204;

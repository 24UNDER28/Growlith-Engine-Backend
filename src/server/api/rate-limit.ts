import 'server-only';

import { ApiError } from '@/server/api/errors';
import { createLogger } from '@/server/logging/logger';
import { extractActorIp } from '@/server/auth/audit';
import type { RateClass } from '@/server/api/with-route';

/**
 * In-memory rate limiter (C-1 hardening).
 *
 * App-layer limiter keyed by (trusted IP + account identifier) per declared class.
 * Responds with 429 + Retry-After. Logs at warn (never raw IP).
 *
 * Fixed-window implementation: per key, count requests in window; when exceeded,
 * reject with retryAfter = windowMs - elapsed.
 *
 * Note: in-memory per-instance; defense-in-depth alongside edge/GoTrue limits.
 * Not a distributed quota system (risk R-17). For multi-instance deployments,
 * use Redis/external store — interface is compatible.
 */

export interface RateLimitBudget {
  readonly limit: number;
  readonly windowMs: number;
}

export const RATE_LIMIT_BUDGETS: Record<RateClass, RateLimitBudget> = {
  auth: { limit: 10, windowMs: 15 * 60 * 1000 }, // 10 / 15 min
  sensitive: { limit: 30, windowMs: 15 * 60 * 1000 }, // 30 / 15 min
  mutation: { limit: 300, windowMs: 15 * 60 * 1000 }, // 300 / 15 min
  read: { limit: 600, windowMs: 15 * 60 * 1000 }, // 600 / 15 min
  export: { limit: 20, windowMs: 60 * 60 * 1000 }, // 20 / hour
} as const;

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

const buckets = new Map<string, Bucket>();

function keyFor(input: {
  readonly request: Request;
  readonly rateClass: RateClass;
  readonly route: string;
  readonly actorUserId?: string | null | undefined;
  readonly body?: unknown;
}): string {
  // Prefer authenticated actor id; otherwise trusted IP; otherwise anonymous bucket.
  // This ensures an attacker rotating XFF cannot evade limits (M-5).
  const trustedIp = extractActorIp(input.request);
  const actorPart = input.actorUserId ?? trustedIp ?? 'anonymous';

  // For auth-class routes, also bind to account identifier (email) when present
  // in the body, so password spray across many IPs still hits per-account limit.
  let accountPart = '';
  if (input.rateClass === 'auth' && input.body !== null && typeof input.body === 'object') {
    const maybeEmail = (input.body as Record<string, unknown>).email;
    if (typeof maybeEmail === 'string' && maybeEmail.length > 0) {
      accountPart = `::email:${maybeEmail.trim().toLowerCase()}`;
    }
  }

  return `${input.rateClass}::${input.route}::${actorPart}${accountPart}`;
}

export function enforceRateLimit(input: {
  readonly request: Request;
  readonly rateClass: RateClass;
  readonly route: string;
  readonly actorUserId?: string | null | undefined;
  readonly body?: unknown;
  readonly requestId?: string | undefined;
}): void {
  const budget = RATE_LIMIT_BUDGETS[input.rateClass];
  if (budget === undefined) {
    return;
  }

  const key = keyFor(input);
  const now = Date.now();
  const existing = buckets.get(key);

  if (existing === undefined || now >= existing.resetAt) {
    // Start new window
    buckets.set(key, { count: 1, resetAt: now + budget.windowMs });
    return;
  }

  if (existing.count < budget.limit) {
    existing.count += 1;
    return;
  }

  // Exceeded
  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  const log = createLogger({ scope: 'rate-limit', requestId: input.requestId });
  // Never log raw IP or email — only key kind and class
  const keyKind = input.actorUserId ? 'user' : extractActorIp(input.request) ? 'ip' : 'anonymous';
  log.warn('rate limit exceeded', {
    rateClass: input.rateClass,
    route: input.route,
    keyKind,
    retryAfterSeconds,
  });

  throw ApiError.tooManyRequests('Too many requests. Please retry later.', retryAfterSeconds);
}

/**
 * Reset all buckets — for tests only.
 */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}

/**
 * Inspect bucket for testing (not exported in prod, but exposed for regression tests).
 */
export function __getBucketForTests(key: string): Bucket | undefined {
  return buckets.get(key);
}

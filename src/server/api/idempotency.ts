import 'server-only';

import { createHash } from 'node:crypto';

import { ApiError } from '@/server/api/errors';
import { createLogger } from '@/server/logging/logger';
// JUSTIFIED service-role call site (client-service.ts rule): idempotency_keys
// has no SELECT policy for `authenticated` (deny-all under FORCE RLS) and is
// granted only to `service_role`. The table is not tenant-scoped; the primary
// key is (actor, route, key), which is the replay identity.
import { getSupabaseServiceClient } from '@/server/supabase/client-service';

const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 128;

export type IdempotencyReplay =
  | { readonly kind: 'fresh'; readonly key: string }
  | {
      readonly kind: 'replay';
      readonly status: number;
      readonly payload: unknown;
      readonly headers: Record<string, string>;
    };

export async function replayIdempotent(input: {
  readonly request: Request;
  readonly actorUserId: string;
  readonly route: string;
  readonly body: unknown;
}): Promise<IdempotencyReplay> {
  const key = readIdempotencyKey(input.request);
  const requestHash = hashRequest(input.request, input.body);
  const service = getSupabaseServiceClient();

  const { data, error } = await service
    .from('idempotency_keys')
    .select('request_hash, status_code, response_body, response_headers')
    .eq('actor_user_id', input.actorUserId)
    .eq('route', input.route)
    .eq('key', key)
    .maybeSingle();

  if (error !== null) {
    throw ApiError.serviceUnavailable('The idempotency store could not be read.');
  }
  if (data === null) {
    return { kind: 'fresh', key };
  }
  if (data.request_hash !== requestHash) {
    throw ApiError.conflict(
      'This Idempotency-Key was already used with a different request body.',
    );
  }
  const headers =
    data.response_headers !== null &&
    typeof data.response_headers === 'object' &&
    !Array.isArray(data.response_headers)
      ? Object.fromEntries(
          Object.entries(data.response_headers).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  return {
    kind: 'replay',
    status: data.status_code,
    payload: data.response_body,
    headers,
  };
}

export async function storeIdempotent(input: {
  readonly actorUserId: string;
  readonly route: string;
  readonly key: string;
  readonly request: Request;
  readonly body: unknown;
  readonly status: number;
  readonly payload: unknown;
  readonly headers: Record<string, string>;
}): Promise<void> {
  const log = createLogger({ scope: 'idempotency' });
  const service = getSupabaseServiceClient();
  const { error } = await service.from('idempotency_keys').insert({
    actor_user_id: input.actorUserId,
    route: input.route,
    key: input.key,
    request_hash: hashRequest(input.request, input.body),
    status_code: input.status,
    response_body: input.payload as never,
    response_headers: input.headers as never,
  });
  if (error !== null) {
    // A racing first-write is fine: the unique PK means the other request won.
    // Any other failure is logged; the mutation already happened, so we do not
    // fail the caller (the next replay will miss, which is a 2xx not a 5xx).
    if (error.code !== '23505') {
      log.warn('idempotency key could not be stored', { reason: error.message });
    }
  }
}

function readIdempotencyKey(request: Request): string {
  const raw = request.headers.get(IDEMPOTENCY_HEADER)?.trim() ?? '';
  if (raw.length === 0) {
    throw ApiError.badRequest('The Idempotency-Key header is required for this operation.');
  }
  if (raw.length > MAX_KEY_LENGTH) {
    throw ApiError.badRequest(`Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.`);
  }
  if (!/^[\w.:-]{1,128}$/.test(raw)) {
    throw ApiError.badRequest('Idempotency-Key contains characters that are not allowed.');
  }
  return raw;
}

function hashRequest(request: Request, body: unknown): string {
  const canonical = JSON.stringify({
    method: request.method,
    pathname: safePath(request.url),
    body: body ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

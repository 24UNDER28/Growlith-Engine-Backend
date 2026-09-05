/**
 * Request correlation identifiers.
 *
 * Every API response carries `x-request-id`, and every log line for that
 * request carries the same value. That single correlation is what makes
 * "the client says it failed" diagnosable: a user reports the id from an error
 * state, and the whole server-side trace is one query away.
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * An inbound request id is accepted only in canonical UUID form.
 *
 * This is a log-injection control, not just a format check: without it a client
 * could send a header containing newlines or ANSI escapes and forge additional
 * log lines. Anchoring to a UUID and lowercasing makes the value inert.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Generate a new request id. */
export function createRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Reuse a well-formed inbound request id (so a proxy or browser-generated
 * correlation survives), otherwise mint a new one.
 */
export function resolveRequestId(headers: Headers): string {
  const inbound = headers.get(REQUEST_ID_HEADER);

  if (inbound !== null && CANONICAL_UUID.test(inbound)) {
    return inbound.toLowerCase();
  }

  return createRequestId();
}

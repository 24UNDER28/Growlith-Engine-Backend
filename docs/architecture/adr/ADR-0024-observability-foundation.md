# ADR-0024: Observability Foundation

**Status:** Accepted
**Phase:** 1

## Context

A portal that holds client performance data will be disputed: "who approved this
deliverable, when, and what did they see?" Answering that requires correlation
and structure from the first request, not retrofitted later. At the same time,
logs are a classic leakage path — a request dump routinely contains an
`authorization` header or a session cookie.

## Decision

A dependency-free structured logger (`src/server/logging/logger.ts`) plus a
redaction module (`redaction.ts`):

- **One JSON object per line**, always carrying `time`, `level` and `msg`, on
  stdout for `debug`/`info` and stderr for `warn`/`error`, so alerting can
  subscribe to a single stream.
- **`requestId` correlation.** Every response carries `x-request-id` and every
  log line for that request carries the same value. An inbound id is reused only
  if it is a canonical UUID, then lowercased — an attacker-controlled header is
  otherwise a log-injection vector (forged lines, ANSI escapes).
- **Redaction is unconditional**, applied by two independent mechanisms, because
  either alone is insufficient:
  - _key-based_ — a field whose name matches `password|secret|token|jwt|
authorization|cookie|session|api_key|…` is replaced wholesale;
  - _value-based_ — a string shaped like a JWT (`eyJ…`), a Supabase secret
    (`sb_secret_…`) or a connection string with an embedded password is replaced
    even under an innocuous key such as `payload`. This is the realistic leak
    path, and key matching alone misses it entirely.
  - Personal data is **masked, not dropped**: `kishor@…` becomes `k***@domain`,
    because support genuinely needs to know which account an event concerns.
- **Raw `console.*` is banned** by ESLint across `src/**`, `app/**` and
  `components/**`, with a single exception for the logger implementation. The ban
  is what makes redaction guaranteed rather than optional.
- **Robust against pathological input**: cycles become `[Circular]`, depth and
  array length are capped, over-long strings are truncated, and a field that
  cannot be serialized (e.g. a `BigInt`) degrades to a valid line carrying the
  message rather than throwing inside the error path.

## Consequences

- `audit_events` (Phase 2) is a _separate_, append-only, database-enforced
  record. Logs are operational and ephemeral; audit is contractual evidence.
  Neither substitutes for the other.
- No logging library is added (Rule 17). Should distributed tracing become a
  requirement, the integration point is the `fields` object, not a rewrite.

## Alternatives rejected

- **pino / winston**: both would satisfy the requirements, but each is a runtime
  dependency in the hottest path of every request, and neither removes the need
  for the domain-specific redaction rules above.

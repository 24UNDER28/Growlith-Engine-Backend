# ADR-0025: Error Envelope And Non Disclosure

**Status:** Accepted
**Phase:** 1

## Context

Every error response is a disclosure decision. A raw PostgreSQL error tells an
attacker that a table exists, what its constraints are named, and sometimes what
a hidden row contains. Rule 24 requires that errors never be silently ignored —
which means they must be _handled_ deliberately, not merely swallowed.

## Decision

- **One error type.** `ApiError` (`src/server/api/errors.ts`) carries a public
  `code`, a public `message`, optional validation `details`, optional response
  `headers`, and the original failure as `cause`.
- **`cause` is for logs only.** It is never serialized. `toPublicBody()` returns
  an `ApiErrorBody` containing exactly `code`, `message`, and — when present —
  `details` and `requestId`.
- **One envelope.** Failures are wrapped as `{ error: { … } }`, successes as
  `{ data, meta }`. Two shapes, discriminable by the presence of `error`.
- **Stable machine-readable codes** (`src/lib/types/error-codes.ts`) shared with
  the browser, so client code branches on `ErrorCode.Unauthenticated` rather
  than on an HTTP status number.
- **Unknown throwables are downgraded.** `toApiError()` maps anything
  unrecognised — including non-`Error` values — to a generic 500, preserving the
  original as `cause`. A handler therefore cannot leak by throwing something
  unexpected.
- **404 for "missing" and "hidden by RLS" alike** (ADR-0019). Distinguishing
  them would confirm that a resource exists in another tenant and enable
  cross-tenant enumeration by UUID.
- **4xx and 5xx are logged differently.** A 5xx means we broke, so it is logged
  at `error` with its cause. A 4xx means a client sent something we rejected,
  which is normal traffic: logged at `info` without a cause, so genuine failures
  stay visible.

## Verification performed

`tests/unit/errors.spec.ts` asserts non-disclosure directly: for five realistic
server-side messages (a missing relation, a named unique constraint, an RLS
policy violation, an absolute file path, an `ECONNREFUSED` host), the serialized
public body contains neither the message nor the string `cause`.

A defect found by these tests during Phase 1 is worth recording: the error path
initially emitted `{ code, message }` at the top level instead of wrapping it in
`{ error: … }`, producing a second, undocumented response shape. The contract
test caught it before the envelope was ever consumed.

## Consequences

Adding an `ErrorCode` is backwards compatible; renaming or removing one is a
breaking change to `/api/v1` and requires a version bump.

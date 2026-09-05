# Architecture Decision Register

Every architecturally significant decision in this repository is recorded here.
Rule 21 requires that decisions be documented; this register is the index, and
each accepted decision has its own file.

**Convention.** An ADR is written in the phase that _owns_ the decision, not
speculatively in advance. Decisions marked **Proposed** are settled in the
assessment and binding on that phase, but their full ADR is authored when the
phase implements them — so that the recorded consequences reflect what was
actually built rather than what was predicted.

🔒 = expensive or impossible to reverse later; decided in Phase 1 deliberately.

| ADR     | Decision                                                                                                                    | Status       | Phase | File                                                                                    |
| ------- | --------------------------------------------------------------------------------------------------------------------------- | ------------ | ----- | --------------------------------------------------------------------------------------- |
| 0001 🔒 | One Next.js application holds both dashboards and the API                                                                   | **Accepted** | 1     | [ADR-0001](ADR-0001-single-nextjs-application.md)                                       |
| 0002    | Client/server boundary is a filesystem wall enforced by four independent controls                                           | **Accepted** | 1     | [ADR-0002](ADR-0002-client-server-boundary-wall.md)                                     |
| 0003    | App Router; RSC for reads, client components for interactivity                                                              | **Accepted** | 1     | _(recorded in `docs/architecture/README.md` §C; full ADR with Phase 9 UI)_              |
| 0004    | No ORM. Hand-written forward-only SQL migrations + generated types                                                          | **Accepted** | 1     | [ADR-0004](ADR-0004-no-orm-generated-types.md)                                          |
| 0005 🔒 | `organization_id` denormalized onto every tenant row, made tamper-proof by composite foreign keys                           | **Accepted** | 2     | [ADR-0005](ADR-0005-denormalized-tenant-key-composite-foreign-keys.md)                  |
| 0006    | `service_lines` (catalogue) is separate from `services` (engagement instances), with a seeded 1:1 team mapping              | **Accepted** | 2     | [ADR-0006](ADR-0006-service-catalogue-separate-from-instances.md)                       |
| 0007    | Two authorization layers — capability matrix (app) and RLS (database); both must pass                                       | Proposed     | 4     | _(authored in Phase 4)_                                                                 |
| 0008    | RLS uses `SECURITY DEFINER` helpers with a pinned `search_path`, declared `STABLE`                                          | **Accepted** | 2     | [ADR-0008](ADR-0008-security-definer-rls-helpers.md)                                    |
| 0009    | `ENABLE` **and** `FORCE ROW LEVEL SECURITY` on tenant tables                                                                | **Accepted** | 2     | [ADR-0009](ADR-0009-enable-and-force-row-level-security.md)                             |
| 0010 ⚠️ | Roles are data, so a fifth internal role (`TEAM_MEMBER`) is a configuration change — **awaiting owner decision (risk R-1)** | Proposed     | 4     | _(authored in Phase 4)_                                                                 |
| 0011    | Platform role travels in `app_metadata` and is re-verified against the database for privileged operations                   | Proposed     | 3     | _(authored in Phase 3)_                                                                 |
| 0012    | Sensitive client mutations go through `SECURITY DEFINER` RPCs, never direct `UPDATE`                                        | **Accepted** | 2     | [ADR-0012](ADR-0012-sensitive-mutations-through-definer-rpcs.md)                        |
| 0013    | One mutation path: Route Handlers via `withRoute`; Server Actions may only delegate                                         | **Accepted** | 1     | [ADR-0013](ADR-0013-single-mutation-path.md)                                            |
| 0014    | No CORS. The API is same-origin with the dashboards                                                                         | Proposed     | 5     | _(authored in Phase 5)_                                                                 |
| 0015 🔒 | One private Storage bucket with an `organization_id`-first path convention                                                  | Proposed     | 6     | _(authored in Phase 6)_                                                                 |
| 0016    | Signed upload/download URLs; file bytes never proxy through Next.js                                                         | Proposed     | 6     | _(authored in Phase 6)_                                                                 |
| 0017    | Zod schemas shared by server and client; `.strict()`; types inferred, never duplicated                                      | **Accepted** | 1     | [ADR-0017](ADR-0017-shared-zod-validation.md)                                           |
| 0018    | Cursor (keyset) pagination with server-clamped page sizes                                                                   | **Accepted** | 1     | _(implemented in `src/lib/pagination/`; rationale in `docs/architecture/README.md` §I)_ |
| 0019    | Resources hidden by RLS return 404, never 403                                                                               | **Accepted** | 1     | _(implemented in `src/server/api/errors.ts`, tested)_                                   |
| 0020    | Append-only `audit_events` with a database-level immutability trigger                                                       | **Accepted** | 2     | [ADR-0020](ADR-0020-append-only-audit-events.md)                                        |
| 0021    | Executable verification is the proof of RLS; three layers, pgTAP still required in Phase 4                                  | **Accepted** | 2     | [ADR-0021](ADR-0021-pgtap-is-the-proof-of-rls.md)                                       |
| 0022    | Dependency versions pinned on evidence, not on `latest`                                                                     | **Accepted** | 1     | [ADR-0022](ADR-0022-dependency-versions-pinned-on-evidence.md)                          |
| 0023    | Environment config is lazy, fails fast at boot, and the logger never depends on it                                          | **Accepted** | 1     | [ADR-0023](ADR-0023-environment-lazy-fail-fast.md)                                      |
| 0024    | Dependency-free structured logging with unconditional, two-mechanism redaction                                              | **Accepted** | 1     | [ADR-0024](ADR-0024-observability-foundation.md)                                        |
| 0025    | One error envelope; `cause` is logged, never serialized; unknown throwables are downgraded                                  | **Accepted** | 1     | [ADR-0025](ADR-0025-error-envelope-and-non-disclosure.md)                               |

## Decisions that were changed during implementation

Recording these matters more than recording the plan, because they show where
evidence overrode intent:

- **ADR-0022** — the assessment proposed TypeScript `7.0.2` and ESLint `10.10.0`
  (both then-current stable). Both were rejected on evidence during
  implementation: `typescript-eslint` does not support TS 7, and ESLint 10
  crashes `eslint-plugin-react`. See the ADR for the exact error output.
- **ADR-0018/0019** — implemented and tested in Phase 1 rather than deferred,
  because the error envelope and pagination codec are part of the API contract
  that Phase 5 endpoints consume.
- **ADR-0021** — Phase 1 named pgTAP as the single proof of RLS. Phase 2 found
  that the sandbox had PostgreSQL but no Docker, and the Supabase CLI needs
  Docker for both `supabase test db` and `supabase gen types --local`. Rather
  than skip verification, Phase 2 built two Docker-free layers
  (`tests/unit/schema.spec.ts`, `scripts/db-verify.mjs`) that caught two real
  defects invisible to inspection: unprotected audit partitions, and 22
  composite foreign keys with no matching index. pgTAP remains required and is
  still outstanding — risk R-3 is open.
- **ADR-0005** — the tenant-key derivation trigger originally overwrote a
  client-supplied `organization_id` that disagreed with the parent's. Changed
  during Phase 2 to raise instead: silent correction would have re-homed a
  misdirected write into another tenant and reported success.

## Decisions explicitly _not_ taken in Phase 1

Each of these was considered and rejected as premature. Reconsider only with new
information:

- **Field-level entity TypeScript types.** Generated from the database in
  Phase 2 (ADR-0004); hand-writing them now would guarantee drift.
- **Entity validation schemas.** Arrive with their endpoints in Phase 5
  (ADR-0017).
- **Status state machines.** Business rules; Phase 5.
- **Rate limiting, CSP, HSTS, malware scanning.** Phase 6. No speculative
  configuration or dependencies are added in advance (Rules 14 and 17).
- **A caching layer, a message queue, a search service.** None is justified by
  current requirements (Rules 15–17).

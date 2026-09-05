# ADR-0017: Shared Zod Validation

**Status:** Accepted
**Phase:** 1

## Context

Rule 19 requires all external input to be validated. Validation defined twice —
once for the server, once for the form — always diverges, and the divergence is
discovered by users.

## Decision

Zod schemas in `src/lib/validation/**` are the single definition for each input
shape. One schema simultaneously:

1. validates the request in the route handler,
2. produces the TypeScript type via `z.infer` (no hand-written duplicate),
3. drives the browser form and its inline errors (Phase 9).

Conventions, all enforced by review and by the schema helpers in
`src/lib/validation/common.ts`:

- `.strict()` on every input object, so unknown keys are **rejected**, not
  stripped. This is what makes mass assignment impossible: a client cannot
  smuggle `organizationId` or `role` into a create payload, and the attempt is
  visible as a 422 rather than silently ignored.
- `.trim()` on free-text fields.
- Explicit, field-named messages, because they are rendered to a human.

Only Zod issues' `path`, `message` and `code` cross the API boundary
(`toValidationIssues`). Raw issue objects can carry input fragments and are
never serialized.

## Consequences

- Entity schemas are deliberately **not** written in Phase 1. Authoring a
  persistence model before the Phase 2 schema exists would guarantee drift
  (Rule 14); they arrive with their endpoints in Phase 5.
- `src/lib/validation/common.ts` holds only the shared primitives that Phase 1
  actually uses.

## Alternatives rejected

- **Yup / io-ts / Valibot**: no advantage sufficient to justify the dependency;
  Zod's `z.infer` gives the type-sharing property this decision depends on.
- **Separate client and server validation**: guarantees drift.

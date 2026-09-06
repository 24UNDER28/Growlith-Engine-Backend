# Tests

Five levels are defined in
[`docs/architecture/README.md` §J](../docs/architecture/README.md). Phase 1
implements L1, L3 and the architectural conformance layer.

| Directory       | Level | What it proves                                                                                                       |
| --------------- | ----- | -------------------------------------------------------------------------------------------------------------------- |
| `unit/`         | L1    | Codecs, limits, error mapping, redaction, environment contracts, domain vocabulary. Pure, no I/O                     |
| `contract/`     | L3    | Route-handler behaviour: envelope shape, validation, status mapping, information non-disclosure, request correlation |
| `architecture/` | —     | Properties of the _repository_ rather than of a running program                                                      |
| `helpers/`      | —     | Source-scanning utilities used by the architecture tests                                                             |
| `stubs/`        | —     | An inert `server-only` stand-in; see below                                                                           |

**L2** lives in `tests/unit/permissions.spec.ts` (the dense matrix plus Phase 5
route-coverage). Not here yet: **L4** (pgTAP RLS tests in `supabase/tests/`),
**L5** (Playwright, Phase 9).

## Why `unit/domain.spec.ts` exists for data that has no behaviour

`src/lib/domain/**` is pure vocabulary, so there is no logic to exercise — which is
precisely why it went untested until the Phase 1 review. In Phase 2 those arrays
become PostgreSQL `enum` types; in Phase 4 `ROLES` becomes the row axis of the
permission matrix; in Phase 9 they become navigation and labels. Editing one is
therefore a schema change, and enum values are the hardest kind of change to
reverse once rows reference them.

The suite locks the vocabulary and its structural invariants — the two
authorization axes stay disjoint, tenant scoping agrees with the axis, the entity
hierarchy is acyclic and terminates at exactly one tenant root, every service line
maps to a real team, every team has a line to deliver.

It also carries the **risk R-1 tripwire**: the four roles cannot express "internal
staff limited to their own team", an accepted gap that is only honest while it is
visible. The test binds `src/lib/domain/roles.ts` to the §M risk register, so
adding a fifth role fails the suite until the register, the domain model and the
Phase 2 enum migration are updated in the same change — and closing R-1 in the
register without adding the role fails too.

## Why architectural conformance tests exist

The properties they guard are **invisible when they break**. Deleting
`import 'server-only'` from one file changes no behaviour and fails no other
test — it silently removes a control that contains Supabase's `BYPASSRLS` key.
Unit tests cannot see that; reading source can.

They assert, among other things: every `src/server/**` module declares
`server-only` first; no isomorphic module reaches server code; no `'use client'`
file reaches server code; only the client env module reads `process.env`; no
server module imports UI; the Supabase clients have no barrel; every API route is
built with `withRoute`; no credential-shaped literal is committed;
`.env.example` matches the declared key sets exactly in both directions; and the
runtime dependency list is exactly the approved set.

Two of them guard the guards:

- **No browser-only API in the isomorphic tier.** "Isomorphic" means _runs on
  both sides_, not merely _importable from both sides_ — a module touching
  `document` can be imported into a route handler and then throws on first call.
  This check has a stated limit: it scans our source, so it cannot see through a
  dependency. `@supabase/ssr`'s `createBrowserClient` reads `document.cookie`
  _inside the library_, and a `src/lib` module importing it contains no offending
  token. That regression happened during the Phase 1 review, so the factory is
  named explicitly in the pattern list. Any new third-party factory placed in
  `src/lib` needs the same treatment.
- **No non-literal dynamic `import()`.** Every boundary test works by extracting
  module specifiers from source text, so `import(computed)` would be invisible to
  all of them. There are no dynamic imports in application source today; the test
  keeps it that way.

That last one is deliberate: adding a dependency requires editing a test, which
turns Rule 17 ("avoid unnecessary dependencies") from an intention into a
reviewable diff.

## The `server-only` stub

The real package resolves through its `exports` map: the `react-server`
condition (Next.js server builds) yields an empty module, while the `default`
condition yields a file that **throws unconditionally**. Vitest runs in plain
Node and would hit the throwing branch, making every `src/server/**` module
untestable. `vitest.config.mts` aliases the specifier to `stubs/server-only.ts`.

This weakens nothing: the barrier is enforced by `next build` and by the bundle
scan, not by the test runner.

## Conventions

- Import `{ describe, it, expect }` explicitly — no injected globals, so test
  files type-check without a global types dependency.
- **No snapshot tests for authorization decisions.** A snapshot makes it easy to
  accept a changed permission matrix without noticing what changed.
- Tests must assert real behaviour. A test that passes whether or not the control
  works is worse than no test — every security control added in Phase 1 was
  verified with a deliberate violation before being trusted.

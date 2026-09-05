# ADR-0022: Dependency Versions Pinned On Evidence

**Status:** Accepted
**Phase:** 1

## Context

At the time of writing, the newest stable releases were Next `16.3.4`, React
`19.2.8`, TypeScript `7.0.2`, ESLint `10.10.0`, Zod `4.5.4` and Vitest `5.0.0` —
several simultaneous major-version fronts (risk R-4). The assessment required a
scaffold spike before pinning, rather than adopting `latest` on faith.

## Decision

Pin the versions resolved by the spike below. Every version was verified against
the declared peer ranges of the whole graph, not just the top-level package.

| Package                 | Pinned     | Why                                                         |
| ----------------------- | ---------- | ----------------------------------------------------------- |
| `next`                  | 16.3.4     | current stable; engine `node >=20.9.0` satisfied by Node 22 |
| `react` / `react-dom`   | 19.2.8     | satisfies Next 16's peer range `^19.0.0`                    |
| `typescript`            | **5.9.3**  | see evidence below                                          |
| `eslint`                | **9.39.5** | see evidence below                                          |
| `eslint-config-next`    | 16.3.4     | ships native flat config; peer `eslint >=9.0.0`             |
| `zod`                   | 4.5.4      | `@supabase/ssr` and Next 16 compatible                      |
| `vitest`                | 5.0.0      | Node 22 compatible                                          |
| `@supabase/supabase-js` | 2.115.0    | satisfies `@supabase/ssr@0.12.6` peer `^2.114.0`            |
| `@supabase/ssr`         | 0.12.6     | cookie-based sessions for the App Router                    |
| `server-only`           | 0.0.1      | the import barrier in ADR-0002                              |
| `prettier`              | 3.9.6      | v4 is still pre-release                                     |

## Evidence — why not TypeScript 7 and ESLint 10

**TypeScript 7.0.2 is not supported by the TypeScript linter.**
`typescript-eslint@8.69.0` — the newest release — declares
`typescript: ">=4.8.4 <6.1.0"`. Installing TS 7 produced 11 `ERESOLVE overriding
peer dependency` warnings across `typescript-eslint` and all seven
`@typescript-eslint/*` packages. In this architecture ESLint is a _security
control_ (ADR-0002), so it must not run on a parser outside its supported range:
an unsupported parser can produce false negatives, which is worse than a loud
failure. TypeScript 6.0.3 exists and is in range, but it is a bridge release
that is not `latest`-tagged. **5.9.3 is the newest stable in range.**

**ESLint 10.10.0 crashes `eslint-plugin-react`.**
This was verified empirically, not inferred. With ESLint 10 installed, linting
failed outright:

```
TypeError: Error while loading rule 'react/display-name':
  contextOrFilename.getFilename is not a function
  at resolveBasedir (eslint-plugin-react/lib/util/version.js:31)
```

`eslint-plugin-react@7.37.5` (the newest release, pulled in by
`eslint-config-next@16.3.4`) calls `context.getFilename()`, an API removed in
ESLint 10. `eslint-plugin-import@2.32.0` and `eslint-plugin-jsx-a11y@6.10.2`
likewise cap their peer range at `^9`. Staying on ESLint 10 would mean dropping
the React, import and accessibility rule sets — a poor trade for a product whose
Phase 9 is two dashboards.

**Result:** with TypeScript 5.9.3 + ESLint 9.39.5 the entire dependency graph is
inside every declared peer range, and `npm install` reports **zero** `ERESOLVE`
overrides.

## Known trade-off

`eslint@9.39.5` is flagged deprecated by npm (ESLint 9 is past its support
window). Accepted because:

- it is inside `eslint-config-next@16.3.4`'s declared peer range, i.e. a
  combination the framework supports;
- ESLint is a development-time tool that never ships to production and never
  handles untrusted network input;
- the alternative loses accessibility and hooks linting across all dashboard UI.

**Tracked follow-up:** upgrade to ESLint 10 when `eslint-plugin-react` or
`eslint-config-next` publishes a compatible release. The wall rules use only core
ESLint rules (`no-restricted-imports`, `no-restricted-properties`, `no-console`),
so the upgrade is mechanical.

## Verification performed

A green lint run proves nothing on its own, so the rules were confirmed to fire:
five deliberate violations produced 6 ESLint errors and 5 test failures, each
naming the offending file (see ADR-0002).

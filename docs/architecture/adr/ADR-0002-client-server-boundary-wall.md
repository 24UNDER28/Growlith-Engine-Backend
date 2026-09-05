# ADR-0002: Client Server Boundary Wall

**Status:** Accepted
**Phase:** 1

## Context

Supabase's `service_role` key carries PostgreSQL's `BYPASSRLS` attribute. If it
reaches a browser bundle, tenant isolation is lost for every client organization
at once, and the application continues to work normally — the leak is invisible.
Convention and code review do not survive deadline pressure.

## Decision

Express the boundary as a filesystem split, then enforce it with **four
independent controls**:

| #   | Control                                                                       | Fails when                                                                                                                                            |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `eslint.config.mjs` → `growlith/wall-*`                                       | `src/lib/**` or `components/**` imports `@/server/*`, `server-only`, or reads `process.env`; or `src/server/**` imports UI                            |
| 2   | `import 'server-only'` as the first statement of every `src/server/**` module | a client graph reaches a server module — `next build` exits non-zero                                                                                  |
| 3   | `tests/architecture/client-server-boundary.spec.ts`                           | any of the above at source level, including `'use client'` files ESLint cannot classify                                                               |
| 4   | `scripts/check-client-exposure.mjs`                                           | the emitted `.next/static` bundle contains a service-role key, a `sb_secret_` value, a JWT, a connection string, or a symbol from `client-service.ts` |

`src/lib/**` is isomorphic and provably secret-free. `src/server/**` is
secret-bearing. There is **no barrel file** in `src/server/supabase/`: importing
both clients through one path would pull the dangerous one into graphs that only
needed the safe one.

## Verification performed

Controls 1, 3 and 4 were each verified with a deliberate violation, not merely
observed to pass:

- Five probe files (isomorphic→server import, raw `console`, `process.env` read,
  server→UI import, `'use client'`→server import) produced **6 ESLint errors**
  and **5 test failures**, each naming the offending file.
- A `'use client'` page importing `@/server/supabase/client-service` made
  `next build` **exit 1**, reporting the full transitive chain
  (`env.ts` → `client-service.ts` → `page.tsx`).
- A fake `sb_secret_…` string in a client component made the exposure scan
  **exit 1** and name the exact chunk.

## Consequences

Adding a shared helper means deciding which side of the wall it belongs on. That
friction is the point: it is the decision that must not be made carelessly.

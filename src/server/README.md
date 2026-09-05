# `src/server` — server-only layer

**Every module here begins with `import 'server-only';`** — literally the first
statement, before any other import. That marker makes `next build` fail if a
client graph ever reaches this directory.

An architecture test asserts the marker is present _and_ first, for every file.
A module that loses it changes no behaviour and fails no other test; it simply
removes a security control. That invisibility is why it is checked mechanically.

## The dangerous module

`supabase/client-service.ts` builds a client with Supabase's `service_role` key,
which carries the PostgreSQL **`BYPASSRLS`** attribute. A query through it is not
subject to Row Level Security, so it can read and write every row of every client
organization at once.

Use it only where an operation must legitimately exceed the caller's rights
(invitations, cross-tenant administration, verifying a Storage object), and say
why in a comment at the call site. **Default to `client-server.ts`.**

There is deliberately **no barrel file** in `supabase/`: a single
`import { … } from '@/server/supabase'` would pull the service client into every
consumer's graph, including consumers that only needed the safe one.

## Rules

1. First statement is `import 'server-only';`.
2. Never import UI (`@/components/*`). Return data; let the presentation layer
   render it.
3. Never log with raw `console.*` — use `logging/logger.ts`, which redacts
   unconditionally. The ban is what makes redaction guaranteed rather than
   optional.
4. Read configuration only through `env.ts`.
5. Business rules live in `services/` (Phase 5), data access in
   `repositories/`, and HTTP concerns in `api/`. Route handlers stay thin.

## Layout

| Path                         | Purpose                                                             | Phase |
| ---------------------------- | ------------------------------------------------------------------- | ----- |
| `api/with-route.ts`          | The single entry point for every route handler                      | 1 ✅  |
| `api/errors.ts`              | `ApiError`, error normalisation, non-disclosure                     | 1 ✅  |
| `env.ts`                     | Validated server environment contract                               | 1 ✅  |
| `logging/`                   | Structured JSON logger + redaction                                  | 1 ✅  |
| `supabase/client-server.ts`  | Request-scoped client, propagates the **user's JWT** so RLS applies | 1 ✅  |
| `supabase/client-service.ts` | Service-role client. `BYPASSRLS`                                    | 1 ✅  |
| `auth/`                      | Sessions, capability guards, invitations                            | 3–4   |
| `services/`                  | Use cases: business rules, transactions, audit                      | 5     |
| `repositories/`              | Typed data access. No rules                                         | 5     |
| `storage/`                   | Path policy, signed URLs, object verification                       | 6     |
| `audit/`                     | Append-only audit writer                                            | 2/5   |

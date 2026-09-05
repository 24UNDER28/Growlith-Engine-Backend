import { z } from 'zod';

import { EnvironmentError } from '@/lib/errors/environment';
import { formatValidationIssues } from '@/lib/validation/format';

/**
 * Browser-exposed environment contract.
 *
 * SECURITY MODEL (Rules 11–12):
 * Everything in this module is **public by design**. `NEXT_PUBLIC_*` values are
 * inlined into the client JavaScript bundle at build time and are readable by
 * anyone who opens devtools. The anonymous key is therefore not a secret — it
 * grants exactly what PostgreSQL Row Level Security permits and nothing more.
 *
 * That is also why `SUPABASE_SERVICE_ROLE_KEY` must never appear here, and why
 * no variable in `CLIENT_ENV_KEYS` may be anything other than a
 * `NEXT_PUBLIC_`-prefixed value. `tests/architecture/env-contract.spec.ts`
 * enforces that invariant, so the mistake becomes a test failure rather than a
 * production incident.
 *
 * This is the only isomorphic module permitted to read `process.env`
 * (see the `growlith/env-client-exception` block in `eslint.config.mjs`).
 *
 * WHO READS THIS MODULE
 * The name describes *exposure*, not *location*. This is the contract for the
 * public half of the configuration, and **server modules read it too** — both
 * Supabase factories in `src/server/supabase/` take the project URL from
 * `NEXT_PUBLIC_SUPABASE_URL` instead of a server-only `SUPABASE_URL`.
 *
 * That is deliberate and load-bearing. A Supabase project has exactly one URL,
 * so it should be declared exactly once. Adding a second server-side variable
 * for the same fact would permit the server and the browser to be configured
 * against *different projects*: reads through the anon key and writes through
 * the service-role key would silently land in different databases, with no error
 * raised anywhere. One declaration makes that split-brain unrepresentable.
 *
 * The `NEXT_PUBLIC_` prefix means "safe to publish", not "only usable in the
 * browser". Reading a publishable value from the server discloses nothing; it is
 * the opposite direction — a server-only value reaching a bundle — that the
 * boundary wall exists to prevent.
 */

const clientEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ message: 'NEXT_PUBLIC_SUPABASE_URL must be a valid URL' }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required'),
  NEXT_PUBLIC_APP_URL: z.url({ message: 'NEXT_PUBLIC_APP_URL must be a valid URL' }),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

/** Union of the browser-exposed variable names. Derived from the schema. */
export type ClientEnvKey = keyof typeof clientEnvSchema.shape;

/**
 * The canonical list of browser-exposed variables, **derived from the schema
 * above rather than hand-maintained**.
 *
 * A hand-written key list sitting next to a hand-written schema is two sources
 * of truth for one contract. Adding a variable to the schema but forgetting the
 * list — or the reverse — silently corrupts the checks that read this list (the
 * `.env.example` parity test, the client-exposure scan), and nothing fails until
 * a secret is shipped or a required variable goes unvalidated. Deriving it makes
 * that class of drift unrepresentable: the schema is the only place a variable
 * is declared.
 *
 * `Object.keys` preserves declaration order, so the list is deterministic.
 */
export const CLIENT_ENV_KEYS = Object.keys(clientEnvSchema.shape) as ClientEnvKey[];

let cached: ClientEnv | undefined;

/**
 * Read and validate the browser environment.
 *
 * Lazy by design (ADR-0023): `NEXT_PUBLIC_*` values are substituted at build
 * time, so parsing at import time would make module evaluation order affect
 * whether the app boots.
 *
 * @throws {EnvironmentError} listing every missing or malformed variable.
 */
export function getClientEnv(): ClientEnv {
  if (cached) {
    return cached;
  }

  const result = clientEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new EnvironmentError(formatValidationIssues(result.error.issues));
  }

  cached = result.data;
  return cached;
}

/** Non-throwing variant for diagnostics and tests. */
export function inspectClientEnv():
  { ok: true; env: ClientEnv } | { ok: false; error: EnvironmentError } {
  const result = clientEnvSchema.safeParse(process.env);
  if (!result.success) {
    return { ok: false, error: new EnvironmentError(formatValidationIssues(result.error.issues)) };
  }
  return { ok: true, env: result.data };
}

/** Test helper: drop the memoized value so each test sees its own environment. */
export function __resetClientEnvCacheForTests(): void {
  cached = undefined;
}

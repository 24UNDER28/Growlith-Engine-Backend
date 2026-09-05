import 'server-only';

import { z } from 'zod';

import { EnvironmentError } from '@/lib/errors/environment';
import { formatValidationIssues } from '@/lib/validation/format';
import { createLogger } from '@/server/logging/logger';

/**
 * Server-only environment contract.
 *
 * Design decisions (ADR-0023):
 *
 * 1. LAZY. `process.env` is parsed on first *access*, never at import time.
 *    `next build` must succeed without production secrets present, so no module
 *    may throw merely by being imported.
 *
 * 2. FAIL FAST AT THE POINT OF USE. `getServerEnv()` throws an
 *    `EnvironmentError` listing *every* problem at once, so an operator fixes
 *    the whole configuration in one pass instead of discovering one missing
 *    variable per restart.
 *
 * 3. THE LOGGER MUST NOT DEPEND ON THIS MODULE. A logger that reads its level
 *    through a throwing env module would fail exactly when the environment is
 *    misconfigured — the moment logs matter most. `logger.ts` therefore reads
 *    `LOG_LEVEL` directly, and this module may use the logger safely.
 *
 * 4. NO SPECULATIVE VARIABLES. A variable belongs in this contract only once a
 *    module in this repository reads it through `getServerEnv()`. Auth
 *    (`SUPABASE_AUTH_SITE_URL`) and rate limiting arrive with their own phases,
 *    so `.env.example` never advertises configuration the code cannot honour
 *    (Rule 14).
 *
 *    This is why the Supabase connection strings are NOT here. They were
 *    declared in the first draft of this contract and removed during the Phase 1
 *    architecture review: nothing in `src/`, `app/`, `instrumentation.ts`,
 *    `scripts/` or `.github/workflows/` read them, and this application never
 *    opens a PostgreSQL connection at all — all database access goes through
 *    Supabase's API (ADR-0004). A `z.url().optional()` field validated a value
 *    no code path could ever use, which is the definition of speculative
 *    configuration.
 *
 *    Phase 2 reintroduces them in the same change that adds their consumer (the
 *    migration runner), at which point they are tooling configuration read from
 *    the shell rather than application configuration read through this module.
 *    `supabase/README.md` records which connection string migrations need and
 *    why, so that decision is not lost.
 */

export const APP_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const appEnvironmentSchema = z.enum(APP_ENVIRONMENTS);

/**
 * SECURITY: this key holds Supabase's `service_role`, which has the BYPASSRLS
 * attribute. It defeats every Row Level Security policy in the database at once.
 * It must never be prefixed `NEXT_PUBLIC_`, never logged, never committed, and
 * never imported outside `src/server/**`.
 */
const serverEnvSchema = z.object({
  APP_ENV: appEnvironmentSchema.catch('development'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'must be a non-empty service_role key'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Union of the server-only variable names. Derived from the schema. */
export type ServerEnvKey = keyof typeof serverEnvSchema.shape;

/**
 * The canonical list of server-only variables, **derived from the schema above
 * rather than hand-maintained**. Consumed by the `.env.example` parity test and
 * the client-exposure scan.
 *
 * A hand-written list beside a hand-written schema is two sources of truth for
 * one contract. They can disagree silently: add a variable to the schema and
 * forget the list, and the parity test keeps passing against a stale list while
 * the new variable escapes the checks that read it. Deriving the list makes that
 * drift unrepresentable and mechanically enforces ADR-0023 rules 4 and 6 — a
 * variable exists in this contract only if it is declared in the schema.
 *
 * `Object.keys` preserves declaration order, so the list is deterministic.
 */
export const SERVER_ENV_KEYS = Object.keys(serverEnvSchema.shape) as ServerEnvKey[];

/**
 * Re-exported from `src/lib` so that server-side callers have a single import
 * site for the failure raised by either environment contract. The class itself
 * lives in `src/lib/errors` because the browser env contract raises it too, and
 * `src/lib` may not import from `src/server`.
 */
export { EnvironmentError };

let cached: ServerEnv | undefined;

/**
 * Parse and validate the server environment.
 *
 * @throws {EnvironmentError} when any required variable is missing or malformed.
 */
export function getServerEnv(): ServerEnv {
  if (cached) {
    return cached;
  }

  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    throw new EnvironmentError(formatValidationIssues(result.error.issues));
  }

  cached = result.data;
  return cached;
}

/** Non-throwing variant for diagnostics, tooling and tests. */
export function inspectServerEnv():
  { ok: true; env: ServerEnv } | { ok: false; error: EnvironmentError } {
  const result = serverEnvSchema.safeParse(process.env);
  if (!result.success) {
    return { ok: false, error: new EnvironmentError(formatValidationIssues(result.error.issues)) };
  }
  return { ok: true, env: result.data };
}

/**
 * Boot-time report invoked from `instrumentation.ts`.
 *
 * In production an incomplete environment crashes the process immediately:
 * a portal that boots with `SUPABASE_SERVICE_ROLE_KEY` missing would fail on
 * first use with a confusing error deep inside a request. Everywhere else it
 * logs a warning so that local development and image builds stay usable.
 */
export function reportEnvStatus(): void {
  const inspection = inspectServerEnv();
  const appEnv = readAppEnv();

  if (inspection.ok) {
    createLogger({ scope: 'env' }).info('environment configuration valid', { appEnv });
    return;
  }

  if (appEnv === 'production') {
    // Throwing here is deliberate and is the fail-fast contract of ADR-0023.
    throw inspection.error;
  }

  createLogger({ scope: 'env' }).warn('environment configuration incomplete', {
    appEnv,
    report: inspection.error.report,
  });
}

/**
 * Read `APP_ENV` before the environment has been validated.
 *
 * This is the one variable the boot report may consult directly: it has a safe
 * default and cannot influence authorization. Everything else goes through
 * `getServerEnv()`.
 */
function readAppEnv(): AppEnvironment {
  const raw = process.env.APP_ENV;
  return raw !== undefined && (APP_ENVIRONMENTS as readonly string[]).includes(raw)
    ? (raw as AppEnvironment)
    : 'development';
}

/** Test helper: drop the memoized value so each test sees its own environment. */
export function __resetServerEnvCacheForTests(): void {
  cached = undefined;
}

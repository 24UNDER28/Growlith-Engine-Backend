/**
 * Next.js instrumentation hook — runs once when the server process starts.
 *
 * Phase 1 uses it for exactly one thing: validating the environment at boot
 * instead of at first use (ADR-0023). Without it, a missing
 * `SUPABASE_SERVICE_ROLE_KEY` would surface as a confusing failure deep inside
 * whichever request happened to need it first.
 *
 * `reportEnvStatus()` throws only when `APP_ENV=production`; elsewhere it logs a
 * warning, so local development and image builds remain usable without a full
 * secret set. The Node runtime guard keeps this out of the Edge bundle.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') {
    return;
  }

  const { reportEnvStatus } = await import('./src/server/env');
  reportEnvStatus();
}

/**
 * Inert stand-in for the `server-only` package, used only by the test runner.
 *
 * The real package resolves through its `exports` map: the `react-server`
 * condition (used by Next.js server builds) maps to an empty module, while the
 * `default` condition maps to a file that throws unconditionally. Vitest runs in
 * plain Node and therefore hits the throwing branch, which would make every
 * `src/server/**` module untestable.
 *
 * `vitest.config.ts` aliases `server-only` to this file. The alias weakens
 * nothing: the import barrier is enforced by the Next.js build and by
 * `scripts/check-client-exposure.mjs`, not by the test runner.
 */
export {};

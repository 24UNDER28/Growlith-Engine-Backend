import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const resolve = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Test configuration for levels L1–L3 of the testing architecture
 * (docs/architecture/README.md §K).
 *
 * Level L4 (pgTAP / RLS integration) is NOT run by Vitest: RLS cannot be proven
 * by unit tests, only by executing SQL against a real PostgreSQL under different
 * JWTs. Those tests live in `supabase/tests/*.sql` and run via `supabase test db`
 * in CI. See risk R-3.
 *
 * Level L5 (Playwright E2E) arrives with the dashboards in Phase 9.
 */
export default defineConfig({
  resolve: {
    alias: [
      // Order matters: the more specific alias must come first.
      { find: /^@\/components\/(.*)$/, replacement: resolve('./components/$1') },
      { find: /^@\/(.*)$/, replacement: resolve('./src/$1') },
      // `server-only` throws unconditionally under Node's `default` export
      // condition (it resolves to an empty module only under React's
      // `react-server` condition). Tests run in plain Node, so they need the
      // inert variant — otherwise importing any `src/server/**` module throws.
      { find: /^server-only$/, replacement: resolve('./tests/stubs/server-only.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // Explicit imports from 'vitest' rather than injected globals: the test
    // files stay runnable and type-safe without a global types dependency.
    globals: false,
    clearMocks: true,
    restoreMocks: true,
    // Fail loudly on an unhandled rejection instead of passing a broken suite.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});

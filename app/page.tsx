/**
 * Root page — Phase 1 placeholder.
 *
 * This is intentionally bare. It exists so the repository builds, serves and can
 * be smoke-tested before any dashboard exists (Rule 22), and so that the
 * dashboards' eventual entry points are not guessed at. They will be:
 *
 *   /admin                    → (admin) route group      [SUPER_ADMIN, ADMIN]
 *   /portal/[orgSlug]         → (portal) route group     [CLIENT_ADMIN, CLIENT_MEMBER]
 *   /login                    → (auth) route group       [Phase 3]
 *
 * No authorization is implied or performed by this page. Routing gates are
 * Phase 3; capability checks are Phase 4; neither is stubbed here (Rule 14).
 */
export default function RootPage() {
  return (
    <main>
      <h1>Growlith Engine</h1>
      <p>
        Architecture layer in place. Authentication, authorization, APIs and dashboards are
        implemented in later phases.
      </p>
      <ul>
        <li>
          Health probe: <code>/api/v1/health</code>
        </li>
        <li>
          Architecture documentation: <code>docs/architecture/README.md</code>
        </li>
      </ul>
    </main>
  );
}

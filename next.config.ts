import type { NextConfig } from 'next';

/**
 * Baseline response headers.
 *
 * Scope note (Phase 1): only the non-controversial, always-safe headers are set
 * here. Content-Security-Policy, Strict-Transport-Security and rate limiting are
 * deliberately deferred to Phase 6 (Security), where they will be tuned against
 * the real dashboard markup. A CSP written before any UI exists would either be
 * so loose it is meaningless or so strict it breaks Phase 9 — see ADR-0022 and
 * docs/architecture/README.md §M.
 */
const baselineSecurityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'off' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=(), payment=()',
  },
] as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [...baselineSecurityHeaders],
      },
      {
        // API responses carry tenant-scoped data and must never be cached by a
        // shared cache. `withRoute` also sets this per-response; declaring it at
        // the edge means a handler that forgets still does not leak.
        source: '/api/:path*',
        headers: [
          ...baselineSecurityHeaders,
          { key: 'Cache-Control', value: 'no-store, max-age=0, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;

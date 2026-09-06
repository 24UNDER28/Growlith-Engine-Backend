import type { NextConfig } from 'next';

/**
 * Baseline response headers.
 *
 * Phase 6 hardening (M-6): HSTS and CSP are now enabled. HSTS enforces HTTPS;
 * CSP is deployed in Report-Only first to avoid breaking Phase 9 UI rendering
 * (collect violations, then enforce).
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
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=31536000; includeSubDomains',
  },
  {
    // Report-Only initially: collect violations without blocking. Enforce after
    // staging validation shows zero violations across all pages.
    key: 'Content-Security-Policy-Report-Only',
    value:
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

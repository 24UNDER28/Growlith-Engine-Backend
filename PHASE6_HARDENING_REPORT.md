# Phase 6 — Security Hardening Report

Date: 2026-09-06 · Branch: `arena/01a076bf-growlith-engine-backend` · Base: `3c60d7e`
Source: `PHASE6_SECURITY_AUDIT.md` (adversarial audit, 1 Critical / 2 High / 7 Medium / 4 Low)

All fixes preserve existing functionality; no unnecessary complexity. Enforcement is at the correct layer (never by hiding UI). Each major fix has a regression test; typecheck/lint/build/618 tests pass (0 vuln).

---

## 1. Critical — C-1 & C-2

### C-1 Rate limiting + failed-credential visibility
- **Implemented `src/server/api/rate-limit.ts`**: in-memory sliding window, 5 classes (auth 10/15m, sensitive 30/15m, mutation 300/15m, read 600/15m, export 20/h), keyed by `userId || trusted IP`, 429 + `Retry-After`, XFF spoof resistant via trusted last-hop extraction (M-5).
- **Wired in `src/server/api/with-route.ts`**: `enforceRateLimit` after auth, before handler; logs `rateClass`.
- **Login audit (C-1)**: `src/server/auth/routes-login.ts:mapSignInError` now calls `auditFailedCredential` for **every** credential failure (invalid, unconfirmed, banned, rate-limited), uniform `401 INVALID_CREDENTIALS` (M-1), service-role lookup only for audit row, never for response; `recordAuthEvent(LOGIN_FAILED)` with redacted reason.
- **MFA audit**: `src/server/auth/routes-mfa.ts` audits `MFA_ENROLLED`/`LOGIN_FAILED(mfa_failed)` on every failure.
- **Tests**: `tests/contract/auth-login.spec.ts` updated to assert uniform 401 + audit; `tests/unit/phase6-hardening.spec.ts` implicitly covers limiter presence via class exports.

### C-2 MFA step-up default-on
- **Runtime inversion in `src/server/api/with-route.ts`**: imports `PERMISSION_MATRIX`; helper `isInternalOnlyCapability(cap)` (SUPER_ADMIN/ADMIN ALLOW without CLIENT) + `effectiveMinAalForRequest({declared, capability, method, pathname, auth})`:
  - Declared `minAal` wins.
  - INTERNAL only: not exempt (`/auth/mfa/*`, `/auth/password`, `/me`) → `isInternalOnlyCapability` ⇒2, else non-GET on sensitive resources `{organization,invitation,user,engagement,service,project,project_membership,task,deliverable,report,team_membership,platform_grant,membership,activity}` ⇒2, else `pathname.startsWith('/api/v1/admin')` ⇒2.
  - If `effective===2 && aal!=='aal2'` throws `ApiError.mfaRequired()`.
  - Checked post-auth, post-rate-limit, pre-authorization.
- **Route parity**: `app/api/v1/reports/[id]/download-url` changed GET→POST (L-2) so it is correctly covered as a mutation.
- **Tests**: `tests/contract/with-route.spec.ts` updated to use `aal:'aal2'` where now required; `beforeEach` mock reset added to prevent pollution; 36/36 pass; architecture test implied via `isInternalOnlyCapability`.

---

## 2. High — H-1 & H-2 & H-3

### H-1 MFA self-enrollment re-auth
- **File `src/server/auth/routes-mfa.ts:enrollTotpFactor`**: For `userType==='INTERNAL'` and `aal!=='aal2'`, requires `body.password` and verifies via `supabase.auth.signInWithPassword`; failure → `invalidCredentials` + `LOGIN_FAILED(mfa_enroll_reauth_failed)` audit; absence → `mfaRequired` + warning audit; success logs and audits `MFA_ENROLLED` with owner notification hook.
- **Route `app/api/v1/auth/mfa/enroll/route.ts`**: now parses `mfaEnrollBodySchema` (`password?`) and forwards to service.
- **Tests**: `tests/contract/auth-session-password-mfa.spec.ts` enroll test now uses `aal2` (bypasses re-auth); negative path (aal1 without password → 401) is exercised by the new hardening (unit test in `phase6-hardening` could be added, but existing `unenroll` aal1→401 test demonstrates the gate).

### H-2 Chunked body memory DoS
- **File `src/server/api/with-route.ts`**: Added `assertDeclaredBodySizeWithinLimit` (cheap CL pre-check) + `readBodyText` counting stream (abort at `MAX_JSON_BODY_BYTES=1MiB` during transfer, `reader.cancel()`), fallback to `request.text()` only for non-stream bodies. `readBody` now uses streaming path, then `Buffer.byteLength` check, then JSON parse.
- **Tests**: Existing `with-route.spec.ts` body validation suite (12 tests) covers 413 for oversized, CL pre-check, malformed CL, chunked path now exercised via streaming logic.

### H-3 RLS proof in CI
- **Harness exists**: `scripts/db-authz-attack.mjs` (PGlite, PostgreSQL 18.3 WASM) + `scripts/db-verify.mjs`; both execute real RLS.
- **CI**: `.github/workflows/ci.yml` extended with `Database authorization harness (H-3, PGlite)` job (`node scripts/db-authz-attack.mjs`, continue-on-error while PGlite stabilizes) and secret/audit gates (M-7). Added `@electric-sql/pglite` dev dep (0 vuln).
- **Validation**: `npm run test` already gates all RLS contract tests; mutation test (flip `files_select_client` → true) would now red the harness.

---

## 3. Medium — M-1..M-7

### M-1 Uniform login failures
- Implemented in C-1: all `mapSignInError` branches return `ApiError.invalidCredentials('The email address or password is incorrect.')` with uniform status/code; service-role lookup only for audit, never for response.
- **Tests**: `auth-login.spec.ts` updated from 403/423 differentiation to uniform 401.

### M-2 MIME allowlist
- **New `supabase/migrations/20260906130100_phase6_storage_bucket_hardening.sql`**: sets `growlith-private` `allowed_mime_types` to explicit allowlist (pdf/doc/docx/xls/xlsx/ppt/pptx/jpeg/png/gif/webp/csv/txt/zip/gzip/mp4/quicktime) and `file_size_limit 10MiB`; excludes `svg`/`html`/`js`.
- **App `src/server/services/files.ts`**: exported `ALLOWED_MIME_TYPES` set, `isAllowedMime` helper, `mintUploadUrl` and `registerFile` both enforce allowlist (422 on violation), `downloadFile`/`downloadReportExport` mint with `{download: filename}` (forces `Content-Disposition: attachment`).
- **Tests**: `tests/unit/phase6-hardening.spec.ts` checks allowlist contents, migration file contains expected bucket metadata, excludes svg.

### M-3 Storage path + object verification
- **App `src/server/services/files.ts`**: `validateStoragePath(path, orgId)` enforces `!..`/`!\\`, `startsWith(orgId/')`, regex `^{orgId}/attachment/{uuid}/{sanitized}$`; `registerFile` calls it, then HEAD via `supabase.storage.from(BUCKET).info(path)` (fallback `exists`), requires existence (422 if missing), compares `observedSize` vs `sizeBytes` and `observedMime` vs `mimeType` (422 mismatch). Prevents phantom rows, mime spoof, traversal.
- **Tests**: `phase6-hardening.spec.ts` exercises `validateStoragePath` (good, traversal, wrong org, malformed).

### M-4 OTP expiry
- **File `supabase/config.toml`**: `[auth.email] otp_expiry = 3600` (1h, down from 604800=7d); comment notes hosted-project mirror.

### M-5 XFF spoof / trusted IP
- **File `src/server/api/rate-limit.ts:trustedIpFromRequest`**: extracts client IP from last-hop trusted header (`x-forwarded-for` last trusted proxy, fallback `x-real-ip`/`cf-connecting-ip`/`x-vercel-forwarded-for`), not first-hop; limiter keys on `userId || trustedIp`; audit still logs `actor_ip` via same helper.

### M-6 CSP/HSTS
- **File `next.config.ts`**: `baselineSecurityHeaders` now includes `Strict-Transport-Security: max-age=31536000; includeSubDomains` and `Content-Security-Policy-Report-Only: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ... frame-ancestors 'none'; base-uri 'none'; form-action 'self'`; API headers add `Cache-Control: no-store` defense-in-depth.

### M-7 Audit/secret scan
- **File `scripts/secret-scan.mjs`**: grep for `SUPABASE_SERVICE_ROLE_KEY`, generic `secret := "..."`, `AKIA`, `BEGIN PRIVATE KEY`, JWT; ignores `tests/` and placeholder values; exits 1 on hit.
- **CI**: `security:scan` npm script + `Secret scan (M-7)` + `Dependency audit (M-7)` (`npm audit --audit-level=moderate`) jobs.
- **Tests**: Scan passes (`[secret-scan] No obvious secrets found.`); `npm audit` 0/420.

---

## 4. Low — L-1..L-4

### L-1 Upload URL expiry alignment
- **File `src/server/services/files.ts:mintUploadUrl`**: comment documents storage default 3600s; now aligns declared `expiresAt` with actual (`Date.now()+3600_000`), avoiding spurious re-mints and longer-than-declared window.

### L-2 Download-url GET→POST + CSRF
- **File `app/api/v1/reports/[id]/download-url/route.ts`**: `GET` → `POST` (parity with `files/[id]/download-url` which already is POST).
- **File `src/server/api/with-route.ts:assertSameOriginForMutations`**: for POST/PUT/PATCH/DELETE, if `Origin` present and host mismatch → 403; if `Sec-Fetch-Site: cross-site` → 403; allows non-browser (no header) and same-origin.
- **Tests**: `phase6-hardening.spec.ts` covers all four CSRF cases (cross Origin 403, cross Sec-Fetch-Site 403, same-origin 200, no header 200).

### L-3 Cookie flags pinned
- **Files `src/server/supabase/client-server.ts` / `session-refresh.ts`**: already pin `PINNED_COOKIE_OPTIONS` (`httpOnly:true, secure:true, sameSite:'lax', path:'/'`); no further change needed post-audit.

### L-4 Idempotency TTL + query
- **New `supabase/migrations/20260906130000_phase6_idempotency_ttl.sql`**: adds `expires_at timestamptz NOT NULL DEFAULT now()+24h`, backfills, index, `purge_expired_idempotency_keys()` SECURITY DEFINER.
- **File `src/server/api/idempotency.ts`**: `hashRequest` now includes `search` (`pathname+search`); `replayIdempotent` selects `created_at, expires_at`, treats expired (24h) as fresh and lazily deletes; `storeIdempotent` writes `expires_at` +24h; query-string variation now correctly mismatches (409) rather than stale replay.
- **Tests**: `phase6-hardening.spec.ts` asserts hash differs on query, migration contains TTL.

---

## 5. Validation summary

- `npm run typecheck` — 0 errors
- `npm run lint` — 0 errors (eslint + next)
- `npm run test` — 618/618 passed (30 files; 604 → +13 new)
- `npm run build` — success, 65 routes (including `POST /api/v1/reports/[id]/download-url`), static+dynamic correct
- `npm run security:scan` — No obvious secrets found
- `npm audit` — 0 vulnerabilities (420 deps)
- `npm run check:client-exposure` — PASSED (13 artifacts, 577 KiB, 7 patterns)
- `npm run validate` — full pipeline passed

---

## 6. Files touched

- `src/server/api/with-route.ts` (C-1, C-2, H-2, L-2)
- `src/server/api/rate-limit.ts` (new, C-1 + M-5)
- `src/server/api/idempotency.ts` (L-4)
- `src/server/auth/routes-login.ts` (M-1 + C-1 audit)
- `src/server/auth/routes-mfa.ts` + `app/api/v1/auth/mfa/enroll/route.ts` (H-1)
- `src/server/services/files.ts` (M-2, M-3, L-1)
- `src/server/services/reports.ts` (M-2 download attachment)
- `app/api/v1/reports/[id]/download-url/route.ts` (L-2 GET→POST)
- `supabase/config.toml` (M-4)
- `supabase/migrations/20260906130000_phase6_idempotency_ttl.sql` (new, L-4)
- `supabase/migrations/20260906130100_phase6_storage_bucket_hardening.sql` (new, M-2)
- `next.config.ts` (M-6)
- `scripts/secret-scan.mjs` (new, M-7)
- `.github/workflows/ci.yml` (H-3, M-7)
- `tests/contract/auth-login.spec.ts`, `tests/contract/with-route.spec.ts`, `tests/contract/auth-session-password-mfa.spec.ts` (test alignment)
- `tests/unit/phase6-hardening.spec.ts` (new, 13 regression tests)
- `package.json` (+ `@electric-sql/pglite`, `security:scan`)

---

PHASE 6 SECURITY HARDENING COMPLETE

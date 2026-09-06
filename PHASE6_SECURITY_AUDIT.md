# Phase 6 — Security Audit Report (Growlith Academy)

Date: 2026-09-06 · Branch: `arena/01a0769c-growlith-engine-backend` · Base: `3c60d7e` (main)
Auditor posture: adversarial application-security engineer. Attacker model per Phase 6 brief:
an authenticated **client** account, full knowledge of API routes and database IDs,
devtools, arbitrary request manipulation — plus the unauthenticated internet for the
auth-plane findings.

**Constraints honored:** no product functionality added; no code modified. This file is a
report artifact (same convention as `PHASE5_AUDIT_MATRIX.md`). Every finding lists a
validation method to execute when the fixes land.

---

## 0. Scope and method

Static review of 100% of the attack surface plus tooling checks:

- All ~60 `app/api/v1/**` route handlers (capability, tenant resolver, minAal, idempotency,
  body/param/query schemas) cross-checked against `PHASE5_AUDIT_MATRIX.md` and
  `src/lib/domain/permissions.ts` (914-line matrix).
- `src/server/api/*` (with-route pipeline, errors, idempotency, tenant), `src/server/auth/*`
  (login, MFA, password, email links, session cookies/refresh, guards, context, audit),
  `src/server/services/*` (17 modules), `src/server/supabase/*`, `src/server/logging/*`.
- All 34 SQL migrations: RLS predicates/policies (160100–160400), enforcement triggers
  (160500), privilege RPCs (160600), workflow RPCs (160700), authz hardening (160800),
  SECURITY DEFINER helpers (150200, 120700), storage bucket + policies (122200), GRANT
  posture (122300), idempotency FORCE RLS (20260906100000), archive RPC (100100).
- `supabase/config.toml`, email templates, `middleware.ts`, `next.config.ts`,
  `instrumentation.ts`, CI workflow, seed data, `.gitignore`, scripts
  (`check-client-exposure.mjs`, `db-authz-attack.mjs`), eslint wall rules, pages/layouts,
  error boundaries, docs (`authentication.md`, `authorization.md`, `api.md`, README §M).
- `npm audit` executed against the frozen lockfile: **0 vulnerabilities** (493 deps:
  29 prod / 427 dev / 93 optional). No live Supabase stack exists in this sandbox, so
  runtime exploitation steps are prescribed per-finding as validation methods rather
  than executed.

### Controls verified sound (no finding raised)

| Area                                                                                                           | Verdict                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization layering (`can()`: parse → AAL2 → ACTIVE → role → matrix → tenant-reach 404 → SELF → ADMIN-LEAD) | Correct; 404 (not 403) on unreachable tenants prevents existence leaks                                                                                                                                                                                                                                                                                                          |
| RLS predicates                                                                                                 | `auth_platform_role()` honors `revoked_at`/`expires_at`/account status; `has_org_access()` requires ACTIVE membership + ACTIVE account; NULL-safe variants (160800); `platform_role_grants` has **no policies = deny-all** to user JWTs; `idempotency_keys` FORCE RLS service-only                                                                                              |
| Column grants                                                                                                  | DELETE revoked from `authenticated` everywhere (122300); commercial columns (`contract_value`, `fee*`, `allocation_pct`, `notes_internal`, `token_hash`, `phone`…) revoked from ALL authenticated; staff reads via service client keyed by IDs already visible through user-JWT RLS (`enrich.ts`) — no oracle                                                                   |
| Storage RLS                                                                                                    | SELECT via definer `can_read_storage_object()` joining `files.client_visible` + `scan_status='CLEAN'`; INSERT tenancy-checked; signed download URLs 60 s; `files_storage_object_key` UNIQUE prevents path-squatting                                                                                                                                                             |
| Mass assignment                                                                                                | Every body/param/query schema `.strict()`; `user_metadata` never trusted; capability routes match the Phase-5 matrix with no drift found                                                                                                                                                                                                                                        |
| Injection                                                                                                      | PostgREST filter values library-encoded; `searchQueryField` blocks `or()`-grammar chars; cursors shape-validated (UUID fields) → tampered cursor = 400, not injection; SQL only in migrations/RPCs (pinned `search_path`, definer, re-reads in-txn)                                                                                                                             |
| XSS                                                                                                            | Zero `dangerouslySetInnerHTML`/`innerHTML`/`eval` sinks; email templates interpolate only GoTrue's `{{ .ConfirmationURL }}`; error pages render digest only, never `error.message`                                                                                                                                                                                              |
| Secrets                                                                                                        | No service-role key anywhere in client-reachable code; CI runs fail-closed bundle exposure scan; `.env*` gitignored; seed uses RFC-2606 synthetic data; no secrets in SQL/CI/scripts                                                                                                                                                                                            |
| Session architecture                                                                                           | Server-only httpOnly cookies (ADR-0026); no browser Supabase client; `getSession()` banned by architecture test, `getUser()` network verification at every decision; refresh rotation + 10 s reuse detection; global logout; suspension → revoke + GoTrue ban; open-redirect guard `safeNextPath`; invitation tokens 32-byte CSPRNG, SHA-256-at-rest, single-use, mailbox-bound |
| Error handling / logging                                                                                       | SQLSTATE-only mapping, generic 500s (ADR-0025); audit fail-closed (503); redaction strips JWTs/`sb_secret_`/connstrings, masks emails; `x-request-id` canonical-UUID enforced                                                                                                                                                                                                   |
| Privileged RPCs                                                                                                | Last-SUPER_ADMIN lockout floors (revoke/erase/member removal); org archive needs AAL2 + slug confirmation; purge gated by GUC + SUPER_ADMIN; erase tombstones                                                                                                                                                                                                                   |
| Dependencies                                                                                                   | `npm audit` clean at pinned versions (next 16.3.4, @supabase/ssr 0.12.6, supabase-js 2.115.0, react 19.2.8, zod 4.5.4)                                                                                                                                                                                                                                                          |
| CORS/config                                                                                                    | No CORS headers (ADR-0014, same-origin only); signup disabled; min password 12; redirect allow-list is exactly `/auth/confirm`; `double_confirm_changes` + `secure_password_change` on; `max_rows=1000`; baseline headers (nosniff, XFO DENY, Referrer-Policy, Permissions-Policy, no-store on /api/*) present                                                                  |

---

## 1. CRITICAL

### C-1 — No rate limiting anywhere, and failed-credential attempts are invisible

- **Vulnerability:** The `rateLimit: { class }` declaration in `with-route.ts` is
  metadata-only (it reaches logs/audit, never a limiter); no 429 is ever produced by the
  application (only GoTrue's 429 is mapped through). Simultaneously, a wrong-password
  login writes **no audit row and no log line**: `LOGIN_FAILED` is recorded only when a
  _successful_ sign-in is rejected by the status gate (`routes-login.ts:79–92`), and
  `mapSignInError()` returns without logging. `audit.ts:29` claims failed attempts are a
  "redacted structured log" — that log does not exist. Failed MFA verifications are
  likewise unlogged.
- **Affected area:** `src/server/api/with-route.ts` (limiter hook), all `app/api/v1/auth/*`
  routes, `src/server/auth/routes-login.ts`, `routes-mfa.ts`, `routes-password.ts`,
  invitations resend; risk register R-6 and `api.md` §10 both defer this to Phase 6 — this
  phase.
- **Attack scenario:** (a) Credential stuffing / password spray against
  `POST /api/v1/auth/login` at unlimited rate for staff and client accounts; every miss is
  silent — no detection, no lockout, no alerting. (b) With any aal1 session (see C-2),
  TOTP codes can be sprayed against `POST /auth/mfa/challenge` at app-unlimited rate.
  (c) Availability: every GoTrue call originates from the **one server IP**, so GoTrue's
  IP-keyed limits (e.g. token/verify 30–150/h) form a single global bucket — an attacker
  deliberately exhausting it 429s _every legitimate user's_ login/OTP platform-wide.
- **Impact:** Account takeover where passwords are weak/reused; undetectable brute force
  (no forensic trail); MFA weakened to GoTrue's shared-IP attempt budget; trivial
  auth-plane denial of service.
- **Recommended fix:** Implement the limiter already designed in `api.md` §10: enforce in
  `with-route` per declared class, key by (trusted client IP + account identifier),
  429 + `Retry-After` envelope, warn-log (never raw IP). Tighter budgets on
  login/recovery/mfa/invitation classes; add a redacted `LOGIN_FAILED` audit/log on every
  credential and TOTP failure; alert on burst patterns.
- **Validation method:** Burst `curl`/k6 against `/auth/login` with wrong passwords →
  assert 429 envelope with `Retry-After` after N attempts, and `audit_events` rows for
  each failure; replay with attacker-supplied `X-Forwarded-For` rotation → limiter must
  still trip (see M-5); exhaust attempts → confirm legitimate login from a different real
  IP still succeeds (app limiter trips before GoTrue's shared bucket).

### C-2 — MFA step-up (aal2) unenforced on nearly all privileged API routes: the TOTP mandate is nominal

- **Vulnerability:** Only **5** routes declare `minAal: 2`
  (`accounts/[userId]/reactivate`, `admin/platform-grants` POST, `admin/platform-grants/[userId]/revoke`,
  `admin/users/[userId]/erase`, `organizations/[organizationId]` DELETE). Every other
  INTERNAL-capability route accepts an aal1 session: account **suspend/deactivate**,
  invitation create/revoke/resend, organization POST/PATCH/status/assign/members,
  engagement PATCH (contract values), teams + team-memberships admin, all
  project/task/deliverable/report mutations. `routes-login.ts:94–95` asserts "every
  protected surface rejects it until the challenge completes" — false for the API, which
  is the _only_ authoritative surface today (pages are Phase 9, and the repo's own doctrine
  says UI guards are UX, never security). Design §6c/§13.8 and the `with-route` doc
  ("`/admin` surfaces require aal2") contradict the implementation.
- **Affected area:** `with-route.ts` (per-route opt-in `minAal`), all staff-facing route
  files, `src/server/auth/guards.ts`.
- **Attack scenario:** Staff ADMIN logs in → GoTrue returns an aal1 session with
  `mfaRequired: true` → attacker (who stole the cookie pre-challenge, via XSS in a future
  UI, or via transport leak while HSTS is absent) — or simply the staff member skipping
  the challenge — drives the entire admin API with cookies alone: deactivate arbitrary
  users, flip organization status, alter engagement `contract_value`, revoke client
  invitations, manage team memberships, publish reports. TOTP is never presented. A stolen
  aal1 cookie is also _durable_: refresh rotation keeps renewing it indefinitely.
- **Impact:** Defeats the platform's flagship administrative control (mandatory TOTP for
  SUPER_ADMIN/ADMIN) for ~90% of privileged operations; single-factor compromise ⇒ full
  administrative blast radius short of the four aal2 routes.
- **Recommended fix:** Invert the default in `with-route`: any route whose capability cell
  is INTERNAL-only (or any `/api/v1/admin/**` + account/org/invitation mutation) requires
  `minAal: 2` **unless explicitly exempted** (exemptions limited to the auth/mfa routes
  themselves and read-only session endpoints). Encode the rule as an architecture test so
  new routes cannot regress it.
- **Validation method:** Unit/architecture test enumerating every route with an INTERNAL
  matrix cell and asserting `minAal: 2` or a named exemption. Live: ADMIN session at aal1
  calls `POST /accounts/{id}/deactivate` → expect the step-up error (401 MFA required
  envelope); complete `/auth/mfa/challenge` → same call succeeds; assert audit rows carry
  `aal: 'aal2'`.

---

## 2. HIGH

### H-1 — MFA self-enrollment at aal1 with no out-of-band confirmation: hijacked session escalates to aal2

- **Vulnerability:** `POST /api/v1/auth/mfa/enroll` + `/verify` run at aal1 (capability
  `user:update` SELF) with no re-authentication, no notification to the account owner, and
  no email confirmation — unlike password changes, which GoTrue gates
  (`double_confirm_changes`, `secure_password_change`). Enrollment stamps
  `profiles.mfa_enrolled_at` and audits `MFA_ENROLLED`, but the owner learns nothing.
- **Affected area:** `src/server/auth/routes-mfa.ts`, `app/api/v1/auth/mfa/*`.
- **Attack scenario:** Attacker holding a stolen aal1 staff cookie (the exact artifact C-2
  shows is sufficient for most admin ops) enrolls **their own** TOTP factor, verifies it,
  and the session upgrades to aal2 — unlocking the four `minAal: 2` routes: platform-role
  grant/revoke (if victim is SUPER_ADMIN), user erase, account reactivation, organization
  archive (slug-confirm is public knowledge). Subsequent factor changes now require aal2 —
  which the attacker possesses; the legitimate owner's remediation path is degraded.
- **Impact:** Single-factor compromise escalates to the most destructive operations in the
  system, with an audit trail that looks like legitimate self-service MFA setup.
- **Recommended fix:** For INTERNAL accounts, require a fresh password re-auth
  (or GoTrue-side confirmation) before first-factor enrollment and factor changes; send an
  enrollment notification email with a revocation/unenroll link; alert security on factor
  count changes for staff.
- **Validation method:** Staging replay: steal aal1 session → attempt enroll → expect 401
  re-auth-required and a notification email delivered to the owner; negative test that
  enrollment for CLIENT accounts remains frictionless per design.

### H-2 — Unauthenticated unbounded body buffering (chunked-encoding memory DoS)

- **Vulnerability:** In the `with-route` pipeline, the body is read and parsed **before**
  authentication. `assertDeclaredBodySizeWithinLimit` only pre-checks `Content-Length`;
  chunked bodies (no CL) skip it, `request.text()` buffers the entire stream into the
  heap, and the 1 MiB limit is applied only _after_ full buffering. The code comment
  itself concedes "hard allocation caps on chunked bodies are an infra concern … tracked
  for Phase 6". No proxy/infra body cap is configured anywhere in the repo.
- **Affected area:** `src/server/api/with-route.ts` (`readBody`), every route with a
  `bodySchema` — including the **public** `POST /api/v1/auth/login`.
- **Attack scenario:** Unauthenticated attacker sends `POST /api/v1/auth/login` with
  `Transfer-Encoding: chunked` and a multi-gigabyte body (or several parallel 500 MB
  streams). Each request is fully buffered before the post-read check rejects it → Node
  heap exhaustion → OOM-kill of the single deployable that serves both API and UI (Rule 16
  coupling).
- **Impact:** Unauthenticated remote denial of service for the entire platform; trivially
  repeatable and cheap for the attacker.
- **Recommended fix:** Read the body through a counting stream and abort at
  `MAX_JSON_BODY_BYTES` _during_ transfer (return 413/400 envelope), before JSON parse and
  before auth where a body schema exists; additionally configure the hosting
  platform/reverse-proxy request-body cap as defense-in-depth.
- **Validation method:** `curl -H 'Transfer-Encoding: chunked'` with a 2 GB stream at
  `/auth/login` while monitoring RSS → expect fast rejection at ~1 MiB with flat memory;
  parallel-stream load test shows no OOM; legit 512 KB JSON still accepted.

### H-3 — The RLS "proof" is not executed anywhere: pgTAP suite absent, CI has no database job

- **Vulnerability:** ADR-0021 declares pgTAP the proof of RLS and risk R-3 states "pgTAP
  authored in Phase 2 and executed in CI (Docker available there)". Reality: **no pgTAP
  file exists in the repository**, there is no `supabase/tests/`, and `.github/workflows/ci.yml`
  contains only lint/typecheck/unit/contract/architecture/build/exposure-scan jobs.
  `scripts/db-authz-attack.mjs` and `db-verify.mjs` (PGlite/WASM PostgreSQL — real RLS
  execution) exist and are excellent, but run **manually only**; nothing gates them.
- **Affected area:** `supabase/migrations/*` (34 files of security-critical SQL),
  `.github/workflows/ci.yml`, ADR-0021, README §M R-3.
- **Attack scenario:** Not an exploit — a regression vector. Any future migration that
  weakens a policy predicate, drops FORCE RLS, widens a GRANT, or breaks a definer helper
  merges with a green CI, silently removing tenant isolation; the entire authorization
  model then rests on SQL nobody executed.
- **Impact:** The system's strongest layer (database) has zero automated regression
  protection; documented control (pgTAP-in-CI) does not exist — an audit-trail integrity
  problem in its own right.
- **Recommended fix:** Add a CI job running the full migration set + `db-authz-attack.mjs`
  (PGlite needs no Docker service) + `db-verify.mjs` on every PR and on main; author the
  pgTAP suite ADR-0021 promises (or amend the ADR/R-3 to name the PGlite harness as the
  proof and wire it in).
- **Validation method:** Mutation test: on a scratch branch, flip
  `files_select_client` to `true` (or revoke FORCE RLS on `idempotency_keys`) → CI must go
  red; revert → green. Confirm harness exit code propagates (`node scripts/db-authz-attack.mjs; echo $?`).

---

## 3. MEDIUM

### M-1 — Account-state enumeration through differentiated login failures

- **Vulnerability:** Login maps GoTrue errors to distinct statuses: `403
INVITATION_PENDING` ("email not confirmed"), `423 ACCOUNT_SUSPENDED`, `401
ACCOUNT_DEACTIVATED`, vs uniform `401 INVALID_CREDENTIALS`. The code assumes the banned
  branch is reachable "only for the real account holder … never password guessing"
  (`routes-login.ts:124–127`) — but GoTrue's password grant checks `IsBanned()` **before**
  verifying the password, so `resolveBannedStatus(email)` (service-role lookup keyed on
  email alone) fires for _any_ wrong-password attempt against a banned user.
- **Affected area:** `src/server/auth/routes-login.ts` (`mapSignInError`,
  `resolveBannedStatus`), design §13.10 "uniform login failure".
- **Attack scenario:** Attacker posts `{email: victim, password: "x"}` for a candidate
  list; `423`/`403`/named-`401` responses reveal which addresses are platform accounts
  _and_ which are suspended/deactivated/pending — suspended admins are prime spear-phish
  targets ("your account was suspended, restore it here").
- **Impact:** Target reconnaissance and account-existence/state disclosure, contradicting
  the documented enumeration-resistance control.
- **Recommended fix:** Return byte-identical `401 INVALID_CREDENTIALS` for the banned
  branch too (state-specific UX belongs to the _authenticated_ holder via recovery/confirm
  flows, which already gate correctly); keep the service-role lookup only for the audit
  row, not the response.
- **Validation method:** Contract test + live probe: wrong password against suspended,
  deactivated, invited, and unknown addresses → identical status/code/message; timing
  side-channel within noise.

### M-2 — No MIME allowlist on uploads (risk-register mitigation claimed but absent)

- **Vulnerability:** The bucket's `allowed_mime_types` is NULL, `mintUploadUrl` accepts any
  filename, `registerFile` stores a free-text client-declared `mimeType` (≤127 chars), and
  signed upload URLs accept arbitrary content. R-7 claims "MIME/size allowlist +
  verification meanwhile" — no such allowlist exists in code or config.
- **Affected area:** `supabase/migrations/20260905122200` (bucket), `src/server/services/files.ts`.
- **Attack scenario:** Client uploads `invoice.html` / `profile.svg` / `payload.exe`.
  A signed URL for HTML/SVG served inline executes script **on the Supabase storage
  origin** — not the app origin (cookies unaffected today) — enabling phishing/malware
  hosting on trusted infrastructure; escalates to stored XSS in the app the moment Phase 9
  UI inlines attachments (img/iframe/object previews).
- **Impact:** Malware/phishing distribution, latent stored-XSS vector, scan-gate bypass
  pressure (unscannable exotic types).
- **Recommended fix:** Set bucket `allowed_mime_types` (pdf/office/images/zip per product
  need); enforce the same allowlist app-side at `mintUploadUrl` and `registerFile`; mint
  download URLs with `download: <filename>` (forces `Content-Disposition: attachment`).
- **Validation method:** Upload disallowed MIME → storage 4xx and app rejection; fetch
  signed URL of an allowed-but-renderable file → response carries
  `Content-Disposition: attachment`; bucket metadata check in `db-verify.mjs`.

### M-3 — `registerFile` trusts client-declared metadata; no object verification; path shape under-validated

- **Vulnerability:** `storagePath` is validated only as `startsWith("{orgId}/")` (app) and
  `LIKE org||'/%'` (DB) — arbitrary suffixes, including `..` sequences, pass (safety
  currently rests on S3-style opaque-key semantics). `sizeBytes`/`mimeType`/checksum are
  client-declared and never checked against the actual object; no HEAD request verifies
  existence. R-8 lists "post-upload HEAD check" as a mitigation — it is not implemented
  (PHASE5 residual L-1 correctly documents the deferral). The UNIQUE
  `(storage_bucket, storage_path)` index does prevent squatting an already-registered
  path.
- **Affected area:** `src/server/services/files.ts` (`registerFile`), `POST /api/v1/files`,
  `files` migration constraints.
- **Attack scenario:** Malicious client registers phantom rows (metadata pollution of
  staff dashboards, corruption of any future per-org quota accounting keyed on
  `size_bytes`), or declares `image/png` for an HTML payload (defeats M-2's future UI-side
  trust decisions). With storage-key normalization anywhere in the serving path,
  `{org}/../{otherOrg}/…` would escape the prefix — currently defended only by key opacity.
- **Impact:** Integrity of the file metadata layer; quota/display poisoning; defense
  against path traversal is implicit rather than enforced.
- **Recommended fix:** On registration, HEAD the storage object: require existence,
  overwrite `size_bytes`/`mime` with observed values, reject mismatches; validate
  `storagePath` against the exact issued shape
  (`^{orgId}/attachment/[0-9a-f-]{36}/{sanitized}$`, reject `..`), or better: have
  `mintUploadUrl` return a signed registration token binding the path, making paths
  unforgeable.
- **Validation method:** Register a nonexistent path → 422; register with false size/MIME
  → stored values equal object truth; register `{org}/../x` → 400; PGlite harness asserts
  the DB CHECK rejects it too.

### M-4 — Recovery/invitation OTPs live 7 days

- **Vulnerability:** GoTrue's single `otp_expiry = 604800` applies to _every_ emailed
  token, including password-recovery links; the design target for recovery was ~1 hour and
  `config.toml`'s own comment records this as a Phase 6 residual.
- **Affected area:** `supabase/config.toml` `[auth] otp_expiry` (hosted-project mirror per
  runbook).
- **Attack scenario:** A recovery link intercepted via mailbox compromise, email
  forwarding rules, a shared inbox, or an enterprise link-scanning proxy remains a
  full account-takeover credential for a week — long after the user believes the request
  lapsed. (Password set post-recovery evicts other sessions, but the takeover already
  happened.)
- **Impact:** Extended ATO window on the most sensitive email token type.
- **Recommended fix:** Set `otp_expiry ≤ 3600`. Invitations do not need the long GoTrue
  window — the app-side `invitations.expires_at` + re-issue flow is the real lifetime
  control; align GoTrue to the shortest requirement.
- **Validation method:** Request recovery, attempt link use after expiry (temporarily set
  60 s in local stack) → neutral invalid-link page, no session; confirm invitation accept
  flow still works inside its own window.

### M-5 — Actor IP spoofable via first-hop `X-Forwarded-For`

- **Vulnerability:** `extractActorIp` takes the **first** XFF entry, which is
  client-supplied unless the deployment's proxy overwrites the header. `audit_events.actor_ip`
  is therefore forgeable per request, and any IP-keyed rate limiter (the C-1 fix) would be
  bypassable by rotating fake XFF values or poisonable into blocking legitimate ranges.
- **Affected area:** `src/server/utils/request-id.ts` / actor-IP extraction,
  `src/server/audit/*`, future limiter keying.
- **Attack scenario:** Attacker sends `X-Forwarded-For: <victim-ip>` with abusive
  requests → audit trail misattributes actions; once C-1's limiter keys on XFF, attacker
  either evades throttling (random IPs) or frames a victim IP into a 429 ban.
- **Impact:** Audit-log integrity (attribution is a compliance control) and
  throttling correctness.
- **Recommended fix:** Document and enforce the proxy contract: read the client IP from
  the platform-trusted header (e.g. the last hop appended by your own proxy, or
  `x-vercel-forwarded-for`-class headers), never the raw first XFF entry; key the limiter
  on (authenticated userId ∪ trusted IP).
- **Validation method:** Staging behind the real proxy: request with forged XFF →
  `audit_events.actor_ip` equals the true client IP; limiter test with rotating fake XFF
  still trips per-account.

### M-6 — No Content-Security-Policy and no HSTS

- **Vulnerability:** `next.config.ts` ships nosniff/XFO/Referrer-Policy/Permissions-Policy
  but explicitly defers CSP and HSTS "to Phase 6" — i.e. now. Without HSTS, first-visit
  downgrade stripping remains possible (cookies are `Secure`, so credentials survive, but
  MITM of the initial response is undetected); without CSP there is zero defense-in-depth
  against XSS once the Phase 9 UI renders user content (task descriptions, comments,
  filenames).
- **Affected area:** `next.config.ts` `headers()`.
- **Attack scenario:** (a) Network attacker on first visit serves a stripped HTTP page
  before any redirect habit forms. (b) Any future XSS (rich-text rendering in Phase 9)
  runs with no `script-src` restriction, no exfil limits (`connect-src`), and no
  violation reporting.
- **Impact:** Weakened transport security posture; missing the cheapest XSS blast-radius
  control, deferred into the phase where UI rendering begins.
- **Recommended fix:** Add `Strict-Transport-Security: max-age=31536000; includeSubDomains`
  (preload later, after domain verification); deploy CSP in `Content-Security-Policy-Report-Only`
  first (`default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`),
  collect violations in staging, then enforce.
- **Validation method:** Header assertions in the existing security-headers test; staging
  scan (observatory-class) A-grade transport; report-only produces zero violations across
  all pages before flipping to enforce.

### M-7 — No dependency-audit or secret-scanning gate in CI

- **Vulnerability:** `npm audit` is clean today (verified: 0/493), but nothing rechecks on
  PR or schedule; there is no gitleaks/trufflehog-class secret scan of history or diffs.
  The exposure scanner covers only built-bundle service-key patterns.
- **Affected area:** `.github/workflows/ci.yml`.
- **Attack scenario:** A Dependabot-less upgrade introduces a known-vulnerable transitive
  dep; a developer pastes an `sb_secret_…` key into a script or migration comment — both
  merge green.
- **Impact:** Supply-chain and secrets-hygiene regressions land undetected.
- **Recommended fix:** CI jobs: `npm audit --audit-level=moderate` (prod scope) per PR +
  weekly schedule; `osv-scanner` or Dependabot/Renovate for updates; `gitleaks protect`
  on diffs and a one-time full-history scan.
- **Validation method:** Branch test: add a known-vulnerable devDep → audit job red; plant
  a fake `sb_secret_` string in a doc → gitleaks red; revert → green.

---

## 4. LOW

### L-1 — Signed upload URL lives ~1 h while the API declares 60 s

- **Vulnerability:** `createSignedUploadUrl(storagePath)` is called without `expiresIn` →
  Supabase default 3600 s, but the response tells the client `expiresAt: now+60s`.
- **Affected area:** `src/server/services/files.ts` (`mintUploadUrl`).
- **Attack scenario:** An upload URL intercepted in transit/logs remains a valid
  write-credential to that exact storage path for ~1 hour, not the minute the client
  believes; also causes spurious client-side "expired" re-mints (functional drift).
- **Impact:** Longer-than-declared write window on a single path (object key is
  randomUUID — scope is one file).
- **Recommended fix:** Pass `expiresIn: 60` (or align the declared `expiresAt` with the
  actual value; shorter is better).
- **Validation method:** Mint a URL, PUT at t+61 s → storage rejects; PUT at t+30 s →
  succeeds.

### L-2 — State-changing GET (`/reports/[id]/download-url`) and no explicit Origin/Sec-Fetch checks

- **Vulnerability:** The report download route is a **GET** that writes an `EXPORT` audit
  row and mints a signed URL (files' equivalent correctly uses POST). No route checks
  `Origin`/`Sec-Fetch-Site`; the CSRF posture rests on SameSite=Lax + no-CORS +
  JSON-only bodies (sound for mutations — cross-site forms cannot set
  `application/json`, and preflight blocks JS), which §13.9 records as the Phase 6
  decision point.
- **Affected area:** `app/api/v1/reports/[id]/download-url/route.ts`,
  `src/server/services/reports.ts`, `with-route.ts`.
- **Attack scenario:** Cross-site `<img src="…/download-url">` or a link-scanner blindly
  triggers EXPORT audit rows (noise, and pollutes export analytics); the signed URL itself
  is _not_ exfiltratable (response unreadable cross-origin, URL not delivered to the
  browser for an img). No mutating route is currently CSRF-reachable.
- **Impact:** Audit/telemetry noise only; latent risk if any future GET gains a real side
  effect.
- **Recommended fix:** Make download-url POST (parity with files); add a cheap
  same-origin assertion in `with-route` for all mutating methods: reject when `Origin` or
  `Sec-Fetch-Site` is present and cross-site.
- **Validation method:** Test page on another origin fires img/fetch at the route → no
  audit row; same-origin UI flow unaffected; contract test asserts method matrix.

### L-3 — Cookie security flags are implicit library defaults, never pinned or asserted

- **Vulnerability:** Both Supabase client factories rely on `@supabase/ssr`
  `DEFAULT_COOKIE_OPTIONS` (path `/`, `SameSite=Lax`, `HttpOnly`, `Secure` in prod,
  1-year maxAge). Nothing in app code or tests pins or asserts these; a minor-version
  default change (or a `NODE_ENV` misconfiguration in the deploy pipeline) would silently
  alter the session-cookie posture.
- **Affected area:** `src/server/supabase/client-server.ts`, `session-refresh.ts` (types
  acknowledge the defaults but do not set them), test suite.
- **Attack scenario:** Dependency upgrade flips `sameSite` to `None` or drops `secure` in
  a build where `NODE_ENV` isn't `production` → cookies readable/attachable in ways the
  CSRF and transport models assume away.
- **Impact:** Posture drift risk; today's actual flags are correct.
- **Recommended fix:** Pass explicit `cookieOptions` (`httpOnly: true, secure: true,
sameSite: 'lax', path: '/'`) at both factory sites; add a unit/integration test
  asserting the emitted `Set-Cookie` headers from login/confirm/refresh.
- **Validation method:** Inspect `Set-Cookie` on staging login → flags present; new test
  fails when an option is removed.

### L-4 — Idempotency store: no TTL/cleanup, hash excludes the query string

- **Vulnerability:** `idempotency_keys` rows (containing the full stored response payload)
  are never purged — unbounded growth, weaponizable for table/storage bloat while C-1
  (no rate limits) stands. The request-hash covers method/pathname/body but **not** the
  query string, so the same key + body with a different query replays the stale stored
  response.
- **Affected area:** `src/server/api/idempotency.ts`, migration `20260906100000`.
- **Attack scenario:** Script hammers idempotent POSTs with millions of unique keys →
  table bloat (audit-adjacent availability/cost attack). Functional: a client reusing a
  key across query variations silently receives the first response.
- **Impact:** Storage growth/DoS amplifier; rare correctness bug on replay.
- **Recommended fix:** Scheduled purge (retain 24–72 h, matching the key-reuse window);
  include the canonical query string in the hashed payload; cap stored response bytes.
- **Validation method:** Seed old keys → purge job removes them; replay test with same
  key/body, different query → 422 key-mismatch instead of stale replay.

---

## 5. Prioritized remediation order (for the Phase 6 fix cycle)

1. **C-1** app-layer rate limiter + failed-login auditing (unblocks safe deployment of
   everything else; also neutralizes L-4's amplifier and M-5's limiter-bypass value).
2. **C-2** default-on `minAal: 2` for INTERNAL routes + architecture test.
3. **H-2** streaming body cap (small, self-contained change in `with-route`).
4. **H-1** enrollment re-auth + owner notification.
5. **H-3** CI database/attack-harness job (protects all SQL work that follows).
6. **M-1** uniform login failures; **M-2/M-3** upload verification + MIME allowlist
   (one coherent files hardening pass); **M-4** OTP expiry; **M-6** HSTS + CSP report-only.
7. **M-5** trusted-IP contract (must land with or before the C-1 limiter keying);
   **M-7** CI audit/secret gates; then the four LOW items.

All fixes are hardening of existing declared behavior (several are the repo's own
documented Phase 6 obligations: R-3, R-6, R-7, R-8, §13.9, `api.md` §10,
`next.config.ts` deferral comments) — none adds product functionality.

PHASE 6 SECURITY AUDIT COMPLETE

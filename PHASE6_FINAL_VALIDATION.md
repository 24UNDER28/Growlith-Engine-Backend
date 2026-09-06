# Phase 6 — Final Security Validation (Growlith Engine backend)

Date: 2026-09-06 · Branch: `arena/01a076df-growlith-engine-backend` · Base: `b63ac1f` (main)
Baseline: [`PHASE6_SECURITY_AUDIT.md`](PHASE6_SECURITY_AUDIT.md) (C-1…C-2, H-1…H-3, M-1…M-7, L-1…L-4) ·
Remediation record: [`PHASE6_HARDENING_REPORT.md`](PHASE6_HARDENING_REPORT.md)

Posture: adversarial re-test. Every attack scenario in the original audit was replayed,
plus the additional categories named in the validation brief. The database layer was
attacked with the real migration set on a real PostgreSQL engine; the HTTP layer was
attacked end-to-end through `withRoute` with the real authorization guard and the real
rate limiter (only the Supabase transport is faked). Nothing below is a claim from
reading code alone unless marked **by inspection**.

---

## 0. What was executed

| Layer    | Instrument                                                                                                                                                      | Result                                                   |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Database | `scripts/db-authz-attack.mjs` — all 40 `supabase/migrations/*.sql` applied to PGlite (PostgreSQL 18 WASM), 91 attacks as 6 seeded actors across 2 organizations | **91 / 91 blocked** (exit 0)                             |
| Database | **Mutation test** (H-3 validation method): `files_select_client` temporarily replaced by `using (true)`                                                         | Harness **fails 2 / 91** (exit 1) → the detector is real |
| HTTP     | `tests/contract/phase6-final-validation.spec.ts` — 53 attacks/positive controls through `withRoute` + real `authorize()` + real limiter                         | **53 / 53 pass**                                         |
| HTTP     | Pre-existing contract/unit/architecture suites (auth context, login, MFA, with-route, CSRF, permissions, files, RLS-shape, route/capability drift)              | **618 / 618 pass**                                       |
| Pipeline | `typecheck` · `lint` · `format:check` · `test` · `build` · `check:client-exposure` · `security:scan` · `npm audit --audit-level=moderate`                       | all green (build: 83 routes; audit: 0 vulnerabilities)   |
| Git      | Secret scan of the full history (`git log -p` grep for `sb_secret_`, JWT-shaped tokens, service-role keys, connection strings)                                  | clean                                                    |

Not executable here (no PostgreSQL server, no Docker, no Supabase CLI, no outbound
staging): `db:verify`, pgTAP, live GoTrue behaviour (token expiry, ban propagation,
OTP expiry, proxy header contract). Where the audit's validation method was a live probe,
the equivalent contract was pinned at the module boundary and marked accordingly.

---

## 1. Finding-by-finding comparison against the original audit

Legend — **RESOLVED**: fix present and attack re-executed; **RESOLVED (residual)**: fix
present, attack blocked, a bounded weaker property remains and is justified;
**by inspection**: fix verified in code/config, runtime step not executable in this sandbox.

### Critical

| ID  | Original finding                               | Re-test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Verdict                 |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| C-1 | No rate limiting; failed credentials invisible | `src/server/api/rate-limit.ts` enforced in `withRoute` after auth, before authorization. Replayed: (a) 10 wrong-password logins for one account → 11th is **429 + `Retry-After` + `TOO_MANY_REQUESTS`**; (b) rotating spoofed first-hop `X-Forwarded-For` with constant proxy hop → still 429 (M-5 keying); (c) TOTP spray on a `sensitive` route keyed per user → 429 at 30. Every credential/TOTP/re-auth failure writes a `LOGIN_FAILED` audit row (`routes-login.ts`, `routes-mfa.ts`). Legitimate other account from same IP unaffected (200).                                                                                                                                                                                                                            | **RESOLVED (residual)** |
| C-2 | aal2 unenforced on ~90 % of privileged routes  | `effectiveMinAalForRequest` inverts the default. Enumerated all 109 protected route definitions: 47 INTERNAL-only capabilities ⇒ aal2, 12 sensitive non-GET ⇒ aal2, 5 declared `minAal: 2`, 7 exempt (mfa enroll/challenge/factors/unenroll, password, `/me` GET/PATCH), 38 aal1 (29 GETs on client-visible capabilities + 9 non-GET on comment/file/notification). Replayed: aal1 ADMIN on `task:create` → **401 MFA_REQUIRED**; aal1 ADMIN on `invitation:update` → 401; aal1 ADMIN on any `/api/v1/admin/**` → 401; aal2 ADMIN → 200; step-up flow reachable at aal1; CLIENT flows untouched. Stolen aal1 cookie cannot escalate (see H-1). `mfaRequired` is 401 with `MFA_REQUIRED`, so a client can distinguish "step up" from "forbidden" without leaking anything else. | **RESOLVED (residual)** |

C-1 residual (accepted, Low): the limiter is in-memory per instance and the `auth` key is
`(trusted IP, account)`. A spray on **one** account from **many** genuinely distinct source
IPs gets a fresh 10/15 min bucket per source. Justification: every miss is audited
(`LOGIN_FAILED` with the target's profile id), GoTrue's own per-account/IP limits remain
the floor, and account-level lockout is a GoTrue/alerting concern rather than an app-tier
counter (a purely account-keyed counter would hand attackers a one-request DoS of any
staff account). Documented in the test itself. Multi-instance deployments must move the
store to Redis (interface unchanged) — tracked as a deployment prerequisite, not a
code defect.

C-2 residual (accepted, Low, matches `docs/architecture/authentication.md` §13 control 8 — aal2 for `/admin` surfaces): staff
may still **read** client-visible resources and post comments / register files /
mark notifications at aal1 (38 routes). None of these can alter tenancy, roles, status,
money, publication or membership; every write to those surfaces requires aal2.

### High

| ID  | Original finding                                                    | Re-test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Verdict                 |
| --- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| H-1 | aal1 session self-enrols TOTP → aal2 with no proof                  | Replayed (new tests): aal1 INTERNAL enroll without `password` → **401**, no factor created, audited `MFA_ENROLLED/WARNING`; wrong re-auth password → 401 `INVALID_CREDENTIALS`, audited `LOGIN_FAILED`, no factor; correct password → factor created; CLIENT enrol unchanged; `unenroll` is aal2-only (existing contract). Combined with C-2 this closes the "stolen aal1 cookie drives the admin API" chain.                                                                                                    | **RESOLVED (residual)** |
| H-2 | Unbounded chunked body buffering (memory DoS) before authentication | Replayed: 4 MiB chunked stream with **no** `Content-Length` → **413** aborted mid-stream (reader cancelled at 1 MiB, handler never runs); lying `Content-Length: 10` with an oversized body → 413; malformed `Content-Length` → 400. Limit `MAX_JSON_BODY_BYTES = 1 MiB` (`with-route.ts:79`).                                                                                                                                                                                                                   | **RESOLVED**            |
| H-3 | RLS "proof" never executed; CI had no database job                  | Executed: harness **91/91** against the real migrations; **mutation test** proves the harness detects a single policy regression (2 checks fail, exit 1). Found during validation: at `b63ac1f` the CI step could never have executed a policy — `@electric-sql/pglite ^0.3.9` cannot load `pgcrypto` and the step was `continue-on-error: true`. **Fixed in this validation**: pglite pinned exactly to `0.5.8`, `continue-on-error` removed → the harness is now a blocking gate (`.github/workflows/ci.yml`). | **RESOLVED**            |

H-1 residual (accepted, Low): no out-of-band e-mail notice to the account owner on new
factor enrolment. Password re-auth + aal2-only unenrol + audit row cover the attack the
finding described (silent escalation); a courtesy notice is a UX item for Phase 9.

### Medium

| ID  | Finding                                              | Re-test                                                                                                                                                                                                                                                                                                                                          | Verdict                    |
| --- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| M-1 | Login failures enumerate account state               | `mapSignInError` → uniform `401 INVALID_CREDENTIALS` for wrong password / unconfirmed / banned / GoTrue-429; recovery always 202 (`auth-login.spec.ts`, replayed in full suite). Suspended/deactivated **with a correct password** still receive 423/401 after sign-in — that path requires the password, so it is not an enumeration oracle.    | **PASS**                   |
| M-2 | No MIME allowlist on uploads                         | `ALLOWED_MIME_TYPES` (files.ts) excludes `text/html`, `image/svg+xml`, `application/javascript`, `application/xhtml+xml`, `application/x-sh`, `application/x-msdownload`, `application/octet-stream` (asserted); bucket `allowed_mime_types` + 10 MiB (`20260906130100`); downloads minted with `download:` ⇒ `Content-Disposition: attachment`. | **PASS**                   |
| M-3 | `registerFile` trusts client metadata; path unshaped | `validateStoragePath` rejects 9 attack shapes (traversal, `%2e%2e`, foreign-tenant prefix, missing segment, free-form, backslash, absolute, empty, wrong parent kind); `info()`/`exists()` verify the object and match size/MIME before the row is written (`files.ts:215–246`).                                                                 | **PASS**                   |
| M-4 | 7-day OTP lifetimes                                  | `supabase/config.toml`: `otp_expiry = 3600`, `enable_signup = false`, `minimum_password_length = 12`, `jwt_expiry = 3600`, refresh rotation + reuse interval. Live expiry not testable here.                                                                                                                                                     | **PASS** (by inspection)   |
| M-5 | Actor IP spoofable via first-hop XFF                 | `extractActorIp`: trusted single-value headers first, else **last** XFF hop; replayed via C-1 test (b). Proxy contract documented in `audit.ts`. Staging verification behind the real edge remains a deployment checklist item.                                                                                                                  | **PASS** (residual: ops)   |
| M-6 | No CSP / HSTS                                        | `next.config.ts`: HSTS (preload), CSP **Report-Only**, XFO DENY, nosniff, Referrer-Policy, Permissions-Policy, `/api/*` `no-store` (asserted by `security-headers` tests; every `withRoute` response `cache-control: no-store` replayed).                                                                                                        | **PASS** (CSP report-only) |
| M-7 | No dependency-audit / secret-scan gate               | CI runs `security:scan` and `npm audit --audit-level=moderate` as blocking steps; both green locally; git history clean.                                                                                                                                                                                                                         | **PASS**                   |

Remaining Medium items (none are vulnerabilities; all are tracked follow-ups):
CSP is report-only until Phase 9 renders content (enforcing now would be a blind policy);
M-5 needs a one-time staging check that the edge overwrites/appends XFF;
`sizeBytes` schema max (500 MiB) is looser than the bucket limit (10 MiB) — harmless
because the bucket and `info()` verification win, but worth aligning.

### Low

| ID  | Finding                                          | Re-test                                                                                                                                                                                                                                                                          | Verdict  |
| --- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| L-1 | Upload URL 1 h vs declared 60 s                  | Declared and minted expiry agree (3600 s upload, 60 s download).                                                                                                                                                                                                                 | **PASS** |
| L-2 | State-changing GET download-url; no Origin check | `download-url` is POST; `assertSameOriginForMutations` runs **before** validation and auth (replayed: cross-site Origin → 403 and the authority is never called; malformed Origin → 403; GET → 405); `file:download` + `tenantFromRow` + `FILE_DOWNLOAD` audit + `export` class. | **PASS** |
| L-3 | Cookie flags implicit                            | `PINNED_COOKIE_OPTIONS` (`httpOnly`, `secure`, `sameSite=lax`, `path=/`) passed explicitly to `@supabase/ssr` and asserted by tests.                                                                                                                                             | **PASS** |
| L-4 | Idempotency store: no TTL, hash excludes query   | 24 h TTL, 409 on payload mismatch, key scoped per actor, query string in the fingerprint; purge function exists (`20260906130000`) but is **unscheduled** — a housekeeping item, not a security property (rows are FORCE-RLS service-only).                                      | **PASS** |

---

## 2. Additional attack categories (validation brief)

All replayed in `tests/contract/phase6-final-validation.spec.ts` unless noted.

| Category                        | Attack                                                                                                                                                                                                        | Outcome                                                                                                                                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant / IDOR / BOLA      | CLIENT guesses a row id in org B; names `?organizationId=B`; omits tenant on a TENANT-scoped list; holds a **SUSPENDED** membership in B                                                                      | **404 / 404 / 403 / 404**, handler never runs, no audit row about foreign data (ADR-0019: unreachable tenant is indistinguishable from missing). DB layer: 26 cross-tenant read/write/insert attacks blocked (harness). Own-tenant read → 200 with `CLIENT_VISIBLE` obligation. |
| Privilege escalation            | CLIENT_ADMIN / ADMIN (even aal2) `platform_grant:create`; ADMIN `user:delete`; CLIENT SELF-scoped `user:update` on another user; CLIENT `task:read`; staff with revoked grant; capability-less route via cast | **403 / 403 / 403 / 403 / 403 / 404 / 500 (fails closed)**. DB layer: role-grant, erase, purge, member-elevation, self-add, status-column escalation all blocked; last-SUPER_ADMIN floors hold.                                                                                 |
| Direct API manipulation         | Cross-site Origin on a mutation; malformed Origin; forged `x-request-id`; cache poisoning                                                                                                                     | 403 before auth; 403; non-UUID/embedded-UUID ids discarded and a server UUID issued; every response `no-store`.                                                                                                                                                                 |
| Unauthorized storage / download | CLIENT mints download URL for a hidden file; top-level navigation / GET; foreign object path; forged `scan_status='CLEAN', client_visible=true` upload                                                        | 404 (handler never runs); 403 / 405; 422 at registration; DB layer: object download across tenants and on internal parents blocked, forged upload stays invisible.                                                                                                              |
| Mass assignment                 | Smuggled `organizationId`, `role`, `platformRole`, `accountStatus`, `id`, `createdBy`; `__proto__` / `constructor` keys                                                                                       | **422** unknown keys, no prototype pollution. 73 / 73 resource schemas are strict `ZodObject`s (enumerated).                                                                                                                                                                    |
| Malformed payloads              | Array / number / null / string body; truncated JSON; form-encoded; oversized `limit`; unknown query keys                                                                                                      | 400 `MALFORMED_REQUEST` / 422 with issue paths only.                                                                                                                                                                                                                            |
| Oversized payloads              | 4 MiB chunked stream without Content-Length; lying Content-Length                                                                                                                                             | **413** aborted mid-stream; 413.                                                                                                                                                                                                                                                |
| Session manipulation            | Verified user with TOTP factor but session still aal1 (forged "aal2" in body/header)                                                                                                                          | Context reports `aal1`; `minAal: 2` → `MFA_REQUIRED`. AAL comes only from `getAuthenticatorAssuranceLevel()` on the verified session; `getSession()` is banned by architecture test.                                                                                            |
| Expired sessions                | GoTrue `bad_jwt` (expired/tampered); `session_not_found` (revoked refresh); identity without profile row                                                                                                      | 401 / 401 / 401 — never trusted locally; GoTrue outage → **503**, never a silent "logged out".                                                                                                                                                                                  |
| Suspended accounts              | `account_status = SUSPENDED` with a valid session                                                                                                                                                             | **423 ACCOUNT_SUSPENDED**, `signOut({scope:'global'})`, GoTrue `ban_duration: 87600h`. DB layer: `is_active_account()` / `has_org_access()` require ACTIVE (harness + RLS-shape tests).                                                                                         |
| Deactivated accounts            | `account_status = DEACTIVATED`                                                                                                                                                                                | **401 ACCOUNT_DEACTIVATED** with the same eviction; `can()` re-checks status (non-ACTIVE actor → 404 even if the authority were bypassed).                                                                                                                                      |
| Secret exposure                 | Client env contract; bundle scan; logger; git history; service-role client import graph                                                                                                                       | `CLIENT_ENV_KEYS` are all `NEXT_PUBLIC_*`; `check:client-exposure` PASSED (13 artifacts, 7 patterns); `redactSecrets` strips JWTs / `sb_secret_` / passwords / connection strings; history clean; service client imported only under `src/server/**`.                           |
| Error disclosure                | `23505` with constraint name; `42P01`/`42703`/`XX000`; `42501`; `P0002`; `22P02`; handler throw containing a connection string; deep Zod error; hidden-vs-missing 404                                         | 409 without constraint; 503 without table names; 403; 404; 422; generic 500 + request id, no stack/cause; 422 with paths, never the raw value; the two 404 bodies are byte-identical.                                                                                           |

---

## 3. Changes made during validation

| File                                                   | Change                                                                                                     | Why                                                                                                                |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `package.json`, `package-lock.json`                    | `@electric-sql/pglite` `^0.3.9` → exact `0.5.8`                                                            | 0.3.9 cannot load `pgcrypto`; the H-3 harness never ran a policy at HEAD.                                          |
| `.github/workflows/ci.yml`                             | Removed `continue-on-error: true` from the harness step; header comment updated                            | H-3 requires a **blocking** gate; a step that cannot fail is not a gate (repo Rule 14).                            |
| `tests/contract/phase6-final-validation.spec.ts` (new) | 53 attack replays / positive controls                                                                      | Executable evidence for every category above; regression net for the Phase 6 controls.                             |
| `src/server/api/with-route.ts`                         | Two stale comments ("limiter arrives in Phase 6") corrected                                                | Doc drift found during validation; no logic change.                                                                |
| `PHASE6_HARDENING_REPORT.md`                           | H-3 CI paragraph corrected (blocking gate, pinned engine, mutation evidence)                               | Prior claim was inaccurate.                                                                                        |
| 39 files                                               | `prettier --write` (whitespace / wrapping / markdown-table padding only; verified token-identical to HEAD) | `format:check` was the sole red CI step at HEAD; the clean-tree gate requires the formatted state to be committed. |

No product functionality was added; no authorization logic, schema, migration, or policy
was changed.

---

## 4. Remaining items (none Critical/High)

| Sev    | Item                                                                                                                                                         | Owner / when                               |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Medium | CSP is Report-Only; enforce once Phase 9 UI exists and reports are clean                                                                                     | Phase 9                                    |
| Medium | Verify the edge proxy XFF contract on staging (M-5) — one-time operational check                                                                             | Deployment checklist                       |
| Medium | Rate limiter store is per-instance; move to Redis for multi-instance deploys (interface unchanged)                                                           | Deployment prerequisite                    |
| Low    | Limiter `auth` key is (IP, account): per-account lockout across many IPs relies on GoTrue + `LOGIN_FAILED` alerting                                          | Accepted (documented)                      |
| Low    | 38 INTERNAL routes (29 reads, 9 low-impact writes) accept aal1                                                                                               | Accepted (design: aal2 for admin surfaces) |
| Low    | No owner e-mail on new MFA factor enrolment                                                                                                                  | Phase 9 UX                                 |
| Low    | `sizeBytes` schema max (500 MiB) vs bucket 10 MiB; `routes-mfa.ts:267` cosmetic null-cast; idempotency purge function unscheduled                            | Housekeeping                               |
| Low    | Documentation drift: `README.md` Phase 6 roadmap, `docs/architecture/api.md` §10/§20 ("no rate limiter"), `docs/architecture/README.md` pgTAP/Docker wording | Docs pass                                  |

---

## 5. Verdict

Every Critical and High finding from `PHASE6_SECURITY_AUDIT.md` has been re-attacked and is
blocked; the only unresolved item found in that tier (H-3's CI gate never executing) was
fixed in this validation and its detector proven by mutation. Residuals are bounded,
justified above, and none permits cross-tenant access, privilege escalation, single-factor
administration, unauthenticated resource exhaustion, or an unexecuted tenant-isolation proof.

Security Status:
CRITICAL — PASS
HIGH — PASS
MEDIUM — REMAINING
LOW — REMAINING

PHASE 6 VALIDATED

# Phase 7 — Seed Data Design (Growlith Engine backend)

Date: 2026-09-06 · Branch: `arena/01a077a2-growlith-engine-backend` · Base: `f2a420d` (main)
Status: **DESIGN — implementation deliberately NOT started in this phase.**
Inputs: Phase 2 schema (`supabase/migrations/`), Phase 4 RLS/authorization model,
Phase 5 API catalogue, the current minimal `supabase/seed.sql`, and the ID
dependencies of `scripts/db-authz-attack.mjs` (Phase 4/6 proof harness).

This document is the contract for the Phase 7 implementation. It defines the
fixture set, the deterministic identity scheme, the scenario coverage, and the
reset/re-run semantics. **No seed script is implemented yet** — `supabase/seed.sql`
is not modified here.

---

## 0. Summary

Phase 7 replaces the current two-tenant smoke seed with one realistic,
deterministic development fixture for the whole engine:

- **4 organizations** — one flagship active client, one second active tenant, one
  onboarding/invited client, one suspended client.
- **20 people** — 10 internal (all 7 delivery teams, all 4 bureaus) and 10
  client users across all four account/membership statuses.
- **All 4 roles** — `SUPER_ADMIN`, `ADMIN`, `CLIENT_ADMIN`, `CLIENT_MEMBER` — and
  all 4 project-member roles.
- **All 7 service lines and all 7 internal teams**, using the catalogue as
  shipped (`src/lib/domain/service-lines.ts`, `teams.ts`).
- **8 engagements, 13 services, 13 projects, 32 tasks, 20 deliverables**
  (19 seeded + 1 reserved), 13 deliverable versions, 12 comments.
- **8 reports** (4 published) with frozen `report_metrics`, ~350 time-series
  `metrics` rows, 24 notifications covering all 11 notification types,
  7 invitations covering all 4 invitation statuses, 14 file-metadata rows
  with matching `storage.objects` placeholders.
- **A curated 72-event activity history** in `audit_events`,
  back-dated over 8 months and attributed to real seeded actors.

Every row has a deterministic UUID, deterministic relative timestamps
(T = seed run date; all offsets are fixed intervals), and deterministic token
hashes/checksums. The seed is idempotent, transactional, and local-only.

---

## 1. Goals and non-goals

### 1.1 Goals

1. **Realistic, not exhaustive.** Every seeded state should be reachable state
   a real Growlith account could be in, with believable names, dates, notes and
   numbers. No `example_task_1` placeholders.
2. **Exercises every requested scenario** (§10): active client, invited client,
   suspended client, multiple client users, multiple projects, overdue tasks,
   pending deliverables, approved deliverables, published reports,
   notifications, activity history, file metadata.
3. **Covers the full catalogue** — all seven service lines and all seven teams,
   with at least one deliberate cross-line delivery shape (ADR-0006).
4. **Deterministic** — same relative structure on every run, same IDs forever;
   only the absolute wall clock shifts with the run date.
5. **Idempotent and resettable** — re-running the seed is a no-op; resetting is
   one command; the seed never deletes or rewrites history.
6. **Security honest** — synthetic data only (Rule 13), `.test`/`.example`
   domains, token hashes only, no real keys or checksums, never a production
   flag or shape.
7. **Keeps the existing proof harness alive** — `scripts/db-authz-attack.mjs`,
   `scripts/db-verify.mjs`, `tests/unit/schema.spec.ts` and the planned Phase 8
   pgTAP suite must keep working unchanged against the new seed (§11.4).

### 1.2 Non-goals (explicitly out of scope)

- **No UI fixtures** (Phase 9) and **no test suites** (Phase 8) — but the seed
  is designed so Phase 8 can assert against these exact IDs.
- **No changes to reference data.** `teams`, `service_lines`,
  `status_transitions`, and the storage bucket stay in migrations.
- **No real Storage objects.** Phase 7 seeds `files` metadata rows and
  `storage.objects` rows; physically uploading placeholder bytes is a
  documented local step (§14), because object bytes are GoTrue/Storage-owned
  and cannot be made deterministic in a plain SQL seed.
- **No GoTrue password hashes or MFA secrets.** Credentials are set by a
  separate local-only Admin-API script (§13.4); `mfa_enrolled_at` is metadata
  only — real TOTP secrets are not seedable.
- **No fix of upstream bugs observed while designing** (§15).
- **No org chart churn** — staffing is a snapshot at seed time, not a history.

---

## 2. What the seed touches (and what it must not)

### 2.1 Seeded by Phase 7 (fixtures)

| Area       | Tables                                                                                                |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| Identity   | `auth.users` (via trigger → `profiles`), `profiles`, `platform_role_grants`, `staff_team_memberships` |
| Tenancy    | `organizations`, `organization_settings`, `organization_memberships`                                  |
| Commercial | `engagements`, `services`                                                                             |
| Delivery   | `projects`, `project_memberships`, `tasks`, `deliverables`, `deliverable_versions`, `comments`        |
| Reporting  | `metrics`, `reports`, `report_metrics`                                                                |
| Comms      | `notifications`, `invitations`                                                                        |
| Storage    | `files`, `storage.objects`                                                                            |
| Activity   | `audit_events` (curated), monthly partitions for past months                                          |

### 2.2 Never touched by the seed

- `teams`, `service_lines`, `status_transitions` — reference data, migration-owned.
- `storage.buckets` — migration 22 owns the `growlith-private` bucket.
- `idempotency_keys`, `audit_events` partitions for future months (already created).
- Any migration file. Seed data lives in `supabase/seed.sql` only.

---

## 3. Time base and date convention

Every date/time column is expressed as a **fixed offset from the run date**.
Let **T = the transaction's `current_date`** (or `now()` for timestamptz). The
seed defines a small set of named anchors and derives everything from them:

| Anchor           | Value     | Meaning                                     |
| ---------------- | --------- | ------------------------------------------- |
| `t_acme_onboard` | T − 240 d | Acme signed and onboarded                   |
| `t_acme_renewal` | T + 120 d | Acme retainer renewal                       |
| `t_glx_start`    | T − 90 d  | Globex rebuild kicked off                   |
| `t_ich_start`    | T − 14 d  | Initech onboarding began                    |
| `t_umb_onboard`  | T − 400 d | Umbrella onboarded                          |
| `t_umb_paused`   | T − 60 d  | Umbrella retainer paused (client suspended) |
| `t_hist_start`   | T − 520 d | oldest historical engagement                |
| `t_audit_start`  | T − 240 d | earliest curated activity                   |

Rules:

1. **No literal calendar dates.** `current_date`/`now()` is the only absolute.
   Re-running on a different day shifts every row by exactly the same amount.
2. **No `random()`, no `gen_random_uuid()` for seeded rows.** All ids and values
   are fixed (metrics are the single documented exception for ids — §11.3).
3. **`created_at` is always set explicitly** to the story's start (inserts may
   supply it; only `updated_at` is trigger-maintained on updates).
4. A generated series (`generate_series`) may derive metric dates from T back
   over a fixed window — that is deterministic in structure and value.
5. Phase 8/seed-verify must assert **offsets**, never absolute dates.

---

## 4. Identity fixtures

### 4.1 UUID scheme (deterministic)

Compact notation used throughout this document:

```
<prefix>000000-0000-4000-8000-0000000000NN
```

- **Tenant hierarchy** — `{a|b|c|d}{kind}` where the letter is the organization
  and the digit the entity kind: `0` organization membership, `1` engagement,
  `2` service, `3` project, `4` deliverable, `5` report, `6` deliverable version,
  `7` task, `8` comment, `9` file.
  - `a3-001` → `a3000000-0000-4000-8000-000000000001` (Acme project #1)
  - `b4-003` → `b4000000-0000-4000-8000-000000000003` (Globex deliverable #3)
- **Access/global families** (data carries the tenant letter, id does not):
  - `e1-…` project memberships, `e2-…` platform role grants,
    `e3-…` staff team memberships, `e4-…` invitations, `e5-…` notifications.
  - `e1-007` → `e1000000-0000-4000-8000-000000000007`
- **People:** legacy `1111…`–`6666…` (kept); new internal `70000000-0000-4000-8000-0000000000NN`;
  new client `80000000-0000-4000-8000-0000000000NN`.
- **Organizations:** `aaaaaaaa-0000-4000-8000-000000000001` (Acme),
  `bbbbbbbb-0000-4000-8000-000000000002` (Globex),
  `cccccccc-0000-4000-8000-000000000003` (Initech),
  `dddddddd-0000-4000-8000-000000000004` (Umbrella).

> These are **identities, not display labels**. Component names may be renamed
> freely; the ids never change after Phase 7 ships.

### 4.2 Organizations (4)

| Key | Slug               | Legal name             | Region | Industry           | Status       | Currency | AM    | Onboarded |
| --- | ------------------ | ---------------------- | ------ | ------------------ | ------------ | -------- | ----- | --------- |
| ACM | `acme-industrials` | Acme Industrials Inc.  | NYC    | Manufacturing      | `ACTIVE`     | USD      | `ben` | T − 240 d |
| GLX | `globex-health`    | Globex Health Ltd.     | LDN    | Healthcare         | `ACTIVE`     | GBP      | `ben` | T − 90 d  |
| ICH | `initech-capital`  | Initech Capital Ltd.   | DIFC   | Financial Services | `ONBOARDING` | AED      | `ben` | T − 14 d  |
| UMB | `umbrella-labs`    | Umbrella Labs Pty Ltd. | SYD    | E-commerce         | `PAUSED`     | AUD      | `ben` | T − 400 d |

- All four orgs are **fictional**; URLs use `.example` (`https://acme-industrials.example`).
- `account_manager_user_id = ben` everywhere — the seed shows one AM running
  four accounts; the AM's own org membership is _not_ what authorizes him (he is
  internal; he has no `organization_memberships` row).
- `organization_settings`: ACM gets `#0f7c5b` + logo `a9-001`; GLX gets
  `#1f4d8f` + logo `b9-001`; ACM `default_report_cadence = MONTHLY`,
  `notify_on_report_published = true`, `require_approval_for_publish = true`;
  UMB sets `notify_on_report_published = false` (paused account) and keeps
  defaults otherwise; ICH keeps defaults entirely. All colors are lowercase
  hex (schema CHECK).

### 4.3 Internal staff (10)

All specialists hold `ADMIN` — this is the **risk R-1 least-privilege violation
deliberately visible in the seed**, and every specialist grant carries the
reason string `'Specialist. Requires ADMIN only because no TEAM_MEMBER role
exists — risk R-1.'`, matching the current seed's convention.

| Key | Full name | Email | Role grant | Team memberships (allocation, lead) | TZ | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ada` | Ada Superuser | `super@growlith.test` | `SUPER_ADMIN` (founding) | — | America/New_York | ACTIVE |
| `ben` | Ben Operator | `admin@growlith.test` | `ADMIN` | `ACCOUNT_MANAGEMENT` 100% **(lead)** | America/New_York | ACTIVE |
| `cara` | Cara Search | `seo@growlith.test` | `ADMIN` | `SEO` 80%, `AI_AUTOMATION` 20% | America/New_York | ACTIVE |
| `davina` | Davina Deploy | `web@growlith.test` | `ADMIN` | `WEB_DEVELOPMENT` 80% **(lead)** | Europe/London | ACTIVE |
| `priya` | Priya Precision | `paid@growlith.test` | `ADMIN` | `PAID_MEDIA` 70% **(lead)** | America/New_York | ACTIVE |
| `omar` | Omar Lifecycle | `crm@growlith.test` | `ADMIN` | `CRM_LIFECYCLE` 75% **(lead)** | Asia/Dubai | ACTIVE |
| `lana` | Lana Automate | `ai@growlith.test` | `ADMIN` | `AI_AUTOMATION` 60% **(lead)** | Australia/Sydney | ACTIVE |
| `marcus` | Marcus Motion | `video@growlith.test` | `ADMIN` | `VIDEO_MULTIMEDIA` 65% **(lead)** | Europe/London | ACTIVE |
| `zoe` | Zoe Former | `zoe@growlith.test` | **revoked** | `SEO` 100% **soft-deleted** | America/New_York | **DEACTIVATED** |
| `pax` | Pax Contractor | `pax@growlith.test` | `ADMIN`, **expires** T + 30 d | `AI_AUTOMATION` 20% | America/New_York | ACTIVE |

The new-user ids are `70000000-0000-4000-8000-0000000000{01…07}` in table order
(davina→01 … pax→07). Grant ids and staff-membership ids follow `e2-…`/`e3-…`
in the same order.

- **`ada`, `ben`, `cara` keep their legacy ids** (`1111…`, `2222…`, `3333…`).
- `zoe` is the **deactivated ex-staff** path: revoked grant (`revoked_at`, `revoked_by ada`),
  soft-deleted team membership (`deleted_at`, `deleted_by ada`), but her
  historical project memberships and completed tasks remain (evidence, per the
  RESTRICT FKs).
- `pax` is the **time-boxed grant** path: expires T + 30 d, `AI_AUTOMATION` 20%.
- `mfa_enrolled_at` is set for `ada` and `ben` (the MFA-mandatory roles). No
  TOTP factors are seeded (GoTrue-owned, not deterministic).

### 4.4 Client users (10)

| Key      | Full name      | Email                 | Org | Org role        | Membership status                | Account status  | Notes                                              |
| -------- | -------------- | --------------------- | --- | --------------- | -------------------------------- | --------------- | -------------------------------------------------- |
| `dana`   | Dana Acme      | `owner@acme.test`     | ACM | `CLIENT_ADMIN`  | ACTIVE (primary, joined T−240 d) | ACTIVE          | approver; invite sender                            |
| `eli`    | Eli Acme       | `analyst@acme.test`   | ACM | `CLIENT_MEMBER` | ACTIVE (T−180 d)                 | ACTIVE          | commenter                                          |
| `nova`   | Nova Acme      | `nova@acme.test`      | ACM | `CLIENT_MEMBER` | ACTIVE (T−120 d)                 | ACTIVE          | project **observer**                               |
| `pierre` | Pierre Acme    | `pierre@acme.test`    | ACM | `CLIENT_MEMBER` | INVITED (invited by dana)        | INVITED         | **invited user** inside an active tenant           |
| `susie`  | Susie Acme     | `susie@acme.test`     | ACM | `CLIENT_MEMBER` | **SUSPENDED** (T−200 d joined)   | ACTIVE          | org-scoped suspension; global account still ACTIVE |
| `fay`    | Fay Globex     | `owner@globex.test`   | GLX | `CLIENT_ADMIN`  | ACTIVE (primary, T−90 d)         | ACTIVE          | approver                                           |
| `gwen`   | Gwen Globex    | `gwen@globex.test`    | GLX | `CLIENT_MEMBER` | ACTIVE (T−60 d)                  | ACTIVE          | accepted via invitation `e4-004`                   |
| `umbra`  | Umbra Umbrella | `owner@umbrella.test` | UMB | `CLIENT_ADMIN`  | **SUSPENDED** (T−400 d joined)   | **SUSPENDED**   | **suspended client**                               |
| `umari`  | Umari Umbrella | `umari@umbrella.test` | UMB | `CLIENT_MEMBER` | ACTIVE (primary, T−380 d)        | ACTIVE          | still can log in; sees a paused account            |
| `udith`  | Udith Umbrella | `udith@umbrella.test` | UMB | `CLIENT_MEMBER` | **DEACTIVATED** (T−350 d joined) | **DEACTIVATED** | former member, history only                        |

New-user ids are `80000000-0000-4000-8000-0000000000{01…07}` in table order
(nova→01 … udith→07). `dana`, `eli`, `fay` keep legacy ids (`4444…`, `5555…`, `6666…`).

- Axes are deliberately separated (the schema's own comment): `susie` is
  suspended from **one organization only**; `umbra` is suspended **globally**;
  `udith` is deactivated globally.
- There is exactly **one primary contact per org** (dana, fay, umari — note
  Umbrella's primary contact is the ACTIVE member, because the suspended admin
  cannot be a primary contact per schema CHECK).

### 4.5 Roles coverage

| Role            | Held by                                                                               |
| --------------- | ------------------------------------------------------------------------------------- |
| `SUPER_ADMIN`   | ada                                                                                   |
| `ADMIN`         | ben, cara, davina, priya, omar, lana, marcus, pax (expiring); zoe (revoked — history) |
| `CLIENT_ADMIN`  | dana, fay, umbra (suspended)                                                          |
| `CLIENT_MEMBER` | eli, nova, pierre (invited), susie (suspended), gwen, umari, udith (deactivated)      |
| Project roles   | `LEAD`/`CONTRIBUTOR`/`REVIEWER`/`OBSERVER` — §5.4                                     |

---

## 5. Commercial and delivery fixtures

### 5.1 Engagements (8)

| Key      | Code          | Name                              | Type       | Status      | Currency | Value / retainer | Start / end       | Renewal | Signed  |
| -------- | ------------- | --------------------------------- | ---------- | ----------- | -------- | ---------------- | ----------------- | ------- | ------- |
| `a1-001` | `ACM-2026-R1` | Acme growth retainer 2026         | `RETAINER` | `ACTIVE`    | USD      | 240,000 / 20,000 | T−240 d / —       | T+120 d | T−238 d |
| `a1-002` | `ACM-2025-P1` | Acme site authority audit         | `PROJECT`  | `COMPLETED` | USD      | 45,000 / —       | T−420 d / T−270 d | —       | T−425 d |
| `a1-003` | `ACM-2026-A1` | Acme growth advisory Q3           | `ADVISORY` | `ACTIVE`    | USD      | 9,000 / —        | T−45 d / T+45 d   | —       | T−47 d  |
| `b1-001` | `GLX-2026-P1` | Globex site rebuild               | `PROJECT`  | `ACTIVE`    | GBP      | 85,000 / —       | T−90 d / T+150 d  | —       | T−88 d  |
| `b1-002` | `GLX-2025-A1` | Globex measurement advisory       | `ADVISORY` | `COMPLETED` | GBP      | 12,000 / —       | T−330 d / T−210 d | —       | T−335 d |
| `c1-001` | `ICH-2026-P1` | Initech regulatory web foundation | `PROJECT`  | `DRAFT`     | AED      | 180,000 / —      | T+7 d / T+180 d   | —       | —       |
| `d1-001` | `UMB-2025-R1` | Umbrella paid retainer 2025       | `RETAINER` | `PAUSED`    | AUD      | 96,000 / 8,000   | T−400 d / —       | T+45 d  | T−398 d |
| `d1-002` | `UMB-2024-P1` | Umbrella authority content sprint | `PROJECT`  | `COMPLETED` | AUD      | 38,000 / —       | T−520 d / T−360 d | —       | T−505 d |

- ACM/GLX legacy rows `a1-001` and `b1-001` keep their values (matching the
  current seed and the attack harness).
- `a1-001.notes_internal`: `'Margin thin in Q1; revisit scope at renewal.'`
  (retained) — the internal-only column test row.
- Engagement types covered: `RETAINER`, `PROJECT`, `ADVISORY`.
- Statuses covered: `ACTIVE`, `COMPLETED`, `DRAFT`, `PAUSED`.
- Initech's engagement is `DRAFT` (unsigned work, `signed_at` null) — it never
  violates `engagements_active_requires_signature`.

### 5.2 Services (13) — every service line, every team

Requested service names map onto the actual Growlith catalogue and teams
(one row per offering, `SERVICE_LINE_DEFAULT_TEAM` in `service-lines.ts`):

| Requested name     | `service_lines.code`             | Default team         |
| ------------------ | -------------------------------- | -------------------- |
| Programmatic SEO   | `PROGRAMMATIC_SEO`               | `SEO`                |
| Paid Media         | `PRECISION_PAID_MEDIA`           | `PAID_MEDIA`         |
| Web Development    | `WEB_CORE` (Sub-Second Web Core) | `WEB_DEVELOPMENT`    |
| CRM / Lifecycle    | `LIFECYCLE_CRM`                  | `CRM_LIFECYCLE`      |
| AI Automations     | `AI_AUTOMATIONS`                 | `AI_AUTOMATION`      |
| Video & Multimedia | `VIDEO_MULTIMEDIA`               | `VIDEO_MULTIMEDIA`   |
| Account Management | `ACCOUNT_MANAGEMENT`             | `ACCOUNT_MANAGEMENT` |

| Key      | Engagement | Service line           | Delivering team      | Name                              | Status      | Currency | Fee / model            | Start   |
| -------- | ---------- | ---------------------- | -------------------- | --------------------------------- | ----------- | -------- | ---------------------- | ------- |
| `a2-001` | `a1-001`   | `PROGRAMMATIC_SEO`     | `SEO`                | Programmatic SEO — category pages | `ACTIVE`    | USD      | 12,000 / `RETAINER`    | T−240 d |
| `a2-002` | `a1-001`   | `WEB_CORE`             | `WEB_DEVELOPMENT`    | Sub-second web core               | `ACTIVE`    | USD      | 8,000 / `RETAINER`     | T−180 d |
| `a2-003` | `a1-001`   | `PRECISION_PAID_MEDIA` | `PAID_MEDIA`         | Precision paid — always-on        | `ACTIVE`    | USD      | 14,000 / `PERFORMANCE` | T−200 d |
| `a2-004` | `a1-001`   | `LIFECYCLE_CRM`        | `CRM_LIFECYCLE`      | Lifecycle nurture & scoring       | `ACTIVE`    | USD      | 9,000 / `RETAINER`     | T−150 d |
| `a2-005` | `a1-001`   | `ACCOUNT_MANAGEMENT`   | `ACCOUNT_MANAGEMENT` | Account leadership & QBRs         | `ACTIVE`    | USD      | 3,500 / `RETAINER`     | T−240 d |
| `a2-006` | `a1-002`   | `PROGRAMMATIC_SEO`     | `SEO`                | Site authority audit (2025)       | `COMPLETED` | USD      | 45,000 / `FIXED`       | T−420 d |
| `b2-001` | `b1-001`   | `WEB_CORE`             | `WEB_DEVELOPMENT`    | Platform rebuild                  | `ACTIVE`    | GBP      | 85,000 / `FIXED`       | T−90 d  |
| `b2-002` | `b1-001`   | `AI_AUTOMATIONS`       | `AI_AUTOMATION`      | AI workflows & RAG pilots         | `ACTIVE`    | GBP      | 12,000 / `FIXED`       | T−60 d  |
| `b2-003` | `b1-001`   | `VIDEO_MULTIMEDIA`     | `VIDEO_MULTIMEDIA`   | Founder video series              | `ACTIVE`    | GBP      | 15,000 / `FIXED`       | T−45 d  |
| `b2-004` | `b1-001`   | `ACCOUNT_MANAGEMENT`   | `ACCOUNT_MANAGEMENT` | Rebuild delivery management       | `ACTIVE`    | GBP      | 4,000 / `RETAINER`     | T−90 d  |
| `c2-001` | `c1-001`   | `WEB_CORE`             | `WEB_DEVELOPMENT`    | Regulatory web foundation         | `PLANNED`   | AED      | 180,000 / `FIXED`      | T+7 d   |
| `d2-001` | `d1-001`   | `PRECISION_PAID_MEDIA` | `PAID_MEDIA`         | Paid retargeting refresh          | `PAUSED`    | AUD      | 8,000 / `RETAINER`     | T−400 d |
| `d2-002` | `d1-002`   | `PROGRAMMATIC_SEO`     | `SEO`                | Authority content sprint (2024)   | `COMPLETED` | AUD      | 38,000 / `FIXED`       | T−520 d |

Coverage check: all 7 service lines (`PROGRAMMATIC_SEO`, `PRECISION_PAID_MEDIA`,
`WEB_CORE`, `LIFECYCLE_CRM`, `AI_AUTOMATIONS`, `VIDEO_MULTIMEDIA`,
`ACCOUNT_MANAGEMENT`) and all 7 delivering teams appear. Every Acme
`a1-001` service currency is USD = engagement currency (trigger-enforced);
every Globex service is GBP.

**ADR-0006 exercised at project level** (services keep their default team):
`b2-001` (`WEB_CORE`) carries two projects — `b3-001` owned by
`WEB_DEVELOPMENT` and `b3-002` owned by `SEO`. The 1:1 default is preserved in
the catalogue; the N:M future is visible as data.

### 5.3 Projects (13)

| Key      | Code           | Service  | Name                            | Status        | Priority | Health      | Owning team          | Lead   | Start / target    | Client visible |
| -------- | -------------- | -------- | ------------------------------- | ------------- | -------- | ----------- | -------------------- | ------ | ----------------- | -------------- |
| `a3-001` | `ACM-SEO-01`   | `a2-001` | Category template rollout       | `IN_PROGRESS` | HIGH     | `ON_TRACK`  | `SEO`                | cara   | T−60 d / T+30 d   | true           |
| `a3-002` | `ACM-PAID-01`  | `a2-003` | Precision paid acquisition Q3   | `IN_PROGRESS` | URGENT   | `AT_RISK`   | `PAID_MEDIA`         | priya  | T−45 d / T+14 d   | true           |
| `a3-003` | `ACM-WEB-01`   | `a2-002` | Core Web Vitals sprint 4        | `BLOCKED`     | HIGH     | `OFF_TRACK` | `WEB_DEVELOPMENT`    | davina | T−100 d / T+5 d   | true           |
| `a3-004` | `ACM-CRM-01`   | `a2-004` | Lifecycle nurture revamp        | `IN_REVIEW`   | HIGH     | `ON_TRACK`  | `CRM_LIFECYCLE`      | omar   | T−80 d / T+21 d   | true           |
| `a3-005` | `ACM-INT-01`   | `a2-005` | Margin & pricing analysis       | `IN_PROGRESS` | MEDIUM   | `ON_TRACK`  | `ACCOUNT_MANAGEMENT` | ben    | T−120 d / T+45 d  | **false**      |
| `a3-006` | `ACM-AUDIT-02` | `a2-006` | Site authority audit            | `COMPLETED`   | HIGH     | `ON_TRACK`  | `SEO`                | cara   | T−420 d / T−280 d | true           |
| `b3-001` | `GLX-WEB-1`    | `b2-001` | Rebuild phase one               | `IN_PROGRESS` | URGENT   | `ON_TRACK`  | `WEB_DEVELOPMENT`    | davina | T−90 d / T+60 d   | true           |
| `b3-002` | `GLX-SEO-01`   | `b2-001` | Indexation & redirect programme | `IN_PROGRESS` | MEDIUM   | `ON_TRACK`  | `SEO`                | cara   | T−60 d / T+40 d   | true           |
| `b3-003` | `GLX-AI-01`    | `b2-002` | Automation opportunity mapping  | `IN_PROGRESS` | MEDIUM   | `ON_TRACK`  | `AI_AUTOMATION`      | lana   | T−45 d / T+30 d   | true           |
| `b3-004` | `GLX-VID-01`   | `b2-003` | Founder video series ep 1–3     | `IN_REVIEW`   | HIGH     | `ON_TRACK`  | `VIDEO_MULTIMEDIA`   | marcus | T−50 d / T+10 d   | true           |
| `c3-001` | `ICH-2026-01`  | `c2-001` | Discovery & architecture        | `PLANNED`     | MEDIUM   | `ON_TRACK`  | `WEB_DEVELOPMENT`    | davina | T+7 d / T+90 d    | true           |
| `d3-001` | `UMB-PAID-01`  | `d2-001` | Paid retargeting refresh        | `BLOCKED`     | HIGH     | `OFF_TRACK` | `PAID_MEDIA`         | priya  | T−300 d / T+30 d  | true           |
| `d3-002` | `UMB-SEO-01`   | `d2-002` | Authority content sprint        | `COMPLETED`   | HIGH     | `ON_TRACK`  | `SEO`                | cara   | T−500 d / T−370 d | true           |

Completed projects carry `completed_at` (`a3-006`: T−280 d, `d3-002`: T−370 d).
`a3-005` is the **inverted default** — an internal-only project — and is also
the deliberate "compromised marketing dataset" fixture for RLS column checks.

### 5.4 Project memberships (35)

Every project has exactly one `LEAD` (unique index
`project_memberships_single_lead_key`). Internal staff may be staffed on any
project; **client users appear only as `OBSERVER` on projects of their own
organization** (the `enforce_project_member_tenancy` trigger demands an ACTIVE
membership — this is exercised, not evaded).

| Project  | Members (role, allocation %)                                                     |
| -------- | -------------------------------------------------------------------------------- |
| `a3-001` | cara `LEAD` 60 · davina `CONTRIBUTOR` 15 · ben `REVIEWER` 10 · nova `OBSERVER` 5 |
| `a3-002` | priya `LEAD` 50 · marcus `CONTRIBUTOR` 20 · dana `OBSERVER` 5 · eli `OBSERVER` 5 |
| `a3-003` | davina `LEAD` 70 · cara `CONTRIBUTOR` 10 · ben `REVIEWER` 10                     |
| `a3-004` | omar `LEAD` 60 · lana `CONTRIBUTOR` 25 · dana `OBSERVER` 5                       |
| `a3-005` | ben `LEAD` 30 · ada `REVIEWER` 5                                                 |
| `a3-006` | cara `LEAD` 40 · zoe `CONTRIBUTOR` 30 · ben `REVIEWER` 5                         |
| `b3-001` | davina `LEAD` 50 · marcus `CONTRIBUTOR` 20 · fay `OBSERVER` 5                    |
| `b3-002` | cara `LEAD` 40 · davina `CONTRIBUTOR` 10                                         |
| `b3-003` | lana `LEAD` 40 · omar `CONTRIBUTOR` 10 · gwen `OBSERVER` 5                       |
| `b3-004` | marcus `LEAD` 40 · lana `CONTRIBUTOR` 5 · fay `OBSERVER` 5                       |
| `c3-001` | davina `LEAD` 20                                                                 |
| `d3-001` | priya `LEAD` 30 · marcus `CONTRIBUTOR` 10                                        |
| `d3-002` | cara `LEAD` 30 · zoe `CONTRIBUTOR` 25                                            |

Ids: `e1-001…e1-035` in the table order above (row 1 = `e1000000-…0001`).
`added_by` = the project's lead (internal). `zoe`'s historical memberships stay
(restrict-on-delete evidence).

---

## 6. Work fixtures

### 6.1 Tasks (32)

`position` is board order within each project (1..n). Overdue = `due_date < T`
and status not in (`DONE`, `CANCELLED`). **10 tasks are overdue**, deliberately
spread across active, blocked and in-review states.

| Key      | Project  | Title                                  | Status        | Priority | Assignee | Assigned team        | Due        | Est/Actual | Notes                                                                         |
| -------- | -------- | -------------------------------------- | ------------- | -------- | -------- | -------------------- | ---------- | ---------- | ----------------------------------------------------------------------------- |
| `a7-001` | `a3-001` | Build the PDP template variant         | `IN_PROGRESS` | HIGH     | cara     | `SEO`                | T+3 d      | 12 / —     | pos 1 (legacy row, kept)                                                      |
| `a7-002` | `a3-001` | Investigate crawl budget anomaly       | `TODO`        | MEDIUM   | cara     | `SEO`                | T+10 d     | 4 / —      | pos 2 (legacy row, kept)                                                      |
| `a7-003` | `a3-001` | Finalize mobile template QA            | `TODO`        | HIGH     | cara     | `SEO`                | **T−3 d**  | 6 / —      | pos 3 · **OVERDUE**                                                           |
| `a7-004` | `a3-001` | Index scheduling regression            | `BLOCKED`     | URGENT   | davina   | `WEB_DEVELOPMENT`    | **T−5 d**  | 8 / —      | reason: `'Search Console historical data export pending'` · **OVERDUE**       |
| `a7-005` | `a3-001` | Roll out data layer to 1,200 pages     | `IN_REVIEW`   | HIGH     | davina   | `SEO`                | **T−1 d**  | 16 / 14    | pos 5 · **OVERDUE**                                                           |
| `a7-006` | `a3-001` | Deliverable QA pass on template set    | `DONE`        | MEDIUM   | cara     | `SEO`                | T−3 d      | 5 / 6      | completed T−3 d                                                               |
| `a7-007` | `a3-002` | Launch creative testing matrix v1      | `IN_PROGRESS` | HIGH     | priya    | `PAID_MEDIA`         | **T+1 d**  | 10 / —     | **due soon** → `TASK_DUE_SOON`                                                |
| `a7-008` | `a3-002` | CAPI match-rate monitoring             | `TODO`        | MEDIUM   | priya    | `PAID_MEDIA`         | **T−2 d**  | 6 / —      | **OVERDUE**                                                                   |
| `a7-009` | `a3-002` | Retargeting exclusion list buildout    | `DONE`        | MEDIUM   | priya    | `PAID_MEDIA`         | T−4 d      | 4 / 4      | completed T−4 d                                                               |
| `a7-010` | `a3-003` | Remove render-blocking CSS from PDP    | `IN_PROGRESS` | URGENT   | davina   | `WEB_DEVELOPMENT`    | **T−4 d**  | 9 / —      | **OVERDUE**                                                                   |
| `a7-011` | `a3-003` | Vendor JS budget audit                 | `BLOCKED`     | HIGH     | davina   | `WEB_DEVELOPMENT`    | **T−7 d**  | 5 / —      | reason: `'Awaiting client CMS admin access'` · **OVERDUE** (ties to `a8-007`) |
| `a7-012` | `a3-003` | LCP experiment analysis                | `DONE`        | MEDIUM   | davina   | `WEB_DEVELOPMENT`    | T−9 d      | 3 / 2      | completed T−9 d                                                               |
| `a7-013` | `a3-004` | Segment refresh for nurture            | `IN_REVIEW`   | HIGH     | omar     | `CRM_LIFECYCLE`      | T+2 d      | 8 / —      | pos 1                                                                         |
| `a7-014` | `a3-004` | Nurture sequence copy deck             | `DONE`        | HIGH     | omar     | `CRM_LIFECYCLE`      | T−2 d      | 6 / 6      | completed T−2 d                                                               |
| `a7-015` | `a3-004` | AI lead-scoring model v1               | `IN_PROGRESS` | MEDIUM   | lana     | `AI_AUTOMATION`      | **T−3 d**  | 14 / —     | cross-team contributor · **OVERDUE**                                          |
| `a7-016` | `a3-005` | Renewal pricing scenarios              | `IN_PROGRESS` | MEDIUM   | ben      | `ACCOUNT_MANAGEMENT` | T+14 d     | 6 / —      | internal project                                                              |
| `a7-017` | `a3-006` | Crawl implementation audit             | `DONE`        | HIGH     | cara     | `SEO`                | T−400 d    | 10 / 11    | completed T−380 d                                                             |
| `a7-018` | `a3-006` | Internal linking QA                    | `DONE`        | MEDIUM   | zoe      | `SEO`                | T−395 d    | 8 / 9      | completed T−370 d (zoe, pre-departure)                                        |
| `b7-001` | `b3-001` | Migrate contact form to edge functions | `IN_PROGRESS` | URGENT   | davina   | `WEB_DEVELOPMENT`    | T+10 d     | 12 / —     | pos 1                                                                         |
| `b7-002` | `b3-001` | CSP header rollout                     | `BLOCKED`     | HIGH     | davina   | `WEB_DEVELOPMENT`    | **T−2 d**  | 4 / —      | reason: `'Security review approval pending'` · **OVERDUE**                    |
| `b7-003` | `b3-001` | Design tokens export pipeline          | `DONE`        | MEDIUM   | marcus   | `WEB_DEVELOPMENT`    | T−6 d      | 5 / 4      | completed T−6 d                                                               |
| `b7-004` | `b3-002` | Build 301 map for legacy URLs          | `IN_PROGRESS` | HIGH     | cara     | `SEO`                | T+5 d      | 10 / —     | pos 1                                                                         |
| `b7-005` | `b3-002` | Canonical audit                        | `TODO`        | MEDIUM   | cara     | `SEO`                | T+12 d     | 4 / —      | pos 2                                                                         |
| `b7-006` | `b3-003` | RAG ingest pipeline v1                 | `IN_PROGRESS` | HIGH     | lana     | `AI_AUTOMATION`      | **T−1 d**  | 20 / —     | **OVERDUE**                                                                   |
| `b7-007` | `b3-003` | Map 12 automation candidates           | `TODO`        | MEDIUM   | lana     | `AI_AUTOMATION`      | T+14 d     | 8 / —      | pos 2                                                                         |
| `b7-008` | `b3-004` | Storyboard episode 1                   | `DONE`        | HIGH     | marcus   | `VIDEO_MULTIMEDIA`   | T−10 d     | 3 / 3      | completed T−10 d                                                              |
| `b7-009` | `b3-004` | Edit episode 1 cut                     | `IN_REVIEW`   | HIGH     | marcus   | `VIDEO_MULTIMEDIA`   | T+4 d      | 6 / —      | pos 2                                                                         |
| `c7-001` | `c3-001` | Stakeholder interview synthesis        | `TODO`        | MEDIUM   | —        | `WEB_DEVELOPMENT`    | T+21 d     | 6 / —      | pos 1 (unassigned — team queue)                                               |
| `d7-001` | `d3-001` | Rebuild creative refresh calendar      | `BLOCKED`     | HIGH     | priya    | `PAID_MEDIA`         | **T−21 d** | 6 / —      | reason: `'Client account suspended — awaiting reactivation'` · **OVERDUE**    |
| `d7-002` | `d3-001` | Pause flight pacing                    | `DONE`        | MEDIUM   | priya    | `PAID_MEDIA`         | T−60 d     | 2 / 2      | completed T−60 d                                                              |
| `d7-003` | `d3-002` | Authority content sprint brief         | `DONE`        | HIGH     | cara     | `SEO`                | T−390 d    | 8 / 8      | completed T−390 d                                                             |
| `d7-004` | `d3-002` | Editorial QA                           | `DONE`        | MEDIUM   | zoe      | `SEO`                | T−380 d    | 5 / 5      | completed T−380 d                                                             |

- ADR-0005 edge is visible: tasks `a7-001`, `a7-006`, `a7-013`, `b7-008`,
  `b7-009` carry a `deliverable_id`; the rest are project-only.
- Unassigned-queue shape: add `c7-001` with `assignee_user_id = null` and
  `assigned_team = 'WEB_DEVELOPMENT'` (one deliberately unassigned task;
  the board's team queue is exercised).

### 6.2 Deliverables (19 seeded + 1 reserved)

`b4-002` is **reserved for the Phase 4 attack harness** and must not be seeded
(§11.4).

| Key      | Project  | Title                             | Type                | Status               | Visible | Due     | Owner  | Submitted | Approved        |
| -------- | -------- | --------------------------------- | ------------------- | -------------------- | ------- | ------- | ------ | --------- | --------------- |
| `a4-001` | `a3-001` | Category template set v1          | `PAGE_TEMPLATE_SET` | `CLIENT_REVIEW`      | true    | T+7 d   | cara   | T−2 d     | —               |
| `a4-002` | `a3-001` | Indexation audit                  | `AUDIT`             | `IN_PROGRESS`        | false   | T+21 d  | cara   | —         | —               |
| `a4-003` | `a3-001` | Template set v2 — mobile variants | `PAGE_TEMPLATE_SET` | **`APPROVED`**       | true    | T−1 d   | cara   | T−6 d     | dana @ T−3 d    |
| `a4-004` | `a3-001` | Q3 SEO playbook                   | `DOCUMENT`          | `PUBLISHED`          | true    | T−10 d  | cara   | T−12 d    | dana @ T−11 d   |
| `a4-005` | `a3-002` | Q3 paid growth campaign           | `CAMPAIGN`          | `CLIENT_REVIEW`      | true    | T+2 d   | priya  | T−1 d     | —               |
| `a4-006` | `a3-002` | Creative testing framework        | `DOCUMENT`          | `SUBMITTED`          | true    | T−2 d   | priya  | T−4 d     | —               |
| `a4-007` | `a3-003` | LCP remediation bundle            | `DOCUMENT`          | `INTERNAL_REVIEW`    | false   | T−3 d   | davina | T−5 d     | —               |
| `a4-008` | `a3-003` | CWV field data review             | `AUDIT`             | `DRAFT`              | false   | T+14 d  | davina | —         | —               |
| `a4-009` | `a3-004` | Nurture sequence v1               | `AUTOMATION`        | `REVISION_REQUESTED` | true    | T+5 d   | omar   | T−8 d     | —               |
| `a4-010` | `a3-004` | Nurture sequence v2               | `AUTOMATION`        | **`APPROVED`**       | true    | T+9 d   | omar   | T−2 d     | dana @ T−1 d    |
| `a4-011` | `a3-006` | Site authority audit              | `AUDIT`             | `PUBLISHED`          | true    | T−400 d | cara   | T−405 d   | dana @ T−404 d  |
| `b4-001` | `b3-001` | Design system foundations         | `DESIGN`            | `IN_PROGRESS`        | false   | T+14 d  | davina | —         | —               |
| `b4-002` | —        | **RESERVED — do not seed**        |                     |                      |         |         |        |           |                 |
| `b4-003` | `b3-001` | Site rebuild scope doc            | `DOCUMENT`          | `INTERNAL_REVIEW`    | false   | T+7 d   | davina | T−3 d     | —               |
| `b4-004` | `b3-004` | Founder video — episode 1         | `VIDEO`             | `CLIENT_REVIEW`      | true    | T+3 d   | marcus | T−1 d     | —               |
| `b4-005` | `b3-004` | Episode 1 title pack & thumbnails | `DESIGN`            | **`APPROVED`**       | true    | T−2 d   | marcus | T−5 d     | fay @ T−2 d     |
| `b4-006` | `b3-003` | RAG connector POC                 | `AUTOMATION`        | `CLIENT_REVIEW`      | true    | T+6 d   | lana   | T−1 d     | —               |
| `b4-007` | `b3-002` | Redirect & 301 map                | `DOCUMENT`          | `IN_PROGRESS`        | false   | T+9 d   | cara   | —         | —               |
| `d4-001` | `d3-001` | Paid creative set v1              | `CAMPAIGN`          | `IN_PROGRESS`        | false   | T−30 d  | priya  | —         | —               |
| `d4-002` | `d3-002` | Technical SEO audit               | `AUDIT`             | `PUBLISHED`          | true    | T−380 d | cara   | T−382 d   | umbra @ T−380 d |

- Pending deliverables (client-facing, awaiting action): `a4-001`, `a4-005`,
  `b4-004`, `b4-006` (`CLIENT_REVIEW`) plus internally submitted `a4-006`.
- Approved deliverables: `a4-003`, `a4-010`, `b4-005` — each with `approved_at`
  and `approved_by` (client admins dana/fay), satisfying the schema CHECK.
- "Approval then publish" is shown on `a4-004`, `a4-011`, `d4-002`.
- Deliverable types covered: `PAGE_TEMPLATE_SET`, `AUDIT`, `DOCUMENT`,
  `CAMPAIGN`, `AUTOMATION`, `DESIGN`, `VIDEO`.
- Every `CLIENT_REVIEW`/`REVISION_REQUESTED`/`APPROVED`/`PUBLISHED` row has
  `client_visible = true` (schema requires it); every non-terminal internal row
  is `false`.
- Schema note: `deliverables_submitted_requires_timestamp` exempts only
  `DRAFT`/`IN_PROGRESS`/`CANCELLED`, so the two `INTERNAL_REVIEW` rows
  (`a4-007`, `b4-003`) also carry `submitted_at` — recorded in §15.5.

### 6.3 Deliverable versions (13)

Append-only history that makes the workflow auditable. `status` on a version
is `SUBMITTED` (the state at submission); review fields describe the outcome.
`id` family `a6-/b6-/d6-…`.

| Key | Deliverable | Version | Reviewed by | Outcome | Review notes | At |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `a6-001` | `a4-001` | 1 | — | — | — | submitted T−2 d |
| `a6-002` | `a4-003` | 1 | dana | `REVISION_REQUESTED` | `'Add explicit mobile breakpoint variants before approval.'` | submitted T−6 d, reviewed T−5 d |
| `a6-003` | `a4-003` | 2 | dana | `APPROVED` | `'Mobile variants look right — approving.'` | submitted T−3 d, reviewed T−3 d |
| `a6-004` | `a4-004` | 1 | dana | `APPROVED` | `'Approved for publication.'` | submitted T−12 d, reviewed T−11 d |
| `a6-005` | `a4-005` | 1 | — | — | — | submitted T−1 d |
| `a6-006` | `a4-006` | 1 | — | — | — | submitted T−4 d |
| `a6-007` | `a4-009` | 1 | dana | `REVISION_REQUESTED` | `'Swap emails 3 and 4 in the nurture sequence.'` | submitted T−8 d, reviewed T−4 d |
| `a6-008` | `a4-010` | 1 | dana | `APPROVED` | `'Approved.'` | submitted T−2 d, reviewed T−1 d |
| `a6-009` | `a4-011` | 1 | dana | `APPROVED` | `'Approved — sign off on the audit.'` | submitted T−405 d, reviewed T−404 d |
| `b6-001` | `b4-004` | 1 | — | — | — | submitted T−1 d |
| `b6-002` | `b4-005` | 1 | fay | `APPROVED` | `'Title pack approved.'` | submitted T−5 d, reviewed T−2 d |
| `b6-003` | `b4-006` | 1 | — | — | — | submitted T−1 d |
| `d6-001` | `d4-002` | 1 | umbra | `APPROVED` | `'Approved for publication.'` | submitted T−382 d, reviewed T−380 d |

Note `a6-002`/`a6-003` and `a6-007`/`a6-008` give the **revision loop** two
real cycles with version numbers 1→2.

### 6.4 Comments (12)

| Key      | Parent   | Subject              | Author | Body                                                                                  | Internal | At      |
| -------- | -------- | -------------------- | ------ | ------------------------------------------------------------------------------------- | -------- | ------- |
| `a8-001` | —        | deliverable `a4-001` | dana   | `'Looks strong. Can we see the mobile breakpoint before we approve?'`                 | false    | T−2 d   |
| `a8-002` | —        | deliverable `a4-001` | cara   | `'Mobile variant is behind a flag; margin is tight on this one.'`                     | true     | T−2 d   |
| `a8-003` | —        | deliverable `a4-009` | dana   | `'Revision: swap emails 3 and 4 in the nurture sequence.'`                            | false    | T−4 d   |
| `a8-004` | `a8-003` | deliverable `a4-009` | omar   | `'Adjusted; v2 is uploaded.'`                                                         | true     | T−2 d   |
| `a8-005` | —        | deliverable `a4-005` | priya  | `'Loving the creative direction @cara — can you confirm the channel variation list?'` | false    | T−1 d   |
| `a8-006` | —        | deliverable `a4-007` | davina | `'LCP bundle is internal until the CWV picture stabilises.'`                          | true     | T−3 d   |
| `a8-007` | —        | task `a7-011`        | davina | `'Blocked on CMS admin access from the client side.'`                                 | true     | T−6 d   |
| `a8-008` | —        | deliverable `a4-001` | eli    | `'Confirming once the mobile variant is visible.'`                                    | false    | T−1 d   |
| `a8-009` | —        | deliverable `a4-010` | dana   | `'Approving v2. Ship it.'`                                                            | false    | T−1 d   |
| `b8-001` | —        | deliverable `b4-004` | fay    | `'Love the first cut — one small edit at 02:14.'`                                     | false    | T−1 d   |
| `b8-002` | `b8-001` | deliverable `b4-004` | marcus | `'Edit flagged; new cut tomorrow.'`                                                   | false    | T−1 d   |
| `d8-001` | —        | deliverable `d4-002` | umbra  | `'Great depth. Approving.'`                                                           | false    | T−380 d |

- Threads: `a8-004` replies to `a8-003`; `b8-002` replies to `b8-001`
  (one level only — the schema's rule).
- Internal-only discussion: `a8-002`, `a8-004`, `a8-006`, `a8-007` — RLS
  filters these from client roles.
- Client-authored task comment would be illegal (trigger) — the seed exercises
  only the legal shapes: client comments on deliverables, internal comments on
  tasks and deliverables.

---

## 7. Reporting, communication and storage

### 7.1 Metrics (~350 rows)

Deterministic time-series, generated with fixed formulas over fixed windows:

```
value = round(base + day_index * step + (day_index % 7) * wobble, 2)
```

`day_index = 0` at the series start, increasing toward T. No `random()`; a
formula is deterministic by construction. Series are derived from `T` so charts
always end at a live date.

| Org | Metric key              | Service  | Unit           | Source           | Cadence | Window | base / step / wobble     |
| --- | ----------------------- | -------- | -------------- | ---------------- | ------- | ------ | ------------------------ |
| ACM | `PAGES_INDEXED`         | `a2-001` | `COUNT`        | `SEARCH_CONSOLE` | daily   | 90 d   | 800 / 37 / 12            |
| ACM | `SESSIONS`              | —        | `COUNT`        | `GA4`            | daily   | 90 d   | 4200 / −8 / 34           |
| ACM | `CONVERSION_RATE`       | —        | `PERCENT`      | `GA4`            | daily   | 90 d   | 2.1 / 0.004 / 0.05       |
| ACM | `P75_LCP_MS`            | `a2-002` | `MILLISECONDS` | `CRUX`           | weekly  | 13 w   | 1,740 / −12 / 60         |
| ACM | `BLENDED_ROAS`          | `a2-003` | `RATIO`        | `INTERNAL`       | daily   | 90 d   | 3.6 / 0.006 / 0.08       |
| ACM | `CPA`                   | `a2-003` | `CURRENCY` USD | `GOOGLE_ADS`     | daily   | 90 d   | 61.5 / −0.05 / 2.2       |
| ACM | `CTR`                   | `a2-003` | `PERCENT`      | `META_ADS`       | daily   | 90 d   | 1.9 / 0.003 / 0.04       |
| ACM | `CAPI_MATCH_RATE`       | `a2-003` | `PERCENT`      | `INTERNAL`       | daily   | 90 d   | 74 / 0.02 / 0.6          |
| ACM | `MQL_COUNT`             | `a2-004` | `COUNT`        | `CRM`            | weekly  | 13 w   | 38 / 0.4 / 3             |
| ACM | `SQL_COUNT`             | `a2-004` | `COUNT`        | `CRM`            | weekly  | 13 w   | 14 / 0.2 / 2             |
| ACM | `LEAD_RESPONSE_MINUTES` | `a2-004` | `MINUTES`      | `CRM`            | daily   | 90 d   | 41 / −0.04 / 2.5         |
| ACM | `PIPELINE_ENGINEERED`   | `a2-004` | `CURRENCY` USD | `CRM`            | weekly  | 13 w   | 185,000 / 2,200 / 15,000 |
| ACM | `LTV_CAC_RATIO`         | —        | `RATIO`        | `INTERNAL`       | monthly | 4 m    | 3.1 / 0.02 / 0.04        |
| ACM | `REVENUE`               | —        | `CURRENCY` USD | `CRM`            | weekly  | 13 w   | 42,000 / 380 / 2,100     |
| GLX | `P75_LCP_MS`            | `b2-001` | `MILLISECONDS` | `CRUX`           | weekly  | 13 w   | 2,980 / −38 / 90         |
| GLX | `SESSIONS`              | —        | `COUNT`        | `GA4`            | daily   | 60 d   | 1,100 / 4 / 15           |
| GLX | `REVENUE`               | —        | `CURRENCY` GBP | `CRM`            | weekly  | 9 w    | 9,600 / 120 / 700        |
| GLX | `CAPI_MATCH_RATE`       | `b2-002` | `PERCENT`      | `INTERNAL`       | daily   | 60 d   | 68 / 0.05 / 0.8          |
| GLX | `BLENDED_ROAS`          | `b2-003` | `RATIO`        | `INTERNAL`       | weekly  | 9 w    | 2.4 / 0.01 / 0.05        |
| UMB | `BLENDED_ROAS`          | `d2-001` | `RATIO`        | `INTERNAL`       | weekly  | 13 w   | 3.9 / 0 / 0.05           | stops at T−60 d  |
| UMB | `PAGES_INDEXED`         | `d2-002` | `COUNT`        | `SEARCH_CONSOLE` | daily   | 120 d  | 240 / 2 / 5              | stops at T−380 d |

- Org-level keys (`service_id = null`) are allowed and exercise
  `metrics_unique_point`'s coalesce path.
- No `metrics` rows for Initech (nothing measured yet).
- `currency` is present exactly when `unit = CURRENCY` (schema CHECK).

### 7.2 Reports (8) and frozen metrics (~30)

| Key      | Engagement | Title                            | Type                | Status            | Currency | Period          | Published      |
| -------- | ---------- | -------------------------------- | ------------------- | ----------------- | -------- | --------------- | -------------- |
| `a5-001` | `a1-001`   | Monthly performance — last month | `PERFORMANCE`       | **`PUBLISHED`**   | USD      | month(T−1)      | T−5 d by ben   |
| `a5-002` | `a1-001`   | Q3 executive snapshot            | `EXECUTIVE_SUMMARY` | **`PUBLISHED`**   | USD      | T−90 d…T−1 d    | T−3 d by ben   |
| `a5-003` | `a1-001`   | Paid media mid-month             | `CAMPAIGN`          | `DRAFT`           | USD      | T−15 d…T−1 d    | —              |
| `a5-004` | `a1-002`   | 2025 site authority audit report | `TECHNICAL_AUDIT`   | `ARCHIVED`        | USD      | T−420 d…T−280 d | T−380 d by ben |
| `b5-001` | `b1-001`   | Kickoff baseline & CWV audit     | `TECHNICAL_AUDIT`   | **`PUBLISHED`**   | GBP      | T−89 d…T−30 d   | T−60 d by ben  |
| `b5-002` | `b1-001`   | Rebuild phase one status         | `PERFORMANCE`       | `INTERNAL_REVIEW` | GBP      | T−29 d…T−1 d    | —              |
| `d5-001` | `d1-002`   | 2024 Q4 final performance        | `PERFORMANCE`       | **`PUBLISHED`**   | AUD      | T−390 d…T−330 d | T−350 d by ben |
| `d5-002` | `d1-001`   | Paid retargeting brief           | `CAMPAIGN`          | `DRAFT`           | AUD      | T−45 d…T−1 d    | —              |

- Published reports: `a5-001`, `a5-002`, `b5-001`, `d5-001` — each
  `client_visible = true` with `published_at` + `published_by`.
- `report_metrics` snapshots (append-only): **each** report carries 3–5 frozen
  `(metric_key, value, unit, currency, comparison_value,
comparison_label, sort_order)` rows copied from the metrics series
  (drafts included — a draft snapshot is as immovable as a published one),
  e.g. `a5-001`: `PIPELINE_ENGINEERED` 185,000 / `BLENDED_ROAS` 4.20 /
  `PAGES_INDEXED` 1,892, each with `comparison_value` and `'Previous month'`.
- `a5-003`/`b5-002`/`d5-002` are the **invisible-draft** rows the client feed
  must never show.
- `a5-004` is a **published-then-archived** report (history only).

### 7.3 Notifications (24) — all 11 types

| Key      | Recipient | Org | Type                    | Severity | Subject              | Read / archived           |
| -------- | --------- | --- | ----------------------- | -------- | -------------------- | ------------------------- |
| `e5-001` | dana      | ACM | `DELIVERABLE_SUBMITTED` | INFO     | deliverable `a4-003` | read                      |
| `e5-002` | cara      | ACM | `DELIVERABLE_APPROVED`  | INFO     | deliverable `a4-003` | read                      |
| `e5-003` | omar      | ACM | `REVISION_REQUESTED`    | WARNING  | deliverable `a4-009` | **unread**                |
| `e5-004` | dana      | ACM | `REPORT_PUBLISHED`      | INFO     | report `a5-001`      | read + **archived**       |
| `e5-005` | dana      | ACM | `REPORT_PUBLISHED`      | INFO     | report `a5-002`      | **unread**                |
| `e5-006` | priya     | ACM | `TASK_ASSIGNED`         | INFO     | task `a7-007`        | read                      |
| `e5-007` | priya     | ACM | `TASK_DUE_SOON`         | WARNING  | task `a7-007`        | **unread**                |
| `e5-008` | cara      | ACM | `COMMENT_ADDED`         | INFO     | comment `a8-008`     | **unread**                |
| `e5-009` | cara      | ACM | `MENTION`               | INFO     | comment `a8-005`     | **unread**                |
| `e5-010` | dana      | ACM | `INVITATION_SENT`       | INFO     | —                    | read                      |
| `e5-011` | nova      | ACM | `MEMBERSHIP_CHANGED`    | INFO     | —                    | **unread**                |
| `e5-012` | susie     | ACM | `MEMBERSHIP_CHANGED`    | WARNING  | —                    | read (suspension in Acme) |
| `e5-013` | fay       | GLX | `DELIVERABLE_SUBMITTED` | INFO     | deliverable `b4-004` | **unread**                |
| `e5-014` | marcus    | GLX | `DELIVERABLE_APPROVED`  | INFO     | deliverable `b4-005` | read                      |
| `e5-015` | fay       | GLX | `REPORT_PUBLISHED`      | INFO     | report `b5-001`      | read                      |
| `e5-016` | davina    | GLX | `TASK_ASSIGNED`         | INFO     | task `b7-002`        | read                      |
| `e5-017` | lana      | GLX | `TASK_ASSIGNED`         | INFO     | task `b7-006`        | read                      |
| `e5-018` | marcus    | GLX | `COMMENT_ADDED`         | INFO     | comment `b8-001`     | **unread**                |
| `e5-019` | umbra     | UMB | `MEMBERSHIP_CHANGED`    | WARNING  | —                    | **unread** (suspension)   |
| `e5-020` | umari     | UMB | `REPORT_PUBLISHED`      | INFO     | report `d5-001`      | read                      |
| `e5-021` | priya     | UMB | `TASK_DUE_SOON`         | WARNING  | task `d7-001`        | **unread**                |
| `e5-022` | cara      | ACM | `REVISION_REQUESTED`    | INFO     | deliverable `a4-003` | read (v1 revision)        |
| `e5-023` | ben       | ICH | `INVITATION_SENT`       | INFO     | —                    | read (Initech invites)    |
| `e5-024` | ada       | —   | `SYSTEM`                | INFO     | —                    | read (platform notice)    |

All 11 `notification_type` values appear:
`DELIVERABLE_SUBMITTED`, `DELIVERABLE_APPROVED`, `REVISION_REQUESTED`,
`REPORT_PUBLISHED`, `TASK_ASSIGNED`, `TASK_DUE_SOON`, `COMMENT_ADDED`,
`MENTION`, `INVITATION_SENT`, `MEMBERSHIP_CHANGED`, `SYSTEM`.

- `subject_entity`/`subject_id` are both set or both null (schema rule);
  `action_url` is relative (`/portal/acme-industrials/deliverable/a4-003`,
  `/admin/…` for staff) and matches the action_url regex.
- Recipients without a profile (ilana/ivan) are **not** notification recipients:
  `INVITATION_SENT` goes to the inviter (`ben`) — the trigger's recipient-FK
  makes this the only legal shape.
- Unread counts by user (for badge tests): dana 1, cara 2, omar 1, priya 2,
  nova 1, susie 0, fay 1, marcus 1, lana 0, davina 0, umbra 1, umari 0, ben 0.

### 7.4 Invitations (7) — all 4 statuses

| Key      | Email                | Branch              | Status     | Invited by | Expires | Accepted / revoked                            |
| -------- | -------------------- | ------------------- | ---------- | ---------- | ------- | --------------------------------------------- |
| `e4-001` | `ilana@initech.test` | ICH `CLIENT_ADMIN`  | `PENDING`  | ben        | T+7 d   | — (invited client)                            |
| `e4-002` | `ivan@initech.test`  | ICH `CLIENT_MEMBER` | `PENDING`  | ben        | T+7 d   | —                                             |
| `e4-003` | `idris@initech.test` | ICH `CLIENT_MEMBER` | `REVOKED`  | ben        | T+6 d   | revoked by ben @ T−1 d (reissued as `e4-002`) |
| `e4-004` | `gwen@globex.test`   | GLX `CLIENT_MEMBER` | `ACCEPTED` | fay        | T+60 d  | accepted by gwen @ T−60 d                     |
| `e4-005` | `newcomer@acme.test` | ACM `CLIENT_MEMBER` | `PENDING`  | dana       | T+7 d   | — (legacy row, kept)                          |
| `e4-006` | `sam@acme.test`      | ACM `CLIENT_MEMBER` | `EXPIRED`  | dana       | T−30 d  | —                                             |
| `e4-007` | `zoe@growlith.test`  | staff `ADMIN`       | `ACCEPTED` | ada        | T−400 d | accepted by zoe @ T−420 d (staff branch)      |

- `token_hash = encode(extensions.digest('growlith-seed-invite:' || email, 'sha256'), 'hex')`
  — deterministic, never the raw token. The dev token strings are
  `growlith-seed-invite:ilana@initech.test` etc. and are documented in
  `docs/runbooks/local-development.md` at implementation time.
- `resent_count`/`last_sent_at` show one resend on `e4-001`.
- Both branches exercised: client invitations (org + org role) and a staff
  invitation (platform role) — the `invitations_exactly_one_branch` CHECK.

### 7.5 Files and metadata (14) + storage objects (14)

| Key      | Org | Kind                | File name                          | MIME                                                                    | Parent                                 | Client visible | Scan        | Uploaded by | Path (under `{orgId}/`)                             |
| -------- | --- | ------------------- | ---------------------------------- | ----------------------------------------------------------------------- | -------------------------------------- | -------------- | ----------- | ----------- | --------------------------------------------------- |
| `a9-001` | ACM | `BRAND_ASSET`       | `acme-logo.png`                    | image/png                                                               | —                                      | true           | CLEAN       | dana        | `seed/brand/acme-logo.png`                          |
| `a9-002` | ACM | `CONTRACT`          | `acm-2026-r1-msa.pdf`              | application/pdf                                                         | —                                      | **false**      | CLEAN       | ben         | `seed/contract/acm-2026-r1-msa.pdf`                 |
| `a9-003` | ACM | `DELIVERABLE_ASSET` | `category-template-v1-preview.pdf` | application/pdf                                                         | deliverable `a4-001`, version `a6-001` | true           | CLEAN       | cara        | `seed/deliverable/category-template-v1-preview.pdf` |
| `a9-004` | ACM | `REPORT_EXPORT`     | `monthly-performance.xlsx`         | application/vnd.openxmlformats-officedocument.spreadsheetml.sheet       | report `a5-001`                        | true           | CLEAN       | ben         | `seed/report/monthly-performance.xlsx`              |
| `a9-005` | ACM | `ATTACHMENT`        | `dana-feedback.docx`               | application/vnd.openxmlformats-officedocument.wordprocessingml.document | comment `a8-001`                       | true           | CLEAN       | dana        | `seed/attachment/dana-feedback.docx`                |
| `a9-006` | ACM | `DELIVERABLE_ASSET` | `cwv-baseline-raw.csv`             | text/csv                                                                | deliverable `a4-008`                   | **false**      | **PENDING** | davina      | `seed/deliverable/cwv-baseline-raw.csv`             |
| `a9-007` | ACM | `DELIVERABLE_ASSET` | `nurture-v2-assets.zip`            | application/zip                                                         | deliverable `a4-010`, version `a6-008` | true           | CLEAN       | omar        | `seed/deliverable/nurture-v2-assets.zip`            |
| `a9-008` | ACM | `AVATAR`            | `dana-avatar.png`                  | image/png                                                               | —                                      | true           | CLEAN       | dana        | `seed/avatar/dana-avatar.png`                       |
| `b9-001` | GLX | `BRAND_ASSET`       | `globex-logo.png`                  | image/png                                                               | —                                      | true           | CLEAN       | fay         | `seed/brand/globex-logo.png`                        |
| `b9-002` | GLX | `DELIVERABLE_ASSET` | `design-system-foundations.pdf`    | application/pdf                                                         | deliverable `b4-001`                   | **false**      | CLEAN       | davina      | `seed/deliverable/design-system-foundations.pdf`    |
| `b9-003` | GLX | `DELIVERABLE_ASSET` | `episode-1-master.mp4`             | video/mp4                                                               | deliverable `b4-004`                   | true           | CLEAN       | marcus      | `seed/deliverable/episode-1-master.mp4`             |
| `b9-004` | GLX | `REPORT_EXPORT`     | `glx-kickoff-audit.pdf`            | application/pdf                                                         | report `b5-001`                        | true           | CLEAN       | ben         | `seed/report/glx-kickoff-audit.pdf`                 |
| `d9-001` | UMB | `CONTRACT`          | `umb-2025-r1-msa.pdf`              | application/pdf                                                         | —                                      | **false**      | CLEAN       | ben         | `seed/contract/umb-2025-r1-msa.pdf`                 |
| `d9-002` | UMB | `REPORT_EXPORT`     | `umb-2024-q4.pdf`                  | application/pdf                                                         | report `d5-001`                        | true           | CLEAN       | ben         | `seed/report/umb-2024-q4.pdf`                       |

- `checksum_sha256 = encode(extensions.digest('growlith-seed-file:' || <file-id>, 'sha256'), 'hex')`
  — deterministic, 64-hex, **not** a real digest of real bytes.
- `size_bytes` is a fixed plausible value (>0); `virus_scan_status = 'PENDING'`
  exactly once (`a9-006`) to exercise the scan queue; every `CLEAN` row has
  `scanned_at`.
- One file per owner-kind combination: org brand asset, internal contract,
  deliverable+version asset, report export, comment attachment, avatar, and a
  pending-scan row. `files` and `storage.objects` rows are inserted together
  with identical `storage_path`; `storage.objects.bucket_id =
'growlith-private'`, `owner = uploaded_by`, `created_at` backdated.
- `organization_settings.logo_file_id` is set to `a9-001` (ACM) and `b9-001`
  (GLX); `dana`'s `profiles.avatar_path` points at `a9-008`'s path.

---

## 8. Activity history (72 curated audit events)

### 8.1 Approach

`audit_events` is **append-only** (UPDATE/DELETE rejected for every role), so a
realistic multi-month trail cannot be produced by "seeding the tables and
letting the audit trigger run": every INSERT would stamp `occurred_at = now()`
and `actor_user_id = null`. The seed therefore:

1. **Surgically disables only the 12 `<table>_audit` triggers**
   (`organizations`, `engagements`, `services`, `projects`, `deliverables`,
   `tasks`, `comments`, `files`, `reports`, `organization_memberships`,
   `platform_role_grants`, `project_memberships`) for the duration of the seed
   transaction, and **re-enables them before commit**.
   - All other triggers stay ON: org derivation, composite-FK tenancy,
     status transitions, soft-delete coherence, team activity,
     `enforce_*` triggers — the seed still exercises every real constraint
     path. Only the audit _projection_ is handled explicitly.
   - Rationale: the audit trigger is the one piece of machinery whose output
     _cannot_ be corrected afterwards (append-only). A seed that produces
     72 identical "created now, by nobody" events would be worse than no
     history.
   - Crash-safety: `ALTER TABLE … DISABLE TRIGGER` is transactional; a
     mid-seed failure rolls back the disable too, so trigger state can never
     leak in a disabled state.
2. **Creates the required monthly partitions** by calling the _existing_
   idempotent helper `growlith.ensure_audit_partition(month)` for every month
   from T−8 months through the current month. (Migration 21 only creates the
   current month + 12 ahead; back-dated inserts would otherwise fail with
   "no partition of relation found".)
3. **Inserts the curated trail directly** with explicit `occurred_at`,
   `actor_user_id`, `actor_role`, `actor_ip`, `request_id` (`seed-0001` …),
   `entity_kind`, `entity_id`, `action`, `severity`, `changed_fields`,
   minimal `before`/`after` jsonb, and `reason` = `'Seed fixture'` (or a
   short human note).

### 8.2 Curated event families (counts are fixed at implementation)

| Family                    | Actions                                                                                  | Count  | Example / purpose                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acme delivery timeline    | `CREATE`, `STATUS_CHANGE`, `UPDATE` on engagement/service/project/deliverable            | 27     | category templates: `IN_PROGRESS → INTERNAL_REVIEW → SUBMITTED → CLIENT_REVIEW → REVISION_REQUESTED → IN_PROGRESS → INTERNAL_REVIEW → SUBMITTED → CLIENT_REVIEW → APPROVED` (a4-003 covers the full legal loop) |
| Acme client-facing        | `CREATE` on comment, `STATUS_CHANGE`/`CREATE` on report, `FILE_DOWNLOAD`, `EXPORT`       | 6      | `a5-001` published T−5 d; `a9-003` downloaded by dana T−2 d                                                                                                                                                     |
| Globex timeline           | `CREATE`, `STATUS_CHANGE`, `UPDATE`                                                      | 16     | rebuild kickoff → episode 1 submitted → title pack approved                                                                                                                                                     |
| Umbrella timeline         | `CREATE`, `STATUS_CHANGE`, `UPDATE`                                                      | 10     | retainer paused T−60 d (`ACTIVE→PAUSED`, reason stored); completed 2024 sprint                                                                                                                                  |
| Initech onboarding        | `CREATE` on organization/engagement, `INVITE_SENT`, `LOGIN` (ben)                        | 4      | invitations sent T−14 d                                                                                                                                                                                         |
| Identity & power (global) | `LOGIN`, `LOGIN_FAILED`, `ROLE_GRANT`, `ROLE_REVOKE`                                     | 6      | ada login; zoe grant revoked (CRITICAL); dana failed login T−20 d (WARNING — security feed)                                                                                                                     |
| Denial                    | `PERMISSION_DENIED` (WARNING)                                                            | 1      | fay probes an Acme deliverable id T−10 d (defence-in-depth feed row)                                                                                                                                            |
| Other audit pairs         | `INVITE_ACCEPTED`, `MEMBERSHIP_CHANGED`-style `UPDATE`, `SOFT_DELETE` (zoe's membership) | 2      | gwen accepted T−60 d; zoe team membership soft-deleted T−90 d                                                                                                                                                   |
| **Total**                 |                                                                                          | **72** | fixed expected count, asserted by seed-verify                                                                                                                                                                   |

- The curated trail covers **all** actions a client feed can surface
  (`CREATE`, `UPDATE`, `STATUS_CHANGE`, `SOFT_DELETE`) on
  engagement/service/project/deliverable/report/comment, so
  `client_activity_feed` has real pagination material per tenant.
- Staff-side events (`LOGIN`, `LOGIN_FAILED`, `ROLE_GRANT`,
  `ROLE_REVOKE`, `PERMISSION_DENIED`, `EXPORT`, `FILE_DOWNLOAD`) use
  `entity_kind` values the client feed allow-list deliberately excludes, so
  they populate the admin activity feed without leaking.
- `occurred_at` values are the story's exact timestamps (e.g. `T−5 d 09:30:00
UTC`); within a day, order is fixed and monotonic.

### 8.3 Idempotency of the trail

Because `audit_events` has no natural unique key, each curated row is inserted
with a guard:

```sql
insert into public.audit_events (…)
select …
where not exists (
  select 1 from public.audit_events a
  where a.organization_id is not distinct from <org>
    and a.entity_kind = <kind> and a.entity_id = <id>
    and a.action = <action> and a.occurred_at = <ts>
);
```

No updates, no deletes — append-only is preserved and re-runs are no-ops.

---

## 9. Determinism

### 9.1 IDs — one scheme, no collisions

Covered in §4.1. Additional rules:

- **Every seeded row with an `id` column pins its id.** No
  `gen_random_uuid()` anywhere in the seed.
- Two exceptions, both documented rather than accidental:
  - **Metrics**: their _identity_ is the natural key
    `(organization_id, coalesce(service_id, 0), metric_key, metric_date)`, so
    they insert without an id and conflict on the partial unique index.
    Deterministic ids would add nothing; determinism of values is what matters.
  - **`storage.objects`**: nothing references its `id`, so rows are inserted
    without one and keyed by `(bucket_id, name)`.
- `organization_settings` is keyed by `organization_id` (1:1) — no separate id.

### 9.2 Values — no randomness, no unseeded defaults

- No `random()`, `clock_timestamp()`, `gen_random_uuid()`.
- Every `created_at`, submit/approve/publish/join/sign/complete timestamp is
  explicit (§3).
- Metric values come from fixed formulas (§7.1); report snapshots are fixed
  numbers; notification bodies/titles are fixed prose; file sizes are fixed.
- Token hashes/checksums are deterministic digests of fixed seed strings.

### 9.3 Compatibility with existing tooling (non-negotiable)

| Consumer                      | Dependency                                                                                                                                             | Phase 7 obligation                                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/db-authz-attack.mjs` | actors ada/ben/cara/dana/eli/fay; orgs acme/globex; `a1-001`, `a2-001`, `a3-001`, `a4-001`, `a4-002`, `a5-001`, `b1-001`, `b2-001`, `b3-001`, `b4-001` | Keep every legacy **id, role, organization and status/visibility** intact; only non-authoritative metadata (e.g. a service lead) may be enriched |
| Same harness                  | inserts `b4-002` (Globex `CLIENT_REVIEW` deliverable), `newcomer@globex.test` invite, `internal-plan.pdf`, `feedback.docx` fixtures                    | **Reserve those ids/names — seed must not create them**                                                                                          |
| `tests/unit/schema.spec.ts`   | `acme-industrials` + `globex-health` slugs, `.test` email-only rule                                                                                    | Keep both slugs; every email stays on `.test`                                                                                                    |
| `scripts/db-verify.mjs`       | not id-specific                                                                                                                                        | No change to its assertions                                                                                                                      |
| Phase 8 pgTAP (planned)       | reference ids for role×tenant matrix                                                                                                                   | Seed exposes the exact ids pgTAP will use                                                                                                        |

### 9.4 Reserved rows (do not seed)

- `b4-002` (attack-harness Globex CLIENT_REVIEW deliverable).
- Globex `newcomer@globex.test` invitation; files named `internal-plan.pdf`
  (Globex) and `feedback.docx` (Acme); `draft report` shape inserted by the
  harness is distinct from `a5-003`/`b5-002`/`d5-002` (different
  title/period), so no collision.

---

## 10. Scenario coverage matrix

| Required scenario          | Fixture(s)                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **multiple organizations** | 4: ACM (ACTIVE), GLX (ACTIVE), ICH (ONBOARDING), UMB (PAUSED)                                                                                  |
| **multiple users**         | 20 profiles: 10 internal, 10 client                                                                                                            |
| **multiple roles**         | `SUPER_ADMIN` ×1, `ADMIN` ×8 (+1 revoked +1 expiring), `CLIENT_ADMIN` ×3, `CLIENT_MEMBER` ×7; project roles LEAD/CONTRIBUTOR/REVIEWER/OBSERVER |
| **multiple services**      | 13 services under 8 engagements; all 7 service lines; all 7 teams                                                                              |
| **multiple engagements**   | 8 across RETAINER/PROJECT/ADVISORY and ACTIVE/COMPLETED/DRAFT/PAUSED                                                                           |
| **multiple projects**      | 13 projects (6 Acme, 4 Globex, 1 Initech, 2 Umbrella)                                                                                          |
| **project memberships**    | 35 rows incl. client `OBSERVER` rows, historical staff, single-lead per project                                                                |
| **tasks**                  | 32 rows, all 6 statuses, hours, positions, unassigned-team queue                                                                               |
| **deliverables**           | 19 rows (13 types/states incl. pending + approved + published), 13 append-only versions                                                        |
| **reports**                | 8 reports, 4 published with frozen `report_metrics`                                                                                            |
| **notifications**          | 24 rows, all 11 types, unread/read/archived mix                                                                                                |
| **activity**               | 72 curated audit events over 8 months + staff-only security events                                                                             |
| **files/metadata**         | 14 `files` rows + 14 `storage.objects` rows, 6 file kinds, 1 pending scan                                                                      |
| **active client**          | ACM + GLX (org ACTIVE, users ACTIVE, live engagement/projects/deliverables/reports)                                                            |
| **invited client**         | ICH (ONBOARDING org, PENDING invitations ×2, DRAFT engagement) + pierre (INVITED profile & membership inside ACTIVE ACM)                       |
| **suspended client**       | UMB (PAUSED org, umbra SUSPENDED account + membership, blocked work) + susie (org-scoped suspension in ACM)                                    |
| **multiple client users**  | ACM 5 (dana/eli/nova/pierre/susie), GLX 2 (fay/gwen), UMB 3 (umbra/umari/udith)                                                                |
| **multiple projects**      | 13 projects, 4 with `IN_PROGRESS`, 2 `BLOCKED`, 2 `IN_REVIEW`, 2 `COMPLETED`, 1 `PLANNED`                                                      |
| **overdue tasks**          | 10 listed in §6.1 across 3 orgs; plus overdue deliverable `a4-006`/`d4-001`                                                                    |
| **pending deliverables**   | `a4-001`, `a4-005`, `b4-004`, `b4-006` (CLIENT_REVIEW), `a4-006` (SUBMITTED), `a4-009` (REVISION_REQUESTED)                                    |
| **approved deliverables**  | `a4-003`, `a4-010`, `b4-005` (each with approver + timestamp + version history)                                                                |
| **published reports**      | `a5-001`, `a5-002`, `b5-001`, `d5-001`                                                                                                         |
| **notifications**          | §7.3 — unread badge data for 8 users, an archived row, a platform notice                                                                       |
| **activity history**       | §8 — per-org feeds with paging material, denial + failed-login rows for the admin feed                                                         |
| **files/metadata**         | §7.5 — visibility gates (internal contract vs public export), scan queue, org prefixed paths                                                   |

---

## 11. Reset / re-run behavior

### 11.1 Canonical lifecycle

```bash
npm run db:reset     # 1. local-only: drop + recreate the DB, apply auth/storage shim
npm run db:apply     # 2. transactional, checksum-ledgered migration set (forward-only)
npm run db:seed      # 3. supabase/seed.sql — ONE transaction, idempotent
npm run db:verify    # 4. structure + behaviour checks (Phase 7 adds seed-contract checks)
npm run db:types:check  # 5. generated-type drift check
```

`npm run db:check` runs the whole chain — it remains the canonical
"clean environment" command. Phase 7's additions are: seed contract checks in
`db:verify` (below) and a local-host guard in `db:seed.mjs` matching
`db-reset-local.mjs`.

### 11.2 Re-run semantics (idempotent, no-op)

- `supabase/seed.sql` is wrapped in `begin; … commit;` — all-or-nothing; a
  partially seeded database is never observable (a failure rolls back).
- **Every insert uses `on conflict (id) do nothing`** for pinned-id tables
  (profiles/auth.users, grants, memberships, organizations, settings,
  engagements, services, projects, project memberships, deliverables, versions,
  tasks, comments, files, reports, notifications, invitations) and a
  natural-key conflict target where ids are not pinned (metrics partial-unique
  expression; audit guards per §8.3).
- Therefore: **running `npm run db:seed` twice in a row produces identical
  row counts and no errors.** The seed never UPDATes, never DELETEs, never
  resurrects a row, and never touches reference data.
- Row-count summary after a run (extended in `scripts/db-seed.mjs`):

  | Table                                     | Expected count (fixed)                     |
  | ----------------------------------------- | ------------------------------------------ |
  | `auth.users` / `profiles`                 | 20                                         |
  | `platform_role_grants`                    | 10                                         |
  | `staff_team_memberships`                  | 10                                         |
  | `organizations` / `organization_settings` | 4 / 4                                      |
  | `organization_memberships`                | 10                                         |
  | `engagements`                             | 8                                          |
  | `services`                                | 13                                         |
  | `projects`                                | 13                                         |
  | `project_memberships`                     | 35                                         |
  | `tasks`                                   | 32                                         |
  | `deliverables`                            | 19                                         |
  | `deliverable_versions`                    | 13                                         |
  | `comments`                                | 12                                         |
  | `files` / `storage.objects`               | 14 / 14                                    |
  | `metrics`                                 | ~350 (exact count fixed at implementation) |
  | `reports` / `report_metrics`              | 8 / ~30                                    |
  | `notifications`                           | 24                                         |
  | `invitations`                             | 7                                          |
  | `audit_events`                            | 72 (curated)                               |

  The implementation pins each exact number; `db:verify` asserts them.

### 11.3 Fresh-timeline semantics (requires reset)

Because all dates are offsets from the run date, **a re-run never refreshes
the story** — the same row counts with the same relative ages. "Seeding again
to move the clock forward" is intentionally unsupported; the correct move is
`npm run db:reset` (then apply + seed). The seed never attempts partial
teardown because `audit_events` and `deliverable_versions`/`report_metrics`
are append-only: the only clean history is a fresh database.

### 11.4 Verify checks the design promises (implemented in Phase 7, listed now)

Extended `db-verify.mjs` (or a new `db-seed-verify.mjs` step) must assert:

1. **Counts** — exactly the table above.
2. **Scenario presence** — ≥1 overdue task per ACM/GLX/UMB; ≥1 pending
   (`CLIENT_REVIEW`) deliverable; ≥1 `APPROVED` with `approved_by`/`approved_at`;
   ≥1 published report; all 11 notification types present; ≥1 `PENDING` scan.
3. **Determinism** — run the seed twice against a scratch DB; row counts and
   (masked-to-offset) contents identical.
4. **Anchors** — legacy ids still exist and `b4-002` was not created by the
   seed; Acme/Globex slugs present.
5. **Partitions** — every curated `occurred_at` month has a partition with RLS
   enabled; no audit row landed in `audit_events_default`.
6. **Reserved names** — no `internal-plan.pdf`, no `feedback.docx`, no
   `newcomer@globex.test` `PENDING` invitation.
7. **Trigger state** — all 12 audit triggers are ENABLED after seeding.

---

## 12. Safety and security rules (seed-specific)

1. **Synthetic only (Rule 13).** Fictional companies (Acme, Globex, Initech,
   Umbrella), `.test` emails, `.example` websites. The schema unit test already
   asserts every email ends in `.test`; Phase 7 extends it to assert the two
   legacy org slugs remain.
2. **Local-only tooling.** `db-seed.mjs` gains the same non-local-host guard as
   `db-reset-local.mjs`; the seed file header declares it is never to be
   applied to a shared or production database.
3. **No secrets.** Token hashes only; checksums synthetic; no API keys, no
   connection strings, no JWT-shaped strings anywhere in the seed.
4. **Credentials.** `seed.sql` does not write password hashes (GoTrue-owned,
   and the local shim's `auth.users` has no `encrypted_password` column).
   The documented dev password (`GrowlithDevSeed-2026`) is applied by an
   optional local script `scripts/db-seed-auth.mjs` through the Supabase
   Admin API (`auth.admin.createUser`/`updateUserById`) — a Phase 7
   implementation item, local-host guarded, never run outside dev.
5. **RLS intact.** The seed runs as the migration owner (`service_role`
   equivalent, BYPASSRLS) so RLS does not block fixture insertion; this is
   exactly why the seed must never run on a database with live data — there is
   no RLS safety net on the seed's own writes.
6. **No audit by default-deny.** Disabling the 12 audit triggers is scoped to
   the seed transaction (§8.1) and re-enabled before commit; a verify check
   asserts the enabled state.

---

## 13. Narrative shape (why the data reads like a real account)

- **Acme** — 8-month growth retainer. The SEO template programme moved through
  a real revision loop (v1 rejected for mobile variants, v2 approved); the
  paid campaign is in client review while CAPI match-rate monitoring slips;
  the CWV sprint is blocked on client CMS access (the same client blocker
  appears in a task comment); the nurture automation went through one revision
  and v2 is approved; a QBR-level snapshot was published. One project is
  internal-only (pricing analysis) and one completed project leaves an
  archived audit report behind.
- **Globex** — 90-day rebuild. Design foundations are mid-build, the founder
  video's first cut is in client review (with a threaded client comment),
  thumbnails were approved, an RAG POC was submitted, and an SEO engineer is
  working _alongside_ the dev team on the same Web Core service (ADR-0006).
- **Initech** — 14 days into onboarding. Draft engagement, planned project,
  two pending invitations, one revoked and reissued. No metrics, no
  deliverables, no client users yet.
- **Umbrella** — a 400-day-old account that was paused 60 days ago when the
  client admin's account was suspended. Paid work is blocked with a
  client-suspension reason, an old SEO sprint is complete with a published
  audit, and the archived Q4 report remains in history.

---

## 14. What Phase 7 implementation will change (design only — nothing here yet)

| File                                 | Change                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `supabase/seed.sql`                  | Rewritten to this design (sections §4–§8), keeping the legacy anchors; file header documents determinism + local-only contract |
| `scripts/db-seed.mjs`                | Local-host guard; extended row-count summary with fixed expectations; optional `--expect` strict mode                          |
| `scripts/db-seed-auth.mjs`           | (new) local-only dev-password provisioning via Supabase Admin API                                                              |
| `scripts/db-verify.mjs`              | Seed-contract section: §11.4 items 1–7                                                                                         |
| `tests/unit/schema.spec.ts`          | Seed-data tests: `.test` rule kept; org slug rule kept; add "no reserved names/ids" assertions                                 |
| `docs/runbooks/local-development.md` | Seed section: commands, dev credentials, reset/re-run semantics                                                                |
| `README.md`, `supabase/README.md`    | Phase 7 status pointer                                                                                                         |

Phase 8 (L4/L5 testing) consumes these fixtures **as-is**; pgTAP suites will
name the exact ids defined here.

---

## 15. Observations surfaced by the design (recorded, deliberately NOT fixed here)

1. **Client activity feed + internal projects.** `client_activity_feed()`
   (migration 31) joins `projects` for the display title but does **not** gate
   on `projects.client_visible`. A `CREATE` event for `a3-005` (internal
   project) would surface its title to Acme clients. The seed keeps the
   internal project because the inverted default is worth testing, and records
   the observation for Phase 8: the feed RPC should add
   `and (a.entity_kind <> 'project' or pr.client_visible)`. A fix is a new
   migration, not an edit to 28.
2. **`audit_events` partition coverage.** Migration 21 creates only current +
   12 months of partitions; any back-dating strategy needs
   `growlith.ensure_audit_partition()` for past months. The seed design
   depends on that helper remaining idempotent and RLS-enforcing (it is).
3. **Seed size.** A single `supabase/seed.sql` (~1,200+ lines) is required by
   the Supabase CLI's canonical `supabase db reset` path; `\i` includes do not
   work through `scripts/db-seed.mjs`. Section headers will keep it navigable;
   a future migration to multiple seed files would require configuration
   changes in `supabase/config.toml`.
4. **Risk R-1 remains.** Every specialist holds cross-tenant `ADMIN` in the
   seed, exactly as the current seed does, with the reason string on each
   grant. Phase 7 does not resolve R-1; it keeps the violation visible.
5. **`deliverables_submitted_requires_timestamp` vs the state machine.** The
   CHECK requires `submitted_at` for every state past `IN_PROGRESS`, yet the
   workflow machine reaches `INTERNAL_REVIEW` before `SUBMITTED`. Phase 7
   satisfies the CHECK by stamping `submitted_at` on `INTERNAL_REVIEW` rows;
   Phase 8/9 may decide whether the CHECK should exempt `INTERNAL_REVIEW`
   (a new migration if so), which would be consistent with the machine.

---

## 16. Acceptance criteria for the Phase 7 implementation

- [ ] `npm run db:reset && npm run db:apply && npm run db:seed` succeeds on a
      clean local database; `npm run db:verify` passes including §11.4 checks.
- [ ] Running `npm run db:seed` twice is a byte-level no-op in row counts and
      produces no error.
- [ ] All §10 scenario rows are present and each passes its schema CHECK
      (statuses, visibility coherence, approver stamps, completed timestamps,
      blocked reasons, currency coherence, org-prefixed storage paths).
- [ ] Legacy anchors retained; `b4-002` and harness fixture names absent.
- [ ] `scripts/db-authz-attack.mjs` still exits 0 with the new seed.
- [ ] `npm test` (schema seed tests) and `npm run format:check` pass.
- [ ] No production data, real domains, secrets, or real checksums in the seed.

---

PHASE 7 SEED DESIGN COMPLETE

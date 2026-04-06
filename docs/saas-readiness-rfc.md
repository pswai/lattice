# Lattice SaaS Readiness — Technical RFC

**Date:** 2026-04-05
**Author:** orchestrator (dog-fooded through Lattice)
**Status:** Draft for review
**Scope:** What it takes to turn Lattice from a self-hosted coordination bus into a multi-tenant SaaS.

---

## 1. Executive verdict

**Lattice is not SaaS-ready today.** The agent-coordination logic is solid (35 MCP tools, 482 tests, 16 tables, observability + audit + RBAC scopes all landed in Phase 4). What is missing is every layer *outside* the coordination bus: human identity, self-serve onboarding, billing, compliance, and a datastore that survives multi-tenant cloud load.

### Four P0 blockers

| # | Blocker | Evidence | Impact |
|---|---------|----------|--------|
| 1 | **SQLite-only** | `agenthub/src/db/connection.ts:1`, `package.json` dep `better-sqlite3` | Single-writer, no pooling, no replicas. Performance cliff past ~10–50 concurrent teams. |
| 2 | **No human user / account model** | `agenthub/src/http/middleware/auth.ts:107–164` (team resolved from API key only) | No signup, login, OAuth, sessions, account owner, multi-human teams, audit-by-human. |
| 3 | **No self-serve team creation** | `agenthub/src/http/routes/admin.ts:33–58` (ADMIN_KEY gated) | Every signup = ops ticket. Cannot scale acquisition. |
| 4 | **No billing / quotas** | No `subscriptions`/`usage_counters` tables, no Stripe, no per-team quota enforcement | Cannot monetize or stop abuse. |

**Estimated engineering to GA SaaS:** 8–12 weeks with 2–3 engineers working in parallel on database, identity, and commerce.

---

## 2. Current-state audit

### 2.1 What exists (strengths)

- **Team isolation at DB layer.** Every table has `team_id` with FK; all model-layer queries scope by it. No cross-team leakage found.
- **API key auth.** SHA-256 hashed, three scopes (`read`/`write`/`admin`), key lifecycle fields (`expires_at`, `last_used_at`, `revoked_at`). `src/http/middleware/auth.ts:61`.
- **X-Team-Override header.** Lets an operator work across teams mid-session. `src/http/middleware/auth.ts:130–164`.
- **Observability.** Prometheus `/metrics`, `/healthz`, `/readyz`, `X-Request-ID`, structured JSON logs with secret redaction.
- **Audit log.** `audit_log` table captures actor, action, resource, metadata, IP, request_id with configurable retention.
- **Security middleware.** Rate limit (300 req/min/key default), body-size limit (1 MB), security response headers, webhook HMAC-SHA256, outbound secret scanner.
- **Team data export.** `export_team_data` returns a 13-section JSON snapshot with secrets redacted.

### 2.2 What is missing (gaps)

| Area | Gap | Severity |
|------|-----|----------|
| **Datastore** | SQLite only — no Postgres adapter, ORM, or migration tooling | P0 |
| **Identity** | No `users`, `sessions`, OAuth, email verify, password reset | P0 |
| **Onboarding** | No self-serve team creation, no landing page, no email flow | P0 |
| **Commerce** | No plans, quotas, Stripe integration, metering pipeline | P0 |
| **Org model** | Teams don't belong to users; no workspace/org hierarchy; no memberships | P1 |
| **Invitations** | No email-invite flow to add teammates | P1 |
| **Admin UI** | No UI for audit-log querying, quota viewing, user management | P1 |
| **Compliance** | No ToS/Privacy/DPA, no data-deletion endpoint, no SOC2 path | P1 |
| **Per-team rate limits** | Rate limit is per-key; a team with many keys can exceed plan | P1 |
| **SSRF guard** | Outbound webhook URL validated by protocol only, not IP range | P2 |
| **CORS** | No CORS middleware | P2 |
| **Dashboard auth** | `/` dashboard has no server-side auth (API key client-side only) | P2 |
| **SSO (SAML/OIDC)** | Not implemented — defer to enterprise tier | P2 (deferred) |

### 2.3 Competitive benchmark

| Feature | n8n Business | LangSmith | Dify | CrewAI | Lattice today | Lattice free tier target |
|--|--|--|--|--|--|--|
| Email + OAuth | ✔ | ✔ | ✔ | ✔ | ✘ | ✔ |
| SSO (SAML/OIDC) | ✔ (paid) | ✔ (ent) | ✔ (ent) | ✔ (ent) | ✘ | defer to ent |
| Workspace/org | ✔ | ✔ | ✔ | ✔ | partial (team ≈ workspace) | ✔ |
| RBAC | ✔ (roles) | ✔ | ✔ | ✔ | ✔ (key scopes only) | ✔ (user roles) |
| Audit log UI | ✔ | ✔ | ✔ | ✔ | ✘ (table only) | ✔ (API) |
| Billing dashboard | ✔ | ✔ | ✔ | ✔ | ✘ | ✔ |
| Execution-based pricing | ✔ | ✔ (trace) | ✔ (credit) | ✔ | ✘ | ✔ |
| SOC2 Type II | ✔ | ✔ | in progress | in progress | ✘ | defer 6–12 mo |

---

## 3. Target architecture

### 3.1 Schema sketches (new tables)

All new tables are additive. **Keep the existing `teams` table** — layer a user/workspace model on top. The `teams` table becomes "workspaces" conceptually; we alias it to avoid a rename migration in phase 1.

```sql
-- Phase 1: Identity
CREATE TABLE users (
  id              TEXT PRIMARY KEY,                 -- uuid
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT,                             -- null if OAuth-only
  email_verified_at TEXT,
  name            TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE UNIQUE INDEX idx_users_email_lower ON users(LOWER(email));

CREATE TABLE oauth_identities (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL,           -- 'github','google'
  provider_uid TEXT NOT NULL,
  email       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (provider, provider_uid)
);

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,             -- opaque token (sha256 stored)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT NOT NULL,
  ip          TEXT,
  user_agent  TEXT,
  revoked_at  TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE email_verifications (
  token       TEXT PRIMARY KEY,             -- sha256 hashed
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE TABLE password_resets (
  token       TEXT PRIMARY KEY,             -- sha256 hashed
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

-- Workspace = existing `teams` table (keep the name to avoid migration churn).
-- Add a nullable owner_user_id and slug:
ALTER TABLE teams ADD COLUMN owner_user_id TEXT REFERENCES users(id);
ALTER TABLE teams ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX idx_teams_slug ON teams(slug) WHERE slug IS NOT NULL;

CREATE TABLE team_memberships (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
  invited_by  TEXT REFERENCES users(id),
  joined_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, team_id)
);
CREATE INDEX idx_memberships_team ON team_memberships(team_id);

CREATE TABLE invitations (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK(role IN ('admin','member','viewer')),
  token       TEXT NOT NULL UNIQUE,       -- sha256
  invited_by  TEXT NOT NULL REFERENCES users(id),
  expires_at  TEXT NOT NULL,
  accepted_at TEXT
);
CREATE INDEX idx_invites_team ON invitations(team_id);
CREATE INDEX idx_invites_email ON invitations(LOWER(email));

-- Phase 2: Commerce
CREATE TABLE subscription_plans (
  id                 TEXT PRIMARY KEY,           -- 'free','pro','business'
  name               TEXT NOT NULL,
  price_cents        INTEGER NOT NULL,           -- monthly
  exec_quota         INTEGER NOT NULL,           -- playbook runs + task creates per month
  api_call_quota     INTEGER NOT NULL,           -- MCP + REST calls per month
  storage_bytes_quota INTEGER NOT NULL,          -- artifacts + context total
  seat_quota         INTEGER NOT NULL,
  retention_days     INTEGER NOT NULL            -- events/audit retention cap
);

CREATE TABLE team_subscriptions (
  team_id             TEXT PRIMARY KEY REFERENCES teams(id) ON DELETE CASCADE,
  plan_id             TEXT NOT NULL REFERENCES subscription_plans(id),
  stripe_customer_id  TEXT,
  stripe_subscription_id TEXT,
  current_period_start TEXT,
  current_period_end  TEXT,
  status              TEXT NOT NULL CHECK(status IN ('trialing','active','past_due','canceled'))
);

CREATE TABLE usage_counters (
  team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  period_ym       TEXT NOT NULL,                 -- '2026-04'
  exec_count      INTEGER NOT NULL DEFAULT 0,
  api_call_count  INTEGER NOT NULL DEFAULT 0,
  storage_bytes   INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (team_id, period_ym)
);
```

### 3.2 Auth flows

**Signup (email+password):**
```
POST /auth/signup {email, password}
  → create user (email_verified_at=null)
  → issue email_verification token, send email
  → response: 201 + session cookie (user can browse but blocked from paid actions until verified)
GET /auth/verify?token=...
  → mark email_verified_at, redirect /app
```

**OAuth (GitHub):**
```
GET /auth/github → redirect to GitHub OAuth
GET /auth/github/callback
  → exchange code, fetch profile
  → upsert oauth_identity + user (auto-verified)
  → issue session, redirect /app
```

**Login:**
```
POST /auth/login {email, password}
  → verify password_hash, create session, Set-Cookie
```

**Invitation accept:**
```
POST /invitations/{token}/accept (with user session)
  → create team_membership(user_id, team_id, role)
  → mark invitation.accepted_at
```

**API key issuance (post-signup):**
```
POST /teams/{id}/keys (session-authed, requires admin+ role)
  → create api_key with user-picked scope (read/write/admin)
  → return raw key ONCE
```

### 3.3 Postgres migration plan

**Recommendation: Drizzle ORM.** Reasons:
- TypeScript-first, schema-as-code (no codegen step) — fits the current hand-rolled SQL style.
- Supports both SQLite and Postgres with the same schema definitions — lets us keep self-hosted SQLite as a supported backend post-migration.
- Lightweight (~2 MB), no runtime engine (unlike Prisma's rust binary + 20+ MB bundle).
- Migration tooling via `drizzle-kit`.
- Bundler-friendly for the Docker/MCP story.

**Incremental strategy (3 weeks eng time):**

1. **Week 1 — Adapter seam.** Introduce a `DbDialect` abstraction in `src/db/`. All model files currently call `db.prepare(...)` directly on `better-sqlite3` — wrap behind a thin query interface that both SQLite and Postgres implementations can satisfy. Add Drizzle schema mirroring the 16 existing tables. Tests continue running against SQLite.
2. **Week 2 — Postgres parity.** Port SQL quirks: `strftime('%Y-%m-%dT%H:%M:%fZ','now')` → `to_char(now() at time zone 'UTC', ...)`; FTS5 (`tokenize='trigram'`) → Postgres `pg_trgm` + `GIN` index + ILIKE fallback; `INTEGER PRIMARY KEY AUTOINCREMENT` → `BIGSERIAL`; JSON columns → `jsonb`. Re-run full test suite against a Postgres instance in CI.
3. **Week 3 — Operational switchover.** Add DB connection-pool config (pg-pool). Add `DATABASE_URL` env var (postgres://... or sqlite://...). Document self-hosted SQLite mode vs. cloud Postgres mode. Run a migration script that ports the existing SQLite snapshot to Postgres for any self-hosters upgrading.

**The biggest sharp edge:** SQLite FTS5 trigram tokenizer has no 1:1 Postgres equivalent. `pg_trgm` + `gin_trgm_ops` on the searchable columns + ILIKE gives ~95% parity; we accept slightly different relevance ordering.

### 3.4 API surface deltas

New routes required for Phase 1 + 2:

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/signup` | Email+password signup, sends verify email |
| POST | `/auth/login` | Issue session |
| POST | `/auth/logout` | Revoke session |
| POST | `/auth/verify-email` | Consume email-verify token |
| POST | `/auth/forgot-password` | Start password reset |
| POST | `/auth/reset-password` | Consume reset token |
| GET | `/auth/github` + `/auth/github/callback` | OAuth |
| GET | `/auth/me` | Current user profile |
| POST | `/workspaces` | Self-serve team creation (authed) |
| GET | `/workspaces` | List user's workspaces |
| DELETE | `/workspaces/:id` | Delete (owner only, cascades) |
| POST | `/workspaces/:id/invitations` | Send invite email |
| POST | `/invitations/:token/accept` | Accept invite |
| GET | `/workspaces/:id/members` | List members |
| DELETE | `/workspaces/:id/members/:userId` | Remove member |
| GET | `/workspaces/:id/usage` | Current period usage + limits |
| GET | `/workspaces/:id/audit` | Query audit log (filters, pagination) |
| POST | `/billing/checkout` | Stripe checkout session |
| POST | `/billing/portal` | Stripe customer portal |
| POST | `/webhooks/stripe` | Handle subscription.updated etc. |

Existing API-key-scoped routes remain unchanged. New routes accept either session cookie OR API key (admin scope) for CI/automation.

### 3.5 Quota enforcement

Middleware chain insert *after* team resolution:

```
quotaMiddleware:
  read team_subscriptions for teamId
  read usage_counters for teamId, current period
  if over hard limit → 429 QUOTA_EXCEEDED + Retry-After next period
  if over 80% soft limit → add X-Quota-Warning header
  on success → increment counter asynchronously (batched, flushed every 5s)
```

Counter updates batch via an in-memory ring buffer + `setInterval` flusher to avoid write amplification on every request.

---

## 4. Build vs. buy decisions

| Capability | Recommendation | Why |
|---|---|---|
| **Auth provider** | DIY initially (sessions table + bcrypt + GitHub OAuth) — ~1 week | Full control, no per-MAU cost, no vendor lock-in. Revisit Clerk/WorkOS at 5k+ MAU or when SSO/SAML becomes a deal. |
| **Billing** | Stripe | De-facto standard. Use Checkout + Customer Portal (zero UI work). |
| **Email** | Resend or Postmark | Transactional, cheap, good deliverability. Resend's API is simpler. |
| **Analytics** | PostHog self-hosted | Open-source, privacy-friendly, funnel analysis. Zero vendor lock-in. |
| **Error tracking** | Sentry | Free tier sufficient for launch. |
| **Postgres host** | Neon or Supabase | Serverless Postgres, branching, good free tier. Neon has better cold-start; Supabase adds auth-as-a-service we won't use. |

**Rejected: Clerk.** Tempting but $25/mo per 1000 MAU adds up quickly and ties the business model to their pricing changes. Budget ~1.5 weeks to build equivalent with GitHub OAuth + sessions + bcrypt and own it.

---

## 5. Pricing model recommendation

**Follow n8n (execution-based), not LangSmith (seat-based).** Agents run many, many executions per human; seat pricing caps revenue per customer and misaligns with value delivered. Executions align directly with Lattice's value proposition (coordinate agents).

Proposed tiers:

| Tier | Price | Execs/mo | Seats | Storage | Retention | Notes |
|---|---|---|---|---|---|---|
| Free | $0 | 1,000 | 3 | 100 MB | 7 d | 1 workspace, community support |
| Pro | $49/mo | 15,000 | 10 | 2 GB | 30 d | Email support, webhooks, custom domains |
| Business | $249/mo | 100,000 | unlimited | 20 GB | 90 d | Audit UI, priority support, 99.9% SLA |
| Enterprise | Custom | Custom | unlimited | Custom | 365 d | SSO, SOC2 evidence, DPA, private deployment |

"Execution" = 1 task_create + 1 playbook_run + 1 schedule_fire (the billable unit must be clearly defined in docs and metered in `usage_counters.exec_count`).

---

## 6. Phased execution plan

### Phase 1 — Foundation (Month 1–2, ~7 weeks)
**Goal:** Public free tier live, anyone can self-sign-up.

| Week | Owner | Work |
|---|---|---|
| 1 | backend | Drizzle adapter seam + schema mirror (`src/db/drizzle-schema.ts`) |
| 2 | backend | Postgres parity (FTS, timestamps, jsonb); CI matrix SQLite+PG |
| 3 | backend | Ship Postgres support; `DATABASE_URL` config; docs |
| 3 | auth | `users`/`sessions`/`oauth_identities` tables + `/auth/*` routes |
| 4 | auth | Email verify + GitHub OAuth + session middleware |
| 4 | frontend | Signup/login/verify pages (dashboard.ts extension) |
| 5 | backend | `team_memberships`/`invitations` + `/workspaces/*` + invitation email |
| 5 | frontend | Workspace picker + member list + invite flow UI |
| 6 | ops | Audit log query API (`GET /workspaces/:id/audit`) + retention policy enforcer |
| 6 | ops | Quota middleware + `usage_counters` write path (counters only, no enforcement yet) |
| 7 | QA | End-to-end signup-to-coordinate flow, security review, launch |

### Phase 2 — Commerce (Month 3–4, ~6 weeks)
**Goal:** Paid Pro tier live, Stripe flow wired.

| Week | Work |
|---|---|
| 1 | `subscription_plans`/`team_subscriptions` schema + seed plans |
| 2 | Stripe checkout + webhooks + customer portal |
| 2 | Hard quota enforcement (429 at limit, 80% soft warning header) |
| 3 | Billing dashboard tab (usage, plan, invoices) |
| 4 | Per-team rate limit (aggregate across all keys) |
| 5 | Launch Pro tier, grandfather free-tier users |
| 6 | Monitoring + first-customer support loop |

### Phase 3 — Enterprise readiness (Month 5–6, ~6 weeks)
**Goal:** First enterprise contracts signable.

| Week | Work |
|---|---|
| 1–2 | ToS + Privacy Policy + DPA (legal engagement) |
| 1 | Data-deletion endpoint + cascade (GDPR right-to-erasure) |
| 2 | Audit log admin UI (query builder, CSV export) |
| 3 | SSO scaffolding (OIDC) + SAML via dex or DIY |
| 4 | SOC2 Type II audit kickoff (12-month timeline) |
| 5 | SSRF guard on webhooks, CORS middleware, dashboard server-side auth |
| 6 | Enterprise sales collateral + pilot customer |

---

## 7. Open questions for user decision

1. **Hosted or managed open-source?** Do we keep Lattice fully OSS (Apache 2.0) with a hosted commercial offering, or move to BSL/SSPL to prevent hyperscaler copycat? Recommendation: stay Apache 2.0, win on operational quality.
2. **Workspace naming.** Keep `teams` as the DB name or rename to `workspaces`? Rename is cheap now, expensive later. Recommendation: rename to `workspaces` in Week 2 of Phase 1 before data volume matters.
3. **Who owns SOC2?** Not a fit for a 2–3 person team unless we dedicate a founder to it. Recommendation: Vanta + part-time compliance consultant, ~$40k all-in.
4. **Self-hosted story.** Do we continue supporting SQLite for self-hosters, or Postgres-only post-migration? Recommendation: keep SQLite for local dev + small self-hosted; Postgres required for cloud + multi-tenant self-hosted.
5. **Email provider.** Resend vs. Postmark. Recommendation: Resend — cheaper at scale, better API.
6. **Free tier fraud.** How do we prevent abuse of the free tier (crypto miners via playbook execution, etc.)? Recommendation: email verification required, credit card on file at sign-up (no charge), usage anomaly detection job.

---

## 8. Bottom line

Lattice's coordination engine is production-grade. The path to SaaS is scaffolding work — identity, commerce, compliance — well-understood patterns with no research risk. **Highest single risk: Postgres migration (FTS parity).** Everything else is straightforward.

If approved, start with **Phase 1 Week 1**: the Drizzle adapter seam. Pull a 2-table proof-of-concept (e.g. `teams`, `api_keys`) through the new adapter against Postgres in CI. Ship that first, then fan out.

---

*Generated via Lattice dog-food workflow: 3 parallel Explore subagents + 1 DX-fixer teammate, coordinated via Lattice's own task/context/message bus.*

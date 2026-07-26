# CompanyOS — Security Audit (Internal)

**Date:** 2026-07-24
**Scope:** Cloudflare Workers backend (`src/`), configuration, webhook ingress, authentication/authorization, multi-tenant data isolation, at-rest crypto.
**Out of scope this pass:** React console (`ui/`) deep-dive, dependency CVE scan (`npm audit` — see checklist), live infrastructure/WAF configuration.
**Context:** Requested ahead of sharing CompanyOS with prospective clients.

---

## Executive summary

The backend is, on the whole, **well-engineered from a security standpoint**. Multi-tenant isolation, password/token/session handling, and refresh-token encryption are all implemented correctly and follow good discipline (secrets hashed at rest, constant-time comparisons, single-use tokens, fail-closed admin gates). The findings below are **specific and fixable**, not symptoms of a systemic weakness.

Two code fixes were applied as part of this audit (HIGH XSS + security headers). One HIGH item is an intentional design choice that needs a **product decision** before a client demo. The remainder are MEDIUM/LOW hardening and operational-verification items.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | 🔴 HIGH | Reflected XSS in Google OAuth callback | **Fixed** |
| 2 | 🔴 HIGH | Tenant API key bypasses all role checks (design) | **Decision needed** |
| 3 | 🟠 MEDIUM | No HTTP security headers | **Fixed** |
| 4 | 🟠 MEDIUM | Real encryption key committed to git | **Action needed (rotate)** |
| 5 | 🟡 LOW | JIRA webhook secret in URL, no body integrity | Documented |
| 6 | 🟡 LOW | Rate limiting is best-effort KV only | Verify WAF |
| 7 | 🟡 LOW | Committed infra resource IDs | Documented |
| 8 | 🟡 LOW | Seed script SQL escaping + default password | Documented |
| 9 | ℹ️ INFO | Untrusted content → LLM (prompt injection) | Documented |
| 10 | 🟡 LOW | Dependency CVEs in dev/build tooling only | Update dev deps |

---

## Findings

### 1. 🔴 HIGH — Reflected XSS in Google OAuth callback — FIXED

**Location:** `src/gateway/routes/google-oauth.ts` (`page()` helper; `?error=` branch and exchange-exception path).

The status page interpolated values directly into an HTML string with no escaping. The `?error=` query parameter was reflected **before** the OAuth `state` nonce was validated:

```js
const oauthError = url.searchParams.get("error");
if (oauthError) return page("Connection cancelled", `Google reported: ${oauthError}.`, false);
```

Because this returns before `consumeOAuthState`, it was reachable **completely unauthenticated**. A crafted link such as
`/oauth/google/callback?error=<script>…</script>` would execute attacker-controlled JavaScript in the response origin (`api.companyos.com.my`). The `catch` path (raw `err.message`) had the same flaw.

**Impact:** Reflected XSS on a production origin — session/credential theft, phishing, CSRF-token exfiltration for any victim who follows a crafted link.

**Fix applied:** Added an `escapeHtml()` helper and escaped every interpolated value in `page()`. Added a strict `Content-Security-Policy` (`default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'`), `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer` on the callback responses as defence-in-depth. Regression test added at `test/google-oauth-callback.test.ts`.

---

### 2. 🔴 HIGH — Any tenant API key bypasses all role checks — DECISION NEEDED

**Location:** `src/gateway/middleware/session.ts:80-87` (`requireRole`).

```js
if (!user || user.type !== "user") return next(); // system/agent bypass
```

Every programmatic (`system`/API-key) caller skips role enforcement entirely. Combined with per-route business gating not yet being layered in (only `/v1/users` gates on `admin`), **a single tenant API key is effectively root within its tenant** — full read/write across finance (ledger, invoices, payments), CRM, HR/people, and quotes.

This is documented as intentional ("trusted root credentials"). It is safe *within* the tenant-isolation boundary (a key cannot cross tenants — see the positives section), but for a client demo where agent keys are handed out, the blast radius of a single leaked key is the entire tenant dataset.

**Recommendation:** Introduce **scoped API keys / least-privilege** (e.g. a `scopes` column on `tenants` or a separate `api_keys` table, checked in `requireRole` / per-route). This is an architectural change and was **not** made unilaterally — decide whether to implement before the demo or knowingly accept root-per-key for now.

---

### 3. 🟠 MEDIUM — No HTTP security headers — FIXED

**Location:** `src/index.ts` (no headers were set anywhere).

Missing `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Strict-Transport-Security`.

**Fix applied:** Added a global Hono middleware setting `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` on all responses, and `Strict-Transport-Security` when the request is https (so `wrangler dev` on http is unaffected). CSP is applied per-surface (the OAuth callback ships its own strict policy); the JSON API does not render HTML so a global CSP is unnecessary.

---

### 4. 🟠 MEDIUM — Real encryption key committed to git — ACTION NEEDED

**Location:** `wrangler.jsonc:25-46`, notably line 35 `GOOGLE_TOKEN_ENCRYPTION_KEY`.

The `vars` block holds dev placeholders (`SESSION_SECRET`, `PLATFORM_ADMIN_SECRET`, `WEBHOOK_MASTER_SECRET`, `GOOGLE_CLIENT_SECRET`) **and a real, functional base64 32-byte AES-256 key**. Even though the file is labelled dev-only and production is meant to override via `wrangler secret put`, that key now lives permanently in git history and would decrypt any Google refresh token sealed with it.

**Recommendation:**
- **Rotate `GOOGLE_TOKEN_ENCRYPTION_KEY`** (generate a fresh key via `head -c 32 /dev/urandom | base64`, set with `wrangler secret put`, re-encrypt existing sealed tokens using the `enc_key_version` rotation hook).
- Confirm production is deployed with real secrets set via `wrangler secret put` and that `wrangler.jsonc`'s `vars` never reach a production deploy (the file's own comment warns it must be stripped before any paid-plan `wrangler deploy`). Verify the deploy pipeline targets the intended config.
- Replace the committed key value with an obvious non-key placeholder to avoid it being mistaken for usable material.

---

### 5. 🟡 LOW — JIRA webhook: secret in URL, no body integrity

**Location:** `src/webhooks/verify.ts:52-54`.

JIRA Cloud has no native HMAC, so the derived secret rides in the webhook URL (`?secret=`) and is compared directly — no signature over the body. GitHub and Bitbucket use proper HMAC-SHA256 body signatures. This is a documented limitation. The secret is unguessable and compared constant-time, but the URL may be logged by intermediaries and the body is not integrity-protected.

**Recommendation:** Note as accepted risk; optionally restrict the JIRA source to Atlassian egress IP ranges at the WAF, and ensure access logs don't retain query strings.

---

### 6. 🟡 LOW — Rate limiting is best-effort KV only

**Location:** `src/gateway/middleware/rate-limit.ts`.

Fixed-window counters on eventually-consistent KV — an abuse dampener, not a hard guarantee, and the code comment explicitly assumes a Cloudflare WAF rate rule backs it in production.

**Recommendation:** Confirm the WAF rate rule on `/v1/auth/*` is actually configured in the production zone before the demo.

---

### 7. 🟡 LOW — Committed infrastructure resource IDs

**Location:** `wrangler.free.jsonc:58,67,72`.

Real-looking D1 `database_id` and KV namespace IDs are committed (unlike the placeholder zeros in `wrangler.jsonc`). These are not secrets, but they disclose production resource identifiers. Low impact given they're useless without Cloudflare account credentials.

---

### 8. 🟡 LOW — Seed script: hand-rolled SQL escaping + default password

**Location:** `scripts/seed-local.mjs` (SQL built with a single-quote-only `esc()`, run via `execFileSync` wrangler; default admin password `companyos-admin`).

Dev-only local seeding, not shipped in the Worker. **Recommendation:** confirm it can never be pointed at a production D1 (it uses `--local`), and treat the default password as local-only.

---

### 9. ℹ️ INFO — Untrusted content flows into the LLM (prompt injection)

**Location:** `src/agents/collections.ts`, `src/agents/decision.ts`, inbound Gmail sync (`src/integrations/google/sync.ts`).

Customer/invoice data and inbound email content reach the model. As agent autonomy grows, treat this as a prompt-injection surface (e.g. a malicious email steering the collections agent). No action required now; document and revisit as agent capabilities expand.

---

### 10. 🟡 LOW — Dependency CVEs confined to dev/build tooling

`npm audit` on the root tree reports 6 vulnerabilities (5 high, 1 critical), **all in dev/build dependencies** — `vitest`, `wrangler`, `miniflare`, `sharp`/`libvips`, and `ws`. None are in the runtime dependencies bundled into the Worker (`hono`, `zod`, `ulid`, `@anthropic-ai/sdk`), so production exposure is low:

- **vitest < 3.2.6 (critical, GHSA-5xrq-8626-4rwp):** only exploitable when the Vitest UI server is running — a local-dev-only condition, never in production.
- **ws / sharp / miniflare (high):** transitive under `wrangler`/`vitest-pool-workers`; they run at build/test time, not in the deployed Worker.

**Recommendation:** Update dev tooling (`npm audit fix --force` pulls `vitest@3.2.7` and `@cloudflare/vitest-pool-workers@0.18.8` — a breaking bump, so run the suite after). Not a production-runtime risk, but worth clearing before the repo is shared. Also run `npm audit` in `ui/` (not covered in this pass).

---

## Verified strengths (no action needed)

- **Tenant isolation is clean.** Every by-id read/mutate across `src/modules/*/service.ts` and the Google/webhook DAOs is scoped `tenant_id = ?`. The only literally-unscoped queries are intentional system paths — the inbox-sync cron sweep (`listSyncableAccounts`), webhook resolution by unguessable URL token (`getActiveSource`), and the global-users PK check (`assertUserLink`, tenant verified in the service layer). No IDOR/cross-tenant access found.
- **Password hashing** — PBKDF2-HMAC-SHA256, 100k iterations, per-user iteration count, constant-time hex compare (`src/auth/password.ts`).
- **Sessions & tokens** — opaque 32-byte random tokens, HMAC-signed cookie, only SHA-256 stored at rest, `HttpOnly` + `SameSite=Lax` + `Secure` (over https), 7-day TTL, single-use invite/reset tokens (atomic consume), revoke-all-sessions on password reset (`src/auth/session.ts`, `src/auth/tokens.ts`).
- **Refresh-token encryption** — AES-256-GCM, fresh 96-bit IV per encryption, `enc_key_version` column for rotation (`src/integrations/google/crypto.ts`).
- **Auth routes** — anti-enumeration (unknown workspace/account reported identically to bad credentials; `/password/forgot` always 200), rate limiting on login/forgot/reset/invite, CSRF synchronizer token on cookie mutations, fail-closed platform-admin gate (503 when unset).
- **Webhook trust** — per-source secrets derived (not stored), HMAC body signatures for GitHub/Bitbucket, uniform 404 for unknown/disabled sources, idempotent ingestion.
- **CORS** — allowlist-driven origin echo with `credentials: true`, no illegal wildcard-with-credentials (`src/index.ts`).
- **SQL** — no string-interpolated user values; all values bound via `.bind(?)`. `${...}` in query strings is limited to column-name constants and built clause skeletons.

---

## Pre-demo checklist

1. ✅ **Fix OAuth-callback XSS** (escape + CSP) — done.
2. ✅ **Add security headers** — done.
3. ⬜ **Rotate `GOOGLE_TOKEN_ENCRYPTION_KEY`** and confirm all production secrets are set via `wrangler secret put`, not the committed config.
4. ⬜ **Decide on API-key authorization model** (scoped keys vs. knowingly accept root-per-key).
5. ⬜ **Confirm the WAF rate-limit rule** on `/v1/auth/*` is live in production.
6. ⬜ **Run `npm audit`** on both dependency trees and remediate high/critical.
7. ⬜ Replace the committed dev key value with a non-key placeholder.

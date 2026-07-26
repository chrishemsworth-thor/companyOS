# Design: API Key Management (scoped, rotatable, admin-managed)

**Status:** Proposed
**Author:** (drafted with Claude during the 2026-07 security audit)
**Related:** `docs/security-audit-2026-07.md` finding #2 (HIGH — tenant API key bypasses all role checks)
**Target:** implemented on a dedicated branch/session, not the audit branch.

---

## 1. Context & problem

Today a tenant has exactly **one** API key, minted once at tenant creation:

- `tenants.api_key_hash` — a single `UNIQUE` column (`migrations/0001_init.sql:10`).
- Minted in `createTenant()` as `cos_<ulid><ulid>`, hash stored, plaintext shown once (`src/auth/tenants.ts:57`).
- Presented as `Authorization: Bearer <key>`, resolved to a tenant in `resolveTenantByApiKey()` (`src/gateway/middleware/auth.ts:36`), cached in KV for 60s.
- The resolved actor is `{ type: "system" }` (`src/gateway/middleware/session.ts:67`) — **anonymous**.
- `requireRole()` **bypasses all checks** for any non-`user` actor (`session.ts:83`).

Net effect: **one long-lived, tenant-wide, all-powerful bearer token** with no rotation, no revocation, no expiry, no attribution, and no scoping. For a product whose keys are handed to **AI agents** (a high leak-surface: keys land in agent configs, prompts, logs, third-party orchestrators) and whose data includes payroll, PII, and a live financial ledger, this is the top authorization risk before external sharing.

### What is *not* the problem
- **Cross-tenant isolation is solid** — every service query is `tenant_id`-scoped; a key cannot reach another tenant's data. This design does not change that.
- **The human/session path is fine** — console users authenticate with cookies and are role-gated. This design leaves session auth untouched.
- **The `api.` / `console.` domain split does not mitigate this.** CORS/cookie isolation are browser protections; API keys are used server-to-server and ignore CORS. The split is correct and stays, but it is orthogonal to key authorization.

---

## 2. Goals & non-goals

### Goals
1. **Multiple keys per tenant**, each independently rotatable and revocable.
2. **Rotation & revocation** with no downtime and no tenant re-creation.
3. **Per-key attribution** — every API-key action is traceable to a specific key.
4. **Least-privilege scopes** — a key can be limited to read-only and/or to specific modules.
5. **Admin self-service in the operator UI** — a tenant admin can list, create, rotate, and revoke their own keys, and see last-used activity.
6. **Backward compatibility** — existing tenants keep working through the migration with no manual intervention.

### Non-goals (explicitly deferred)
- OAuth2 client-credentials / token-exchange flows (Tier 2).
- Per-key IP allow-listing (Tier 2; note it as a future field).
- Fine-grained row/record-level permissions.
- Cross-tenant / platform-level keys.

---

## 3. Threat model addressed

| Threat | Today | After |
|---|---|---|
| Agent key leaks (config/log/prompt) | Whole tenant exposed, **no way to rotate** | Revoke the one leaked key; others unaffected |
| Over-broad integration | Every key is root | Issue a `read`-only or single-module key |
| "Who did this?" during incident | All keys are anonymous `system` | Action attributed to a named key |
| Compromised key mints more keys | Possible (key can call anything) | **Key management requires a human admin session; blocked for `system` actors** |

The last row is a deliberate security property: see §7.

---

## 4. Data model

New table (new migration, e.g. `migrations/0020_api_keys.sql`):

```sql
CREATE TABLE api_keys (
  key_id        TEXT PRIMARY KEY,               -- e.g. key_<ulid>
  tenant_id     TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,           -- sha256(plaintext); plaintext shown once
  label         TEXT NOT NULL,                  -- human name, e.g. "collections agent (prod)"
  scopes        TEXT NOT NULL,                  -- JSON array, e.g. ["finance:read","crm:write"]
  prefix        TEXT NOT NULL,                  -- first ~10 chars of the key, for UI display (cos_01ABCD…)
  created_by    TEXT,                           -- user_id of the admin who created it (null for backfilled)
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_used_at  TEXT,                           -- updated best-effort on use
  expires_at    TEXT,                           -- optional; null = non-expiring
  revoked_at    TEXT,                           -- null = active
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id)
);
CREATE INDEX idx_api_keys_tenant ON api_keys(tenant_id);
-- key_hash already UNIQUE for O(1) auth lookup.
```

Notes:
- `tenants.api_key_hash` is **retained** through the transition (see §8) and dropped only in a later migration once all traffic resolves via `api_keys`.
- `prefix` lets the UI show `cos_01ABCD…` so admins can recognize a key without ever seeing the secret again.
- `last_used_at` is best-effort (a KV-buffered or throttled write — do **not** write to D1 on every request; see §6).

---

## 5. Scope taxonomy

Format: `"<module>:<action>"`, action ∈ `read` | `write` (`write` implies `read`). Modules mirror the route groups in `src/index.ts`:

`finance`, `crm`, `support`, `build`, `people`, `quotes`, `insights`, `events`, `settings`, `webhook-sources`, `google-accounts`.

Conveniences:
- `"*:read"` — read-only across all modules.
- `"*:write"` — full access (the legacy/default behavior; what backfilled keys get).
- `users` module (tenant user management) is **admin-session only** and is **never** grantable to an API key.

Start shipping with **`*:read` and `*:write`** as the two presets (covers the common "give me a read-only key" ask). Per-module selection can land in the same release or immediately after — the storage and enforcement already support it; it's a UI affordance.

---

## 6. Auth resolution changes

`resolveTenantByApiKey()` (`src/gateway/middleware/auth.ts`) becomes `resolveApiKey()` returning:

```ts
interface ResolvedKey {
  tenant: Tenant;
  key_id: string;
  scopes: string[];
}
```

Logic:
1. `hash = sha256(key)`; look up `api_keys WHERE key_hash = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now)`.
2. Miss → fall back to `tenants.api_key_hash` during the transition window (§8), treating a legacy hit as scopes `["*:write"]`.
3. Cache the resolved `{tenant, key_id, scopes}` in KV keyed by `hash` (extend the existing 60s cache). Revocation takes effect within TTL + propagation — acceptable, and documented; for immediate kill, also delete the cache key on revoke.
4. `last_used_at`: update at most once per key per N minutes (e.g. gate on a KV marker) to avoid a D1 write per request.

Actor becomes attributed:

```ts
// src/auth/actor-context.ts
type Actor =
  | { type: "user"; id: string; role: string }
  | { type: "system"; key_id?: string; scopes?: string[] };  // key_id set for API-key callers
```

`authenticate()` (`src/gateway/middleware/session.ts`) sets `{ type: "system", key_id, scopes }`.

### Enforcement
Add `requireScope(scope: string)` middleware alongside the existing `requireRole()`:
- **`user` actor** → existing role logic (unchanged; humans are governed by role, not scope).
- **`system` actor** → allow iff `scopes` satisfies the required scope (`"finance:write"` satisfied by `"finance:write"` or `"*:write"`; any `:read` requirement satisfied by the matching `:write`).
- Missing/insufficient → `403`.

Annotate each route group with its scope, e.g. in `src/index.ts` or per-router. Recommended: a small `requireScope` per module mount so it's declarative and hard to forget. This **replaces the blanket `system` bypass** — the bypass in `requireRole()` stays only for the human-vs-system split, while scope becomes the gate for keys.

> Migration nuance: a backfilled key has `["*:write"]`, so every existing route call still passes. New restricted keys are opt-in. This means enabling enforcement is safe to ship before any UI exists.

---

## 7. Operator UI (console.companyos.com.my)

New **admin-only** screen: **Settings → API Keys** (`ui/src/pages/…`, following existing page/`api/` conventions).

Capabilities:
- **List** keys: label, `prefix` (`cos_01ABCD…`), scopes, created-by, created-at, last-used-at, status (active/revoked/expired).
- **Create**: choose label + scope preset (Read-only / Full, later per-module) + optional expiry → response shows the plaintext key **once** with a copy button and a "you won't see this again" warning.
- **Rotate**: convenience action = create a new key with the same label+scopes, then revoke the old one. Optionally support a **grace window** (old key stays valid N hours) so a running agent can be updated without an outage — surface this as a choice.
- **Revoke**: immediate; also purges the KV cache entry.

Security properties of the management surface:
- All key-management endpoints require a **human admin session** — `requireRole("admin")` **and** actor `type === "user"`. They are **explicitly blocked for `system`/API-key callers**, so a leaked key cannot mint or escalate keys. State this in code comments and cover it with a test.
- Plaintext keys are returned only in the create/rotate response body, never stored, never logged, never re-fetchable.
- Show a non-dismissable notice if the tenant is still on the legacy single-key (prompt them to create named keys and retire the legacy one).

Wireframe (textual):

```
API Keys                                             [ + New key ]
────────────────────────────────────────────────────────────────
Label                Key         Scopes        Last used     ⋯
Collections (prod)   cos_01AB…   finance:write 2h ago        [Rotate][Revoke]
Reporting (read)     cos_01CD…   *:read        5m ago        [Rotate][Revoke]
legacy/default       cos_01EF…   *:write       —             [Rotate][Revoke]
```

---

## 8. Migration & backward compatibility

1. **Migration `0020_api_keys.sql`** creates the table and **backfills one row per existing tenant** from `tenants.api_key_hash` with `label = 'legacy/default'`, `scopes = ["*:write"]`, `prefix = NULL/unknown` (backfilled rows may not have a prefix since we only have the hash — display "legacy" in the UI).
2. **Dual-read window**: `resolveApiKey()` checks `api_keys` first, then falls back to `tenants.api_key_hash`. Existing keys keep working unchanged.
3. **Ship enforcement**: `requireScope` annotations go live; backfilled `*:write` keys pass everything, so no behavior change.
4. **Ship UI**: admins create named keys, rotate off the legacy key.
5. **Later migration** (separate PR, after tenants have migrated): drop the `tenants.api_key_hash` fallback and the column.

No tenant action is required for steps 1–3; the legacy key remains valid until an admin rotates it.

---

## 9. API surface (session-authenticated, admin-only)

Mounted under the existing `/v1` guard, admin-gated:

- `GET    /v1/api-keys` — list (never returns hashes or plaintext).
- `POST   /v1/api-keys` — `{ label, scopes[], expires_at? }` → `{ key_id, plaintext, prefix, … }` (plaintext once).
- `POST   /v1/api-keys/:id/rotate` — `{ grace_hours? }` → new key's plaintext; schedules/executes old-key revocation.
- `DELETE /v1/api-keys/:id` — revoke immediately.

All four: require `type === "user"` && `role === "admin"`; reject `system` actors with `403`.

---

## 10. Testing

- **Auth resolution:** active key resolves with scopes; revoked/expired key → 401; legacy fallback works; KV cache invalidated on revoke.
- **Scope enforcement:** `*:read` key can `GET /v1/invoices` but is `403` on `POST`; `finance:write` key is `403` on `/v1/people`; `*:write` (legacy) passes everything.
- **Management guardrail:** an API-key (`system`) caller gets `403` on all `/v1/api-keys` endpoints (no key can mint/rotate/revoke keys); admin session succeeds; non-admin session `403`.
- **Rotation:** old key invalid after rotate (or after grace window if used); new key valid; attribution `key_id` changes.
- **Backfill migration:** a pre-existing tenant's original key still authenticates post-migration with `*:write`.
- Follow the `cloudflare:test` worker-pool patterns already in `test/` (see `test/gateway.test.ts`, `test/auth-session.test.ts`).

---

## 11. Rollout plan (suggested order for the implementation session)

- **Phase A (Tier 0 — do first):** table + migration/backfill, `resolveApiKey` with dual-read, per-key attribution (`key_id` on the actor), best-effort `last_used_at`, and management endpoints (`GET/POST/rotate/DELETE`) with the admin-only guardrail. Ships rotation + revocation + attribution — the incident-response lever — with **no authz behavior change**.
- **Phase B (Tier 1 — the actual fix):** `requireScope` middleware + per-route annotations + `read`/`write` presets. This closes audit finding #2.
- **Phase C:** operator UI (list/create/rotate/revoke, plaintext-once, legacy notice); optional grace-window rotation; per-module scope picker.
- **Phase D (later):** drop `tenants.api_key_hash`; consider expiry defaults, IP allow-listing, token-exchange.

---

## 12. Open questions for the implementer

1. **Rotation grace window** — support overlapping validity (old key lives N hours), or hard cutover only? (Recommend offering grace as an option; agents can't always be updated instantly.)
2. **Scope granularity at launch** — ship `read`/`write` presets only, or per-module immediately? (Storage/enforcement support per-module from day one; it's purely a UI decision.)
3. **Default expiry** — non-expiring by default (operationally simpler) or nudge toward expiry for agent keys?
4. **`last_used_at` precision** — acceptable staleness (e.g. 5 min) vs. write cost. Confirm the KV-gated throttle approach.
5. **Unified permission model** — keep roles (humans) and scopes (keys) as parallel systems (recommended, smaller), or converge on one permission set long-term?
6. **Legacy key visibility** — show backfilled legacy keys in the UI with a "retire me" prompt, or hide until rotated?

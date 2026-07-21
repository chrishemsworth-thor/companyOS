# Google Email (Gmail / Workspace)

Send email through connected Google mailboxes — to anyone, internal or
external (Gmail draws no such distinction). Two kinds of connection:

- **Shared inbox** (`kind: "shared"`) — a tenant-owned mailbox such as
  `support@company.com`. An admin runs the OAuth flow once and the whole
  tenant can send as it.
- **Send-as-user** (`kind: "user"`) — a personal mailbox an operator connects
  so CompanyOS can send as them. Private to that user within the tenant.

**Phase-1 scope:** outbound send only. Inbound read (Gmail history sync,
bus-events-only) is a planned Phase 2 — see [Phase 2](#phase-2-inbound-read).

## How it works

```
Operator                         Google                      CompanyOS
   │  POST /v1/google-accounts/connect ─────────────────────────▶│  mint state (KV, 10min, single-use)
   │◀──────────────────────── { authorize_url } ─────────────────│
   │  ── browser ▶ consent screen ▶ ──▶ Google
   │                                       │  redirect w/ code+state
   │                                       ▼
   │                         GET /oauth/google/callback ─────────▶│  exchange code → refresh token
   │                                                              │  encrypt (AES-256-GCM) → google_accounts
   │◀──────────────── "Connected. You can close this window." ───│
   │
   │  POST /v1/google-accounts/:id/send  ───────────────────────▶│  refresh access token (KV-cached)
   │◀──────────── { delivery_ref, thread_id } ───────────────────│  → Gmail users.messages.send
```

- `google_accounts` (migration 0015) holds one row per connected mailbox:
  tenant, kind, owner (for `user`), granted scopes, and the **encrypted**
  refresh token. Access tokens are never stored — they are minted on demand
  and cached in `CONFIG_CACHE` KV (`google-access-token:<id>`, TTL ≈ 59 min).
- The OAuth `state` is an unguessable, single-use nonce stored in KV; it is
  minted inside the authenticated `/connect` call and carries the tenant/user
  binding server-side, so the unauthenticated callback can't be forged onto
  another tenant. This mirrors, in spirit, how `/webhooks` self-authenticates.
- The module lives in `src/integrations/google/` — it needs an OAuth token
  lifecycle, so it fits neither `src/delivery/` (static-secret) nor
  `src/webhooks/` (signature-verified push).

## Configuration

Requires (production: `wrangler secret put …`; dev placeholders in
`wrangler.jsonc`):

| Secret | Purpose |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth 2.0 web client. Register `https://<worker-domain>/oauth/google/callback` as an authorized redirect URI. |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | Base64 of 32 random bytes (`head -c 32 /dev/urandom \| base64`) — the AES-256-GCM key for refresh tokens at rest. |
| `GOOGLE_OAUTH_REDIRECT_URI` (optional) | Override when the public origin differs from what the Worker sees. Must match a registered redirect URI. |

When any of the three required secrets is absent, the Google routes fail
closed (503). One-time Google Cloud setup: enable the Gmail API, configure the
OAuth consent screen (`gmail.send`, plus `gmail.readonly` for send+read), and
create the web OAuth client. `gmail.send`/`gmail.readonly` are *sensitive*
scopes — going past ~100 users needs Google's OAuth verification.

## API

| Route | Description |
| --- | --- |
| `POST /v1/google-accounts/connect` | `{ kind, label?, access: "send" \| "send_and_read" }` → `{ authorize_url }`. `kind: "user"` requires a signed-in human. |
| `GET /v1/google-accounts` | List connected accounts (never returns token material). Personal accounts are visible only to their owner. |
| `POST /v1/google-accounts/:id/send` | `{ to[], cc?, subject, body_text?, body_html?, thread_id? }` → `{ delivery_ref, thread_id }`. |
| `DELETE /v1/google-accounts/:id` | Revoke at Google (best-effort) and mark the row revoked. |

## Security

- **Refresh tokens** are encrypted at rest (AES-256-GCM, fresh IV per record,
  `enc_key_version` for future rotation) — see `crypto.ts`. Token material is
  never returned by any API response.
- **Tenant isolation**: every DAO call filters by `tenant_id`; a bare
  `account_id` is never trusted. The `state` nonce binds a connection to its
  tenant.
- **User isolation**: a `kind: "user"` account is usable and visible only to
  the human who connected it. Programmatic (API-key) callers may use shared
  accounts but never personal ones — impersonating a colleague's mailbox is
  not a tenant-root power.
- **Scope minimization**: `send` requests `gmail.send` only. Incremental auth
  (`include_granted_scopes`) lets a send-only account add read later without a
  full reconnect. The send path checks the granted scope and 403s with
  `missing_scope` if it's absent.

## Phase 2 (inbound read)

Planned, not yet built: poll each read-scoped account on the Workers cron
(mirroring `overdue-sweep.ts`), advance a per-account Gmail `history_id`
checkpoint (the column already exists on `google_accounts`), and **emit bus
events only** — no ticket auto-creation or inbox UI in the first cut. Inbound
needs a new `source_module` value (e.g. `comms`) on the event envelope.

# Webhook Ingestion (JIRA · GitHub · Bitbucket)

Inbound, read-only sync from external development trackers into the native
[Build module](build.md). Teams keep working in JIRA, GitHub, or Bitbucket;
CompanyOS mirrors their issues into Build and logs code activity (pushes,
pull requests) on the event bus — so agents see engineering work alongside
Finance, CRM, and Support without anyone changing tools.

**Phase-1 scope:** inbound only. No writes back to the provider, no comment
or sprint sync, no user-identity mapping (assignees land in the free-text
`assignee` field). See [Limitations & phase 2](#limitations--phase-2).

## How it works

```
JIRA / GitHub / Bitbucket
        │  POST /webhooks/:provider/:source_id   (signature-verified)
        ▼
  normalize (pure per-provider mapping)
        │
        ├─ issue events  → upsert Build issue (external_refs anchor)
        │                  → issue.created / issue.status_changed / issue.completed
        └─ code events   → code.push / code.pr_opened / code.pr_merged (log-only)
```

- `webhook_sources` (migration 0014) holds one row per connected tracker or
  repo: tenant, provider, target Build project, optional project/repo filter.
  The `source_id` (`whs_…`) doubles as the unguessable URL token.
- `external_refs` maps the provider identity (`PROJ-123`, `owner/repo#42`)
  to the mirrored Build issue — redeliveries and out-of-order events converge
  on the same issue instead of duplicating it.
- Mirrored issues carry `origin: jira|github|bitbucket` (native issues are
  `origin: native`), and their `issue.created` events carry `provider`,
  `external_id`, and `external_url` provenance.
- All writes go through the normal Build service, so its invariants and event
  trail hold. When an external tracker reopens a settled issue straight to
  in-progress (legal there, illegal here), ingestion performs a two-step
  reopen — `done → todo → in_progress` — emitting an honest
  `issue.status_changed` pair.

## Provisioning

Create a source (authed, tenant-scoped):

```
POST /v1/webhook-sources
{ "provider": "github", "project_id": "prj_…", "external_project_key": "acme/api" }

201 {
  "source_id": "whs_…", "provider": "github", "project_id": "prj_…",
  "url": "https://<host>/webhooks/github/whs_…",
  "secret": "9f2c…"    ← shown exactly once
}
```

`GET /v1/webhook-sources` lists sources (never secrets);
`DELETE /v1/webhook-sources/:id` disables one (deliveries then 404).
`external_project_key` (JIRA project key or `owner/repo`) is optional but
recommended: deliveries for anything else are acknowledged with
`202 {status: "ignored"}` — useful when a workspace-wide JIRA webhook or an
org-wide GitHub app fans out more than one project.

Then paste the URL + secret into the provider:

| Provider | Where | Notes |
|---|---|---|
| **GitHub** | Repo → Settings → Webhooks → Add webhook | Payload URL = `url`, content type `application/json`, Secret = `secret`. Events: Issues, Pushes, Pull requests. |
| **JIRA Cloud** | Settings → System → WebHooks | URL = the returned `url` (it already embeds `?secret=…`). Events: Issue created/updated/deleted. |
| **Bitbucket Cloud** | Repo → Settings → Webhooks | URL = `url`, **Secret = `secret` (required — unsigned hooks are rejected)**. Triggers: Issue created/updated, Push, Pull request created/merged. |

## Security model

- **Derived secrets, nothing stored.** The per-source secret is
  `hex(HMAC-SHA256(WEBHOOK_MASTER_SECRET, source_id))`, computed at
  provisioning (shown once) and recomputed per delivery. A leaked database
  contains no signing material; rotation = disable the source, create a new
  one. `WEBHOOK_MASTER_SECRET` is set via `wrangler secret put`; when unset,
  both ingress and provisioning fail closed with 503.
- **GitHub** deliveries verify `X-Hub-Signature-256` (HMAC-SHA256 of the raw
  body); **Bitbucket** verifies `X-Hub-Signature` the same way. Comparisons
  are constant-time; bad signatures → 401.
- **JIRA Cloud has no native HMAC**, so its secret rides in the webhook URL
  as `?secret=…`. That authenticates the caller but gives no body integrity,
  and URLs can leak via logs/proxies — an inherent JIRA Cloud limitation.
  Treat the JIRA URL like a credential.
- Unknown, disabled, and wrong-provider tokens all return a uniform 404.

## Status & priority mapping

| Provider signal | Build status |
|---|---|
| JIRA `statusCategory` new / indeterminate / done | todo / in_progress / done |
| JIRA done + resolution ~ `won't/cancel/declined` | cancelled |
| JIRA issue deleted | cancelled |
| GitHub open (incl. reopened) | todo |
| GitHub closed `completed` / `not_planned` | done / cancelled |
| Bitbucket new / open, on hold / resolved, closed / invalid, duplicate, wontfix | todo / in_progress / done / cancelled |

| Provider priority | Build priority |
|---|---|
| JIRA Highest / High / Medium / Low, Lowest | urgent / high / medium / low |
| GitHub (no priority) | medium |
| Bitbucket trivial, minor / major / critical / blocker | low / medium / high / urgent |

## Idempotency & ordering

- GitHub (`X-GitHub-Delivery`) and Bitbucket (`X-Request-UUID`) redeliveries
  are deduplicated through the `idempotency_keys` table — a replay returns
  the stored response without re-running the write.
- JIRA has no delivery id; its ingestion is a naturally idempotent upsert
  keyed on `external_refs`, so redelivery converges on the same issue.
- Ordering is last-write-wins on fields; there are no sequence numbers in
  phase 1. Events on the bus dedup on `event_id` (`INSERT OR IGNORE` into
  `events_log`).

## Events emitted

Issue mirroring emits the existing Build events (`issue.created` — now with
optional provenance fields — `issue.status_changed`, `issue.completed`),
attributed to actor `{type: "system", id: "webhook:<provider>"}`. Code
activity adds three log-only event types (no agent routing):

| Event | Payload |
|---|---|
| `code.push` | `provider, repo, ref?, commit_count?, external_actor?, external_url?` |
| `code.pr_opened` | `provider, repo, external_id, title, source_branch?, target_branch?, external_actor?, external_url?` |
| `code.pr_merged` | same as `code.pr_opened` |

## Limitations & phase 2

- **No outbound sync** — changing a mirrored issue in CompanyOS does not
  write back to the provider (and the next inbound delivery will overwrite
  local field edits).
- **Field edits emit no event** — `updateIssueDetails` is silent until an
  `issue.updated` event type exists.
- **No comments, sprints, or attachments**; assignees are free-text names,
  not mapped identities.
- **Concurrent first deliveries** of the same external issue can strand one
  duplicate Build issue (the external-ref claim is `INSERT OR IGNORE`; the
  loser's issue is orphaned). Rare and benign; the ref always points at one
  winner.
- Phase-2 candidates: outbound status sync, comment mirroring,
  `issue.updated`, provider-identity → user mapping, webhook delivery log.

## Tests

`test/webhook-normalize.test.ts` (pure mapping tables),
`test/webhooks-jira.test.ts`, `test/webhooks-github.test.ts`,
`test/webhooks-bitbucket.test.ts` (raw signed fixtures through the real
Worker → issue rows, external refs, captured events, consumer audit-logging),
`test/webhook-sources.test.ts` (provisioning, one-time secrets, disable).

# Quotes

The pre-sale document a rep sends before an invoice exists, and — since S9 —
the surface a customer signs it on. `source_module: 'sales'`.

**In scope:** line items with per-line discounts and a single header tax, a
branded HTML document, a public token-addressed link, click-to-sign acceptance
with an evidentiary audit record, internal sign-off above a value threshold, and
one-call conversion to a finance invoice.
**Out of scope:** PDF generation (browser print-to-PDF is the answer today),
multi-party counter-signing, certified DSA-1997 digital signatures,
payment-on-acceptance, a WYSIWYG template designer. All are PRD-004 non-goals or
P1/P2 items.

> **Not legal advice.** PRD-004 carries a blocking open question: whether
> click-plus-audit-trail acceptance meets Malaysia's ECA 2006 for the contract
> types SME customers will use, and what the agreement text should say. The
> wording in `src/modules/quotes/agreement.ts` is written **to be reviewed by a
> Malaysian lawyer**, not relied on. Build and test against it; do not put a
> real customer through it until that is confirmed.

## Data model

`migrations/0013_quotes.sql` created `quotes`, `quote_lines`, `contacts`,
`company_profile`, `quote_branding` and `document_counters`.
`migrations/0028_quote_signing.sql` (S9) rebuilt `quotes` and added the signing
tables.

| Table | Purpose | Key columns |
|---|---|---|
| `quotes` | Header, denormalized totals, lifecycle | `quote_id`, `quote_number`, `status`, `version`, `supersedes_quote_id`, `superseded_by_quote_id`, `first_viewed_at`, `view_count`, `accepted_acceptance_id`, `sign_off_approval_id` |
| `quote_lines` | Positional lines | `line_no` (PK part), `line_total_cents` |
| `quote_links` | Public link, one live per quote | `token_hash`, `expires_at`, `revoked_at` |
| `quote_acceptances` | The evidentiary record | `decision`, `signatory_*`, `document_sha256`, `artifact_file_id`, `ip_address`, `user_agent`, `agreement_version`, `agreement_text` |
| `quote_branding` | Per-tenant quote configuration | `logo_file_id`, `footer_text`, `sign_off_threshold_cents`, `template_config` (JSON) |

### `quotes` has no status CHECK

0028 rebuilt the table to drop it, following
[`0022_roles_drop_check.sql`](../../migrations/0022_roles_drop_check.sql).
SQLite cannot alter a CHECK in place, S9's sign-off needed a new
`pending_approval` status, and paying the rebuild once means no future status
costs another. `QuoteStatus` and `QUOTE_TRANSITIONS` in
`src/modules/quotes/types.ts` are now the source of truth, and both `sendQuote`
and the shared `transition()` check them.

`quote_lines` is the only table referencing `quotes`, which made the rebuild
0022's "group 3": copy the child rows out, empty, rebuild the parent, copy back.
D1 refuses `DROP TABLE` while another table's rows reference it and **every**
PRAGMA escape hatch is ignored — 0022's header documents the four that were
tried.

## Lifecycle

```
draft ──────────────► sent ──────► accepted ──► converted
  │                    │  ├──────► rejected
  │                    │  └──────► expired  (daily cron)
  └──► pending_approval ┘
            └──► draft  (sign-off rejected)
```

`rejected`, `expired` and `converted` are terminal. Expired is terminal on
purpose: re-opening one would mean a customer agreeing to pricing the tenant had
already withdrawn. The way back from any terminal state is a **new version**,
which is a new row.

### Immutability is the load-bearing rule

PRD-004: *"If the document can change after signing, the signature is
worthless."* Only `draft` is editable — `pending_approval` is frozen too, or the
price an approver agreed to is not the price that goes out.

`PATCH /v1/quotes/:id` on anything else returns **409 `locked`** with a message
naming the way forward, and `POST /v1/quotes/:id/version` is that way: a new
`draft`, its own id and number, `version = n+1`, linked both ways. The superseded
quote is untouched apart from its back-pointer — somebody may have been shown it,
so it must still render exactly as it did.

Totals are always **recomputed** from the effective lines and tax rate on a
PATCH, never patched, so a header-only edit cannot leave `grand_total_cents`
disagreeing with the lines it summarises.

## The public link

`GET /q/:token`, mounted **outside `/v1`** alongside `/webhooks`,
`/oauth/google` and `/files` — the codebase's position for a caller with no
credential. The token is the whole authorization story: it names the quote, and
resolving it establishes the tenant.

- **32 random bytes, stored hashed.** Same discipline as invites and password
  resets (`src/auth/tokens.ts`). The raw token is in the mint response and
  nowhere else; a database leak yields no working links.
- **Minting revokes the previous link**, so a quote never has two live tokens and
  "revoke" is a complete action rather than a guess at how many are outstanding.
- **Mintable from `sent` onwards only.** A token on a draft or a quote awaiting
  sign-off would publish something the tenant has not committed to.
- **Expiry aligns to the quote's own** `expiry_date` (end of that day). A quote
  with no expiry gets a link with none.
- **Expired and revoked links render the document with an explanatory banner**,
  not a 404. Only an unresolvable token 404s, and every miss returns a
  byte-identical body.

`quote.viewed.v1` fires on the **first view only**, enforced by a conditional
`first_viewed_at IS NULL` UPDATE whose `meta.changes` decides the emit — two
simultaneous first views still produce one event. View state lives on the
**quote**, not the link, so revoking and re-issuing cannot re-fire it.

### Rate limiting

PRD-004 listed this as an open engineering question. Reuses `rateLimit()` on the
SESSIONS KV — the same best-effort dampener `/v1/auth/*` uses, WAF-backed in
production — under its own keys, with three limits for three different abuses:

| key | limit | why |
|---|---|---|
| `q:view:{ip}` | 120/hr | a customer reloading, forwarding and printing is normal |
| `q:sign:{ip}` | 20/hr | each one renders and archives an artifact |
| `q:miss:{ip}` | 30/hr | counted **only on misses**, so a scanner is throttled and a customer never is |

## Acceptance

The point of the whole PRD. Three properties, each enforced structurally:

1. **The hash matches the artifact.** `quote_acceptances.document_sha256` is the
   digest the files primitive computed over the bytes it stored — copied, never
   recomputed, so the two cannot drift.
2. **The artifact is self-contained.** Logo and signature are inlined as `data:`
   URIs. A `/files/{id}` reference would stop resolving the moment the tenant
   deleted the file, and the artifact has to keep rendering identically after any
   branding change.
3. **The artifact exists before the quote moves.** Archival happens first; only
   then does one `db.batch()` write the acceptance and flip the quote. The worst
   failure is an orphaned file. The reverse — an accepted quote with no evidence
   — is unrecoverable, because the evidence is the point.

The agreement text is a **versioned constant**, and every acceptance stores the
version *and* the exact words shown. Changing the wording means bumping
`AGREEMENT_VERSION`: a record that re-renders under new terms is not a record.

Declines share the table — same evidentiary shape, no artifact, because nothing
was agreed. This is also what keeps PRD-004's P2 multi-party counter-signing
additive: a second signatory is a second row.

**Signatory attribution** reuses S8's `resolveContact(…, "signatory")`. The form
pre-fills only from a genuine `signatory` role match — falling back to "any
contact" would put a warehouse manager's name in a box that says *"I am
authorised to accept on behalf of the organisation"*. Attribution is recorded
only when the submitted email actually matches a contact: *"somebody we have
never heard of accepted this"* is precisely what an audit reader needs to see.

Conversion carries it forward — `invoices.quote_id` and
`invoices.quote_acceptance_id` — so the chain survives into the document that
actually gets chased and paid.

## Internal sign-off (PRD-004 P1)

`quote_branding.sign_off_threshold_cents` — NULL means no gate, which is what
every tenant has until somebody sets one. A quote **at or above** it parks in
`pending_approval` on send and raises an approval through the S3 primitive
(`subject_type = 'quote'`, `role_based` → admin or finance). No approvals
mechanism of its own; no `NOTIFICATION_MAP` entry either, because
`approval.requested` already notifies.

`requestApproval` runs **before** the status moves, so a tenant with nobody able
to sign off keeps an editable draft rather than a quote wedged with no one to
release it — and gets a 422 saying so, not a 500.

Approving **sends** the quote, in the same batch as the decision (see
[`approvals.md`](approvals.md#decision-effects-added-by-s5)). Rejecting returns
it to `draft` with the comment on `sign_off_comment`; re-sending raises a *new*
approval rather than reopening the rejected one (SESSION-PLAN C8).

## API

`QuotesError` maps to 404 (`not_found`), 409 (`invalid_status`, `locked`,
`already_superseded`) and 422 (`invalid_request`, `empty_lines`,
`invalid_total`). The send path can also surface `ApprovalsError` 422
`no_approver`.

| Method & path | Auth | Notes |
|---|---|---|
| `GET/POST /v1/quotes` | `crm` | list / create |
| `GET /v1/quotes/:id` | `crm` | header + lines |
| `PATCH /v1/quotes/:id` | `crm` | **draft only**; 409 `locked` otherwise |
| `POST /v1/quotes/:id/version` | `crm` | new draft from a locked quote |
| `POST /v1/quotes/:id/send` | `crm` | → `sent`, or `pending_approval` above the threshold |
| `POST /v1/quotes/:id/accept` `/reject` | `crm` | operator-recorded outcome (a yes taken over the phone) |
| `POST /v1/quotes/:id/convert` | `crm` | → invoice, carrying the acceptance |
| `GET /v1/quotes/:id/document` | `crm` | the live branded HTML |
| `POST/GET/DELETE /v1/quotes/:id/link` | `crm` | mint (token returned **once**) / metadata / revoke |
| `GET /v1/quotes/:id/acceptances` | `crm` | the audit record(s) |
| `GET /v1/quotes/:id/artifact` | `crm` | the frozen signed document, byte-for-byte |
| `GET /q/:token` | **none** | the customer-facing page |
| `POST /q/:token/accept` `/decline` | **none** | click-to-sign |
| `GET /q/:token/artifact` | **none** | what the customer signed |

The agreement checkbox is enforced **server-side** (`agreed !== true` → 422), not
only in the page: a customer can always send the request by hand.

## Rendering

`src/modules/quotes/document/render.ts` returns document **parts** (title,
styles, body) rather than a page, because three surfaces render the same
document: the console's `/document` route, the public page, and the artifact
frozen at acceptance. A separate customer-facing template would drift, and the
first time it drifted the customer would be signing something the operator never
saw.

Logo precedence: inlined `data:` URI (the artifact) → `logo_file_id` → `logo_url`
→ the company name in type. No logo is a first-class outcome.

## Events

| Event | When |
|---|---|
| `quote.created.v1` | create, and each new version (`supersedes_quote_id`) |
| `quote.sent.v1` | send, or a sign-off approval |
| `quote.viewed.v1` | **first** public view only |
| `quote.accepted.v1` | acceptance — carries `acceptance_id`, `document_sha256`, signatory |
| `quote.rejected.v1` | decline — carries the reason |
| `quote.expired.v1` | daily cron sweep |
| `quote.converted.v1` | conversion — carries `acceptance_id` |

`quote.viewed.v1` is the only NEW type S9 registered. The accepted/rejected/
converted schemas gained **optional** fields on their existing non-strict
objects — no v2, the same additive treatment S8 gave `collections.decision.v1`.
They are optional rather than required because the operator-side accept/reject
routes still exist and genuinely carry no signatory.

## Console

`ui/src/pages/quotes/` (list, detail with the link and acceptance panels),
`ui/src/pages/settings/QuoteBranding.tsx` (logo upload, colours, footer,
threshold), and
`ui/src/features/approvals/renderers/QuoteApprovalCard.tsx` — the `quote` card
for PRD-007's registry, showing total, subtotal, tax, validity, the lines, and
the discount as a share of list.

## Tests

| File | Covers |
|---|---|
| `test/quotes.test.ts` | totals, tax rounding, lifecycle, conversion, branding toggles |
| `test/quote-immutability.test.ts` | the edit path, the 409s, versioning |
| `test/quote-public-link.test.ts` | token hashing, view-once, expired/revoked/unknown, rate limits |
| `test/quote-acceptance.test.ts` | **hash == artifact**, **identical after a branding change**, the audit record, refusals, decline, conversion |
| `test/quote-branding-logo.test.ts` | logo rendering, the C3 public-read scope, policy limits, footer |
| `test/quote-sign-off.test.ts` | the threshold gate, the decision, no-approver |
| `ui/…/QuoteApprovalCard.test.tsx` | the approvals card |

**Harness notes.** Tests that assert on `events_log` must run against an env with
**no `EVENTS` binding**, so `ensureEventBus()` substitutes the inline free-plan
bus; with the real queue binding, delivery happens outside the isolated-storage
frame and nothing is observable. And drain any R2 response body you do not
assert on — an unread stream breaks the storage teardown between tests.

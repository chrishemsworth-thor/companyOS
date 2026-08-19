# S9 — PRD-004 Quote Branding & Click-to-Sign: Implementation Plan

**Session:** S9 · **PRD:** [004](PRD-004-quote-branding-and-signing.md) ·
**Branch:** `claude/quote-branding-signing-q4s0dv` ·
**Migration number:** `0028` (highest on `main` is `0027_crm_depth.sql`)

Read [`SESSION-PLAN.md` § C3](SESSION-PLAN.md#c3--file-reads-prd-000-says-always-authenticated-prd-004-needs-public)
first. **S2 already resolved it**: `src/modules/files/policy.ts` is per-purpose,
`quote_logo` is already `publiclyReadable: true`, and `GET /files/:id` outside
`/v1` already serves it. S9 **extends the policy table** — it does not add a
second public read path. A `quote_branding` table also already exists
(`0013_quotes.sql`); S9 extends it.

---

## Outcome

**All five phases shipped**, one commit each, on
`claude/quote-branding-signing-q4s0dv`. Final: typecheck clean both sides,
**63 test files / 1159 tests** in the Workers suite (from 58 / 1087) and
**19 / 181** in the console (from 18 / 172).

Two things went differently from this plan, both recorded here rather than
quietly:

1. **The logo phase (D) ran before acceptance (C).** The artifact frozen at
   acceptance has to inline the logo to satisfy *"renders identically after the
   tenant changes their branding"*, so the logo had to exist before the freeze
   was written. Keeping PRD-004's listed order would have meant writing the
   acceptance path twice.
2. **The console work was larger than "one renderer file".** The plan named the
   approvals card and the QuoteDetail panels but omitted the Quote Branding
   settings page — which meant shipping a logo feature with no way for a tenant
   to set a logo. Added, along with `postForm` and `delete` on the API client to
   support it.

One fix outside S9's scope: the claims submit path called `requestApproval` the
same way the new send path does, and surfaced its 422 `no_approver` as a 500.
Corrected while wiring the equivalent handler for quotes.

---

## Phase order

PRD-004's own order, which is also the risk order. Immutability first because
everything after it is worthless without it.

| Phase | Scope | Pri | Commit |
|---|---|---|---|
| **A** | Immutability: edit path + `draft`-only rule + versioning | P0 | ✅ `6932aef` |
| **B** | Public link `/q/:token` — hashed token, expiry, revoke, `quote.viewed.v1`, rate limiting | P0 | ✅ `fc7fd2d` |
| **D** | Logo, accent colour, footer text via `quote_logo` | P0 | ✅ `38af24e` — taken early, see Outcome |
| **C** | Click-to-sign: acceptance record, frozen artifact + SHA-256, decline | P0 | ✅ `9759b46` |
| **E** | Internal sign-off above a threshold (S3 approvals) + the `quote` inbox card | P1 | ✅ `5881172` |

**A–D must land.** If the session runs long the stop point is after D, reported
rather than rushed. E is the only part that needs S3, and the only P1 here.

---

## Decisions this plan takes

Recorded so they are reviewable before any code exists.

### 1. `quotes` is rebuilt once, and its `status` CHECK is dropped

`pending_approval` (Phase E) is a new status, and SQLite cannot alter a CHECK in
place. `0022_roles_drop_check.sql` already spent this rebuild on `users` and
documented the trap in detail: D1 refuses `DROP TABLE` while another table's
rows reference it, and **every** `PRAGMA` escape hatch is ignored.

`quotes` is referenced from exactly one place — `quote_lines`, whose FK is NOT
NULL — so it is 0022's "group 3": copy the child rows out, empty the table,
rebuild the parent, copy them back. Contained, and much smaller than the `users`
case (nothing references `quote_lines`).

Doing it once, the CHECK is **dropped rather than extended**, exactly as 0022
did for `users.role`: `QuoteStatus` and the transition table in
`src/modules/quotes/types.ts` become the single source of truth, and no future
status costs another rebuild. This is a status vocabulary, not a ledger or
tenant-isolation guarantee, so standing rule 1 is untouched.

### 2. Approval granted ⇒ the quote is sent

PRD-004's criterion is *"Given approval is granted, then the quote can be
sent."* Two readings: auto-send, or return to an editable state where `send`
now works.

**Plan: the approval decision transitions the quote to `sent`**, atomically,
through S3's `decision-effects.ts` hook. Returning an approved quote to `draft`
would let a junior edit the price after approval and send it unapproved — which
is the exact failure the requirement exists to prevent. The operator already
asked to send; the approval was the gate, not a separate instruction. The
outcome is strictly stronger than the criterion and cannot be gamed.

Rejection returns the quote to `draft` and stores the approver's comment on
`quotes.sign_off_comment`, matching PRD-006's rejection wording.

### 3. The archived artifact inlines its images as `data:` URIs

*"Given the archived artifact, then it renders identically after the tenant
changes their branding settings"* is one of the two load-bearing criteria. An
artifact referencing `<img src="/files/{logo_id}">` fails it the moment the
tenant deletes that logo (uploads are immutable, but deletion is not). So at
acceptance the logo bytes and the signature bytes are base64-inlined into the
frozen HTML, which is then a genuinely self-contained document. `quote_artifact`
gets an 8 MB ceiling to accommodate a 2 MB logo at base64 expansion.

### 4. The agreement text lives in code, versioned

PRD-004's open question makes the wording a lawyer's call. So the text is a
constant in `src/modules/quotes/agreement.ts` with an explicit
`AGREEMENT_VERSION`, the version is stored on every acceptance record, and
changing the wording means bumping the version — never rewriting what a past
signatory agreed to. The file carries the "not legal advice, confirm before
customer use" note from the PRD.

### 5. A public link may only be minted from `sent` onwards

Minting a token for a `draft` would publish an unfinished quote. The link route
409s on `draft`/`pending_approval` with the state-machine convention.

### 6. No `NOTIFICATION_MAP` entry for `quote.accepted`

Same reasoning S5 recorded for `claim.*`: the consumer must not query D1 for a
recipient, and the payload carries no user id (a quote has no owning user
column). The `approval.*` events already notify for the Phase E sign-off. Left
as a documented gap rather than an invented mechanism (standing rule 2).

---

## Phase A — Immutability (must land)

### The gap this closes

There is **no edit endpoint on quotes today** — so there is currently nothing
for "an edit is attempted" to 409 against. The criterion requires the edit path
to exist. Phase A therefore adds it *and* locks it.

### D1 — `0028_quote_signing.sql`, section (a)

Rebuild `quotes` (per decision 1) with the status CHECK dropped and the new
columns present from the start:

```sql
version                 INTEGER NOT NULL DEFAULT 1
supersedes_quote_id     TEXT           -- the quote this one replaces
superseded_by_quote_id  TEXT           -- set on the old one when superseded
first_viewed_at         TEXT           -- Phase B
last_viewed_at          TEXT           -- Phase B
view_count              INTEGER NOT NULL DEFAULT 0
accepted_acceptance_id  TEXT           -- Phase C, the winning acceptance record
sign_off_approval_id    TEXT           -- Phase E
sign_off_comment        TEXT           -- Phase E, the rejecting approver's words
```

Stash/restore `quote_lines` around the rebuild; recreate `idx_quotes_customer`
and `idx_quotes_status`; add `idx_quotes_supersedes`.

### Service — `src/modules/quotes/service.ts`

- `EDITABLE_STATUSES = ["draft"]` and `assertEditable(quote)` throwing
  `QuotesError("locked", …, 409)` whose message names the fix: *"quote {number}
  is {status} and cannot be edited; create a new version"*.
- `updateQuote()` — header fields plus optional full `lines` replacement,
  recomputing totals through the existing `computeQuoteTotals`.
- `createQuoteVersion()` — copies a locked quote's header and lines into a new
  `draft` with `version = n+1`, `supersedes_quote_id` set, and stamps
  `superseded_by_quote_id` on the original. One `db.batch()`.
- A `TRANSITIONS` table replacing the ad-hoc `from:` lists in `transition()`,
  now that `pending_approval` exists.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `PATCH` | `/v1/quotes/:id` | draft only; 409 otherwise |
| `POST` | `/v1/quotes/:id/version` | 201 with the new draft; 409 on a quote already superseded |

### Tests — `test/quote-immutability.test.ts`

- PATCH a draft succeeds and recomputes totals.
- PATCH a `sent` quote → 409, message directs to a new version. Same for
  `accepted`, `expired`, `converted`.
- `POST /version` from `sent` → new `draft`, `version = 2`, both link columns set.
- Accepting an already-accepted quote → 409; sending a `sent` quote → 409.
- The superseded quote stays readable and keeps its own number.

---

## Phase B — The public link (must land)

### D1 — section (b)

```sql
CREATE TABLE quote_links (
  link_id     TEXT NOT NULL,               -- qlink_01J...
  tenant_id   TEXT NOT NULL REFERENCES tenants(tenant_id),
  quote_id    TEXT NOT NULL,
  token_hash  TEXT NOT NULL,               -- SHA-256 hex; the token itself is never stored
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (...),
  expires_at  TEXT,                        -- aligned to the quote's expiry_date when it has one
  revoked_at  TEXT,
  PRIMARY KEY (tenant_id, link_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, quote_id)
);
CREATE UNIQUE INDEX idx_quote_links_token ON quote_links (token_hash);
CREATE INDEX idx_quote_links_quote ON quote_links (tenant_id, quote_id);
```

The unique index is global, not tenant-scoped, on purpose: the public route has
no tenant context and resolves the tenant *from* the token.

Token: 32 random bytes, base64url (`crypto.getRandomValues`), returned exactly
once at mint. Stored hashed with the existing `sha256Hex`, so a database leak
does not hand over live links.

### Service — `src/modules/quotes/links.ts` (new)

`mintLink` / `getLinkByToken` / `revokeLink` / `recordView`.

`recordView` is the "fires once" mechanism: a conditional
`UPDATE quotes SET first_viewed_at = ? WHERE … AND first_viewed_at IS NULL`
whose `meta.changes` decides whether `quote.viewed.v1` is emitted. `last_viewed_at`
and `view_count` update on every view. First-view state lives on the **quote**,
not the link, so revoking and re-issuing a link cannot re-fire the event.

Link states, resolved in one place: `valid` | `revoked` | `expired` |
`not_found`. Only `not_found` is a 404.

### Rendering — `src/modules/quotes/document/public-page.ts` (new)

Wraps the existing `renderQuoteHtml` (unchanged in shape) in the public shell:
no console chrome, plus one of — the accept/decline form, an "already accepted"
panel linking the archived artifact, or an explanatory expired/revoked page.
`renderQuoteHtml` gains optional `logoDataUri`, `footerText` and `acceptance`
inputs; every existing caller keeps working.

### Endpoints

Authenticated (`/v1/quotes`, existing `crm` capability mount):

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/quotes/:id/link` | mint; returns `token` and `url` **once**; 409 unless `sent`+ |
| `GET` | `/v1/quotes/:id/link` | metadata only — the token cannot be shown again |
| `DELETE` | `/v1/quotes/:id/link` | revoke |

Unauthenticated — a new `publicQuotes` router mounted at **`/q`, outside
`/v1`**, alongside `/webhooks`, `/oauth/google` and `/files`. It is not added to
`V1_MOUNTS`, and `test/capabilities.test.ts` only walks `/v1` paths, so no
capability row applies (the same position `/files` already occupies).

| Method | Path | Notes |
|---|---|---|
| `GET` | `/q/:token` | the public page; 404 on an unknown token, explanatory page on expired/revoked |
| `POST` | `/q/:token/accept` | Phase C |
| `POST` | `/q/:token/decline` | Phase C |
| `GET` | `/q/:token/artifact` | Phase C — what was actually signed |

### Rate limiting (PRD-004's engineering open question)

Reuses `rateLimit()` on the `SESSIONS` KV namespace — the same dampener
`/v1/auth/*` uses, already documented as best-effort and WAF-backed in
production. Public limits are separate keys and tighter than the authenticated
API's:

| Key | Limit |
|---|---|
| `q:view:{ip}` | 120 / hour |
| `q:sign:{ip}` | 20 / hour (accept + decline) |
| `q:miss:{ip}` | 30 / hour — counted **only on token misses**, so enumeration is throttled without penalising a customer reloading their own quote |

Over the limit → 429 with `code: "rate_limited"`, matching the auth routes.

### Event — `quote.viewed.v1`

New file `src/schemas/events/quote.viewed.v1.ts`, registered in
`registry.ts`. Payload: `quote_id`, `customer_id`, `link_id`, `viewed_at`, and
optional `ip_address` / `user_agent` (PRD-004 asks for both on the view record).
`source_module: "sales"`.

**`quote.accepted.v1` and `quote.rejected.v1` already exist — extended, not
re-added**, per SESSION-PLAN. Both gain *optional* fields on their existing
non-strict `z.object` (`acceptance_id`, `signatory_name`, `signatory_email`,
`document_sha256`, `artifact_file_id`; `reason` on rejected). This is the same
additive move S8 made on `collections.decision.v1`, so no v2.

### Tests — `test/quote-public-link.test.ts`

- Valid token renders the branded document, with no console chrome.
- The raw token is returned once; `GET …/link` never returns it; the stored
  column is a hash, not the token.
- Expired link → 200 explanatory page containing "expired", **not** a 404.
- Revoked link → 200 explanatory page.
- Guessed/invalid token → 404, body identical to any other miss (no leakage).
- Two views → `quote.viewed` in `events_log` exactly once; `last_viewed_at`
  moves and `view_count` reaches 2.
- 429 once the per-IP view limit is exceeded.

---

## Phase C — Acceptance + audit (must land, load-bearing)

### D1 — section (c)

```sql
CREATE TABLE quote_acceptances (
  acceptance_id     TEXT NOT NULL,          -- qacc_01J...
  tenant_id         TEXT NOT NULL REFERENCES tenants(tenant_id),
  quote_id          TEXT NOT NULL,
  link_id           TEXT NOT NULL,
  decision          TEXT NOT NULL,          -- 'accepted' | 'declined'
  signatory_name    TEXT NOT NULL,
  signatory_email   TEXT NOT NULL,
  contact_id        TEXT,                   -- the matched PRD-003 signatory contact
  contact_match     TEXT,                   -- 'role' | 'primary' | 'any'
  agreement_version TEXT NOT NULL,
  agreement_text    TEXT NOT NULL,          -- the exact words shown, not a pointer to them
  document_sha256   TEXT,                   -- accepted only
  artifact_file_id  TEXT,                   -- accepted only
  signature_file_id TEXT,
  decline_reason    TEXT,
  ip_address        TEXT,
  user_agent        TEXT,
  created_at        TEXT NOT NULL DEFAULT (...),
  PRIMARY KEY (tenant_id, acceptance_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes(tenant_id, quote_id)
);
CREATE INDEX idx_quote_acceptances_quote ON quote_acceptances (tenant_id, quote_id);
```

One row per signatory, which is what keeps PRD-004's P2 multi-party
counter-signing purely additive. `agreement_text` is stored verbatim rather than
resolved from the code constant at read time — a record of what somebody agreed
to that changes when the constant changes is not a record.

Declines live here too: same shape, same evidentiary value, and a separate table
for "the customer said no" would duplicate every column.

### Files policy — `src/modules/files/policy.ts`

Two purposes touched, one added. **No second read path** (C3):

| Purpose | Change |
|---|---|
| `quote_artifact` | **new** — 8 MB, `text/html` only, not publicly readable |
| `signature` | tightened from the 10 MB default to 1 MB, `image/png`/`jpeg`/`webp` (no PDF) |
| `quote_logo` | unchanged — already 2 MB and already public |

One safety change in `src/gateway/routes/files.ts`: `streamFile` serves
`text/html` as `Content-Disposition: attachment`. `quote_artifact` is not
publicly readable, but an authenticated `GET /v1/files/:id` would otherwise
render stored HTML on the API origin. The artifact's *own* routes serve it as
`text/html` deliberately, with a restrictive CSP.

### Acceptance flow — `src/modules/quotes/acceptance.ts` (new)

1. Resolve the link → must be `valid`; the quote must be `sent` (accepted →
   409, expired → the Accept action is absent and the POST 409s).
2. Reject the request unless `agreed === true` (422). Name and email required.
3. Optional signature `data:` URL → `uploadFile(purpose: "signature")`.
4. Render the **frozen artifact**: the document, with the logo and signature
   inlined as `data:` URIs, plus the acceptance panel (name, email, UTC
   timestamp, IP, user agent, agreement version and text).
5. `uploadFile(purpose: "quote_artifact")` — the files primitive computes the
   SHA-256 itself, and **that same value** is written to
   `quote_acceptances.document_sha256`. One hash, one source, so the criterion
   cannot drift.
6. One `db.batch()`: insert the acceptance, move the quote to `accepted`, stamp
   `accepted_at` and `accepted_acceptance_id`.
7. Emit `quote.accepted.v1` with the acceptance fields.

Decline is the same shape minus the artifact: record the row, move to
`rejected`, emit `quote.rejected.v1` with the reason.

Signatory pre-fill reuses **S8's** `resolveContact(db, tenant, customer,
"signatory")` — no new resolution logic — and stores both `contact_id` and the
`matched` rung it came back with.

### Conversion carries the acceptance

`convertQuote` copies `accepted_acceptance_id` onto the invoice. D1 section (d):
`ALTER TABLE invoices ADD COLUMN quote_id TEXT` and
`ADD COLUMN quote_acceptance_id TEXT` (plain nullable ALTERs; `invoices` has no
CHECK to fight). `GET /v1/invoices/:id` returns both, so the audit trail
survives conversion.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/q/:token/accept` | public; the click-to-sign submit |
| `POST` | `/q/:token/decline` | public; optional reason |
| `GET` | `/q/:token/artifact` | public; the frozen HTML, exactly as stored |
| `GET` | `/v1/quotes/:id/acceptances` | the audit record(s) |
| `GET` | `/v1/quotes/:id/artifact` | authenticated retrieval of the same bytes |

### Tests — `test/quote-acceptance.test.ts`

The two that carry the feature, first:

- **Hash matches the artifact.** Accept, read the stored bytes back, recompute
  SHA-256 in the test, assert it equals `quote_acceptances.document_sha256` and
  the `files.sha256` row.
- **Renders identically after a branding change.** Accept; `GET
  /q/:token/artifact`; `PUT /v1/settings/quote-branding` with a different colour,
  font, footer and logo; fetch the artifact again; assert the two responses are
  byte-identical, that the new colour string is absent, and that the hash still
  matches.

Then the rest of PRD-004's list:

- Accept without the agreement checkbox → 422, no acceptance row, quote still `sent`.
- Accept an already-accepted quote → 409.
- Accept an expired quote → 409, and the public page shows no Accept control.
- Decline with a reason → `quote.rejected` in `events_log`, reason stored.
- Convert an accepted quote → the invoice carries `quote_acceptance_id`, and the
  artifact is still retrievable afterwards.
- A `signatory` contact (via S8) pre-fills the form and is recorded with
  `contact_match: "role"`; a customer with no contacts accepts fine with
  `contact_id: null`.
- Signature image is stored with `purpose = signature` and appears in the
  artifact as a `data:` URI, not as a `/files/` reference.

---

## Phase D — Logo, accent colour, footer (must land)

### D1 — section (e)

```sql
ALTER TABLE quote_branding ADD COLUMN logo_file_id  TEXT;  -- files.file_id, purpose quote_logo
ALTER TABLE quote_branding ADD COLUMN footer_text   TEXT;  -- terms, bank details, reg numbers
ALTER TABLE quote_branding ADD COLUMN sign_off_threshold_cents INTEGER;  -- Phase E; NULL = no sign-off
```

`logo_url` (an external URL) stays and keeps working; `logo_file_id` wins when
both are set and resolves to the existing public `/files/{id}` route. The accent
colour PRD-004 asks for is already a column (`accent_color`) and already
rendered — Phase D wires footer text and the uploaded logo through
`resolveTemplateConfig`'s neighbours in `settings.ts` and `render.ts`.

`sign_off_threshold_cents` lands in this migration rather than a sixth section
because `quote_branding` is already the per-tenant quote configuration surface
(it holds tax rate, currency and terms today), and one ALTER batch is cheaper
than two.

### Service

`upsertQuoteBranding` validates that `logo_file_id` resolves to a live file in
the caller's tenant with `purpose = quote_logo` — a 422 otherwise, so a broken
logo is caught at settings time and not at render time.

### Endpoints

`PUT /v1/settings/quote-branding` gains `logo_file_id`, `footer_text` and
`sign_off_threshold_cents`. Upload itself is the existing `POST /v1/files` with
`purpose=quote_logo`; no new upload route.

### Tests — `test/quote-branding-logo.test.ts`

- Upload a `quote_logo`, set it, then the rendered quote document **and** the
  public page carry `<img src="/files/{id}">`.
- No logo → the document renders with the company name only, and no `<img>`.
- The public page's logo is fetchable unauthenticated, while a `claim_receipt`
  file id 404s on the same `/files/:id` route — the C3 criterion, tested as
  "the public page does not expose the tenant's other files".
- A `logo_file_id` from another tenant → 422 at settings time.
- Footer text and accent colour appear in the rendered document.
- A 3 MB logo → 413 from the existing per-purpose policy (already true; pinned
  here because PRD-004 states the constraint).

---

## Phase E — Internal sign-off + the inbox card (P1)

### Service

`sendQuote` consults `quote_branding.sign_off_threshold_cents`:

- Below threshold, or NULL → `draft` → `sent`, unchanged behaviour.
- At or above → `requestApproval({ subject_type: "quote", subject_id })` (the
  enum value and the `role_based` strategy — `admin`/`finance` — **already
  exist** in `src/modules/approvals/resolver.ts`), then `draft` →
  `pending_approval`, storing `sign_off_approval_id`. Resolution runs before the
  status moves, so a tenant with no eligible approver keeps an editable draft
  rather than a wedged quote — the shape S5 established.
- `pending_approval` cannot transition to `sent` by any other path, and cannot
  be edited (Phase A's rule already covers it: only `draft` is editable).

### Decision effect — `src/modules/quotes/decision.ts` (new)

Registered in `SUBJECT_DECISION_EFFECTS` under `quote`. Approve → statements
moving the quote to `sent` and stamping `sent_at`, plus a `quote.sent.v1` event;
reject → back to `draft` with `sign_off_comment`. Runs in the same `db.batch()`
as the approvals UPDATE, so there is no window where an approval is granted and
the quote is not sent.

Import direction, per the rule in `decision-effects.ts`: this file imports only
`../approvals/types` and `../../schemas/envelope`, never `../approvals/service`
and never `./service` (which does import the approvals service). Its two queries
are written inline for that reason.

### Console — the `quote` renderer for S4's registry

- `ui/src/features/approvals/renderers/QuoteApprovalCard.tsx` — customer, quote
  number, grand total, validity/expiry, the line breakdown and the discount
  total, per the S9 brief.
- One line in `renderers/registry.ts` (`quote: QuoteApprovalCard`).
- `ui/src/lib/subjectRoutes.ts` **already has** `quote: /quotes/:id`, so no
  change there — but `subjectRoutes.test.ts` and `registry.test.tsx` both pin
  the expected sets and the registry assertion moves to three types.
- **`quote` was the last card-less subject type.** Any shell test using it as a
  card-less stand-in moves to `other` (SESSION-PLAN flags this explicitly).
- `QuoteDetail.tsx` gains the link/acceptance panel: mint, copy, revoke, viewed
  and accepted state, and a link to the archived artifact.

### Tests

`test/quote-sign-off.test.ts`:

- Below threshold → `send` goes straight to `sent`, no approval row.
- At/above → `pending_approval`, an `approvals` row with
  `subject_type = quote` resolved to an admin/finance user, and
  `approval.requested` in `events_log` (which is what notifies the approver).
- A second `send` while pending → 409.
- Minting a public link while pending → 409.
- Approve → quote is `sent`, `sent_at` stamped, `quote.sent` emitted, and the
  public link can then be minted and accepted.
- Reject with a comment → `draft`, `sign_off_comment` stored, quote editable again.
- No eligible approver → 422 and the quote stays `draft`.

`ui/src/features/approvals/renderers/QuoteApprovalCard.test.tsx` (jsdom;
`fireEvent`, not `user-event`, which is not a dependency), plus the two pinned
assertions above. Run with `cd ui && npm test` — root `npm test` does not.

---

## Files touched (summary)

**New:** `migrations/0028_quote_signing.sql`,
`src/modules/quotes/{links,acceptance,agreement,decision}.ts`,
`src/modules/quotes/document/public-page.ts`,
`src/gateway/routes/public-quotes.ts`,
`src/schemas/events/quote.viewed.v1.ts`,
`ui/src/features/approvals/renderers/QuoteApprovalCard.tsx`,
five Workers test files + one console test file.

**Changed:** `src/modules/quotes/{service,settings,branding,types}.ts`,
`src/modules/quotes/document/render.ts`, `src/gateway/routes/{quotes,settings,files}.ts`,
`src/modules/files/policy.ts`, `src/modules/approvals/decision-effects.ts`,
`src/schemas/events/{registry,quote.accepted.v1,quote.rejected.v1}.ts`,
`src/index.ts` (one `app.route("/q", …)`), `src/env.ts` (none needed — `SESSIONS`
and `FILES` already exist), the console quote detail page and the two pinned
console tests.

**No new bindings**, so `wrangler.jsonc` / `wrangler.free.jsonc` are untouched
and the test pool sees everything it needs.

---

## Docs to update in the closing commit

- `docs/modules/quotes.md` — **new**; the module has no doc today.
- `docs/modules/files.md` — the two policy changes and the HTML disposition rule.
- `docs/modules/approvals.md` — `quote` as the second registered decision effect.
- `docs/prd/SESSION-PLAN.md` — S9 status → **done**, the migration-number
  footnote for S10, the `quote.viewed.v1` row, and the renderer-registry line
  (`quote` is no longer the card-less stand-in).
- `docs/built-features-inventory.md` — the signing surface.

---

## Baselines

Measured on this branch at `e512072` before any change:

- typecheck: clean both sides
- Workers suite: **58 files / 1087 tests**, all passing → **63 / 1159** at close
- console (`cd ui && npm test`): **18 files / 172 tests** → **19 / 181** at close

Both are above the SESSION-PLAN floor (54 / 1015 and 15 / 142), which went stale
between S8 and now exactly as standing rule 4 predicts.

Standing rule 4 applies to the closing push: `npm run typecheck && npm test`
green, plus `cd ui && npm test` for Phase E.

**Known flake, per standing rule 4:** `test/files.test.ts > rejects a 12 MB
upload with 413` fails intermittently under full-suite load. Re-run the file
alone before treating it as a regression.

---

## Out of scope (PRD-004 says so)

PDF generation, quote versioning **UI** (the data model lands in Phase A; the
history screen is P1), customer reminders for unviewed quotes, signing applied
to invoices or a generic contract entity, multi-party counter-signing, certified
DSA-1997 signatures, payment-on-acceptance.

**Not a build blocker but a customer blocker:** PRD-004's legal open question.
The agreement text ships as a versioned constant with an explicit
"confirm with a Malaysian lawyer before relying on this" note in the file and in
`docs/modules/quotes.md`.

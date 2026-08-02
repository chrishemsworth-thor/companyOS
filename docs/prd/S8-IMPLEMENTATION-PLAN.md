# S8 — PRD-003 CRM Depth: Implementation Plan

**Session:** S8 · **PRD:** [003](PRD-003-crm-depth.md) ·
**Branch:** `claude/contact-roles-crm-depth-hlgw1f` ·
**Migration number:** `0027` (highest on `main` is `0026_leave_requests.sql`)

Read [`SESSION-PLAN.md` § C7](SESSION-PLAN.md#c7--prd-003-changes-a-finance-write-path)
first: `payment_terms_days` changes invoice due-date computation, so this session
touches the finance write path.

---

## Phase order and the stop point

PRD-003's own guidance is *"do roles first, ship it, then decide whether
attributes and health are still the right next thing."*

| Phase | Scope | Commit |
|---|---|---|
| **A** | Contact roles + resolution + `customer.no_contact.v1` + console roles | own commit, pushed |
| **B** | Commercial attributes + `payment_terms_days` → invoice due dates (C7) | own commit, pushed |
| **C** | Derived health + console badge/reasons panel | own commit, pushed |

**A is the must-land phase.** If the session runs long the stop point is after
A (or after B), reported rather than rushed. C is never half-shipped: a health
band with wrong reasons is worse than no band.

---

## Blocking decision — `at_risk` behaviour

PRD-003 asks whether `at_risk` **auto-pauses outbound sales activity** or
**only surfaces as a signal**. SESSION-PLAN recommends signal-only in v1.

**Plan: signal only.** Health is a read-model computed on request; nothing
consults it before a send. Three reasons to record rather than re-open later:

1. The inputs are unvalidated. Nobody has calibrated the bands against real
   Malaysian SME payment behaviour, and a mis-tuned band that silences
   collections costs a tenant money silently.
2. It would collide with S10. PRD-002 puts the kill switch (`agents.enabled`,
   per-customer `agent_paused`) in the guardrail layer, enforced in code after
   the LLM returns. A second, derived pause in the CRM read model means two
   places can stop a send and neither is authoritative.
3. It is additive later — `agent_paused` already exists as the seam.

Health output does carry a machine-readable `band`, so S10 can consume it as a
guardrail *input* without S8 pre-empting that design.

---

## Phase A — Contact roles (must land)

### D1: `0027_crm_depth.sql`, section (a)

```sql
CREATE TABLE contact_roles (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id),
  contact_id TEXT NOT NULL,
  role       TEXT NOT NULL,     -- validated by Zod in the service, not a CHECK
  PRIMARY KEY (tenant_id, contact_id, role),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts(tenant_id, contact_id)
);
CREATE INDEX idx_contact_roles_role ON contact_roles (tenant_id, role, contact_id);
```

- **No SQL `CHECK` on `role`.** Same reasoning S3 recorded for
  `approvals.subject_type`: `0022`'s migration comment documents that a CHECK
  rebuild on a table with dependent FKs and append-only triggers is effectively
  unavailable. The vocabulary is closed by `contactRoleSchema` in the service.
- A join table rather than a CSV/JSON column on `contacts` because
  `resolveContact` is an indexed lookup by role, and the PRD requires
  many-to-many in both directions (a contact holds several roles; a customer has
  several contacts per role).

**`is_primary` enforcement**

```sql
CREATE UNIQUE INDEX idx_contacts_one_primary
  ON contacts (tenant_id, customer_id) WHERE is_primary = 1;
```

PRD-003 says *"clears the previous primary atomically (or 409 — pick one and
test it)."* **Picking clear-atomically**, last-write-wins, in a single
`db.batch()`. The partial unique index is the backstop, not the mechanism —
SQLite checks uniqueness per statement, so clear-then-set inside one batch is
legal.

**Backfill** — order matters, roles first, then the flag derived from roles, so
neither statement reads a value the other has already destroyed:

```sql
INSERT INTO contact_roles (tenant_id, contact_id, role)
SELECT tenant_id, contact_id, CASE WHEN rn = 1 THEN 'primary' ELSE 'other' END
FROM (
  SELECT tenant_id, contact_id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, customer_id
           ORDER BY is_primary DESC, created_at, contact_id
         ) AS rn
  FROM contacts
);

UPDATE contacts SET is_primary = CASE WHEN EXISTS (
  SELECT 1 FROM contact_roles r
   WHERE r.tenant_id = contacts.tenant_id
     AND r.contact_id = contacts.contact_id
     AND r.role = 'primary') THEN 1 ELSE 0 END;
```

**One deliberate divergence from the brief's letter.** The brief says *"earliest
by `created_at`"* unconditionally; the `ORDER BY` puts `is_primary DESC` first,
so a customer who already has an explicitly-flagged primary keeps it and only
customers with none (or with several, which is possible today — nothing enforces
it) fall back to earliest-by-`created_at`. Honouring a flag somebody set on
purpose is closer to *"a safe default, not a guess at intent"* than overwriting
it. `contact_id` is the ULID tiebreak so the result is deterministic when
`created_at` collides.

**Audit column:** `ALTER TABLE deliveries ADD COLUMN contact_id TEXT;` — nullable,
so which contact a reminder actually addressed is recorded on the audit row
rather than inferred from `to_address`.

### Service — `src/modules/crm/contact-roles.ts` (new) + `service.ts`

- `contactRoleSchema = z.enum(["primary","billing","technical","signatory","other"])`.
- **Invariant: `is_primary = 1` ⟺ the contact holds the `primary` role.** The
  PRD specifies both a flag and a role meaning the same thing; the service
  normalises in both directions so `{is_primary: true}` and
  `{roles: ["primary"]}` cannot disagree.
- `createContact` / `updateContact` take `roles?: ContactRole[]` and write
  roles + the primary swap in one `db.batch()`.
- **Default roles on create:** `["primary"]` when the customer has no contacts
  yet, `["other"]` otherwise — the same rule the backfill applies, so a migrated
  tenant and a fresh one behave identically.
- `resolveContact(db, tenantId, customerId, role)` →
  `{ contact, matched: "role" | "primary" | "any" } | null`.
  Fallback chain **requested role → primary → any** (any = oldest by
  `created_at`). Returns *how* it matched, because AC2 requires the fallback be
  recorded on the decision.
- `listContacts` returns `roles: string[]` per contact — one extra query for the
  whole customer, grouped in JS, not N+1.

### Endpoints

| Method | Path | Change |
|---|---|---|
| `GET` | `/v1/customers/:id/contacts` | each contact gains `roles: string[]` (additive) |
| `POST` | `/v1/customers/:id/contacts` | accepts `roles` |
| `PATCH` | `/v1/customers/:id/contacts/:contactId` | accepts `roles` |
| `GET` | `/v1/customers/:id/contacts/resolve?role=billing` | **new** — `{ contact, matched }`, or `{ contact: null }` with 200 for zero contacts |

The resolve route exists so the helper is assertable over HTTP and so S9's quote
signing has a signatory lookup that is not a private import.

### Delivery wiring — `src/delivery/dispatch.ts`

`sendReminder` currently reads `customers.email/phone`. New order:

1. `resolveContact(customer_id, "billing")` → that contact's email/phone.
2. Fall back to `customers.email/phone` (today's behaviour) when there are no
   contacts or the resolved contact has no address on the needed channel.
3. Existing cross-channel fallback (email ↔ whatsapp) unchanged.
4. Nothing resolvable → emit `customer.no_contact.v1`, then throw
   `DeliveryError("no_recipient")` exactly as today.

**Deviation worth stating.** The acceptance criterion reads *"fails gracefully
with a `customer.no_contact` event rather than throwing."* Removing the throw
would make `POST /v1/invoices/:id/reminder` return success for a send that never
happened, and the CollectionsAgent already treats `DeliveryError` as a graceful
non-send (it logs, keeps tracking, and does not record a contact). So the plan
adds the event and keeps the typed error: graceful in the sense that matters —
no unhandled exception, an observable event, and an honest 422 at the API.
`test/delivery.test.ts`'s existing `no_recipient` assertion stays green as a
consequence.

**Recording the fallback (AC2):** `collections.decision` payload gains optional
`contact_id` and `contact_match` fields. `collectionsDecisionV1` is a
non-strict `z.object`, so optional additions are non-breaking — no v2. Noted for
S10, which is already planning `collections.decision.v2`.

### Event to register

| File | Wire type | Payload |
|---|---|---|
| `src/schemas/events/customer.no_contact.v1.ts` | `customer.no_contact` | `customer_id`, `invoice_id` (nullable), `channel_requested`, `reason` |

Registry entry in `src/schemas/events/registry.ts`. `source_module: "finance"`,
matching `customer.risk_flagged`, which is emitted from the same path.
**No `NOTIFICATION_MAP` entry** — the consumer must not query D1 to find a
recipient (free-plan inline path), and there is no user id on the payload to
notify. It is an operational signal for `events_log` and the agent feed.

### Console

- `ui/src/components/modals/ContactFormModal.tsx` — role checkbox group;
  the existing "primary" control stays and is kept in sync with the `primary`
  role.
- `ui/src/pages/crm/CustomerDetail.tsx` — a Roles column of badges on the
  contacts table.
- `ui/src/api/types.ts` — `Contact.roles: string[]`.

### Tests — Workers runtime

`test/contact-roles.test.ts`

| AC | Test |
|---|---|
| billing contact addressed on reminder | seed billing + other contacts → `POST reminder` → `deliveries.to_address` is the billing contact's email and `deliveries.contact_id` is its id |
| no billing → falls back to primary, fallback recorded | reminder addresses the primary; `collections.decision` payload carries `contact_match: "primary"` |
| second `is_primary` clears the first atomically | `PATCH` contact B primary → A is `is_primary = 0` and no longer holds the `primary` role; one row per customer survives |
| zero contacts → `customer.no_contact`, no throw | capturing bus asserts the event; the route returns 422 `no_recipient`; the agent path logs and continues |

Plus: resolve chain over all four outcomes (role → primary → any → null); roles
round-trip through create and patch; unknown role → 400; tenant B cannot resolve
tenant A's contacts (404, not 403).

`test/migration-contact-roles.test.ts` — follows the
`test/migration-roles-drop-check.test.ts` precedent: pre-migration rows with
zero, one and several `is_primary` flags all land on exactly one `primary`.

`ui/`: `ContactFormModal.test.tsx` for the role selector ↔ primary sync.

---

## Phase B — Commercial attributes (touches finance, C7)

### D1: `0027_crm_depth.sql`, section (b)

```sql
ALTER TABLE customers ADD COLUMN industry           TEXT;
ALTER TABLE customers ADD COLUMN website            TEXT;
ALTER TABLE customers ADD COLUMN payment_terms_days INTEGER;
ALTER TABLE customers ADD COLUMN credit_limit_cents INTEGER;
ALTER TABLE customers ADD COLUMN preferred_channel  TEXT;   -- email | whatsapp
ALTER TABLE customers ADD COLUMN notes              TEXT;
ALTER TABLE customers ADD COLUMN ship_address_line1 TEXT;
ALTER TABLE customers ADD COLUMN ship_address_line2 TEXT;
ALTER TABLE customers ADD COLUMN ship_city          TEXT;
ALTER TABLE customers ADD COLUMN ship_state         TEXT;
ALTER TABLE customers ADD COLUMN ship_postcode      TEXT;
ALTER TABLE customers ADD COLUMN ship_country       TEXT;

ALTER TABLE company_profile ADD COLUMN default_payment_terms_days INTEGER NOT NULL DEFAULT 30;
```

**`registration_no` and `tax_id` are not added.** `0013_quotes.sql` already
shipped `customers.reg_no` (SSM) and `customers.tax_no` (SST), and the quote "To"
block renders them. Adding PRD-003's names beside them would create two columns
for one fact. The existing structured billing address (`address_line1 … country`,
also from `0013`) is likewise reused; `ship_*` is the genuinely new half.

### Finance write path — the C7 change

- `CreateInvoiceInput.due_date` becomes **optional**.
- New `resolveDueDate(db, tenantId, customerId, issueDate)`:
  `customers.payment_terms_days` → `company_profile.default_payment_terms_days`
  → `30`.
- `POST /v1/invoices` — `due_date` becomes `.optional()` in the Zod body.
- `convertQuote` — only the hardcoded tail changes:
  `opts.due_date ?? quote.expiry_date ?? addDays(issue_date, resolvedTerms)`.
  The explicit and expiry-date branches keep precedence, so `test/quotes.test.ts`
  is untouched.

Every existing caller passes an explicit `due_date`, so behaviour is unchanged
for all of them by construction. **Regression net that must pass unmodified:**
`test/finance-lifecycle.test.ts`, `test/finance-service.test.ts`,
`test/finance-ledger.test.ts`, `test/ledger-entries.test.ts`,
`test/ledger-dimensions.test.ts`, `test/quotes.test.ts`, `test/delivery.test.ts`.

### Credit limit — warn only, never block

`GET /v1/customers/:id` exposes `credit_limit_cents` and `outstanding_ar_cents`
(the latter comes free from the Phase C health query — no extra round trip).
`InvoiceCreateModal` warns when `outstanding + new total > limit`. No server-side
rejection anywhere; the API creates the invoice regardless.

### Endpoints

`POST` / `PATCH /v1/customers` accept the new fields; `GET /v1/customers/:id` and
the list projection return them.

### Tests — `test/customer-attributes.test.ts`

| AC | Test |
|---|---|
| 45-day terms → due = issue + 45 | create customer with `payment_terms_days: 45`, `POST /v1/invoices` with no `due_date` |
| — | no customer terms → tenant `default_payment_terms_days`; neither set → 30 |
| — | explicit `due_date` still wins over both |
| credit limit → console warns, does not block | response carries limit + outstanding AR and the invoice is still created 201 |
| structured addresses used by rendered documents | quote/invoice render asserts billing address; `ship_*` round-trips |

---

## Phase C — Customer health (derived, signal only)

### `src/modules/crm/health.ts` — no migration

Computed on read. **One additional query** on the customer detail endpoint, which
is an acceptance criterion, so it is a single `SELECT` of scalar subqueries over
`invoices`, `tickets`, `activities`, `deals` and `payment_applications` — not one
query per input.

Inputs → reasons → band:

- overdue invoice count, max days overdue, total overdue cents
- DSO vs the customer's own `payment_terms_days` (Phase B)
- open ticket count and oldest open ticket age
- last activity recency
- open deal value

`{ band: "good" | "watch" | "at_risk", reasons: [{ code, detail }] }`. Reasons are
the product — `"2 invoices 60+ days overdue"`, not a number. No history at all →
`good` with an explicit `insufficient_history` reason.

Exposed on `GET /v1/customers/:id` and added to the CollectionsAgent's
`assembleContext`. **Nothing reads the band to decide whether to send.**

### Console

- `CustomerList` — health badge column.
- `CustomerDetail` — a reasons panel under the header.

### Tests — `test/customer-health.test.ts`

| AC | Test |
|---|---|
| two invoices 60+ days overdue → `at_risk`, both named | reasons contain both invoice ids |
| pays on time, no tickets → `good` | |
| new customer, no history → `good` + `insufficient_history` | asserts the reason code, not just the band |
| no more than one additional query | `env.DB.prepare` wrapped in a counting spy; `computeHealth` must call it exactly once |

---

## Docs to update in the closing commit

- **`docs/modules/crm.md`** (new) — roles and the resolve chain, the
  `is_primary` ⟺ `primary` invariant, due-date resolution order, health bands
  and the signal-only decision.
- **`docs/prd/SESSION-PLAN.md`** — S8 status → done; a "Shipped (S8, `0027`)"
  block under the S8 brief; `customer.no_contact.v1` marked done in the events
  table; the `at_risk` row struck through in Blocking decisions with the answer;
  next migration number noted as `0028`; re-measured baselines.

## Baselines

Measured on this branch before any change, and re-measured before the closing
push (standing rule 4).

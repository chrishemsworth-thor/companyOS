# Leave

Leave policy, entitlement, public holidays and balances (PRD-006b, S6).
`source_module: people`.

**In scope:** leave types, entitlement policies with tenure bands and three
accrual methods, per-employee assignment and overrides, Malaysian public
holidays with state variation and tenant overrides, configurable work weeks,
working-day counting, and derived balances with carry-forward.

**Out of scope, shipping with PRD-006c (S7):** leave *requests* — submission,
approval routing, cancellation, the team calendar, the `leave.*` events, and the
approvals-inbox renderer. There is no console UI for leave configuration yet
either; S7 builds the leave screens.

## The two decisions that shape this module

### 1. Public holidays ship as a data file, and the table holds only deltas

The SESSION-PLAN blocking decision for S6 was *"shipped data file — state
variation makes manual seeding per tenant an annual support burden."* The
implementation goes one step further than the decision required: the shipped
calendar is **never written to the database**.

```
effective holidays = shipped(year, scope) ∪ tenant additions − tenant suppressions
```

`public_holidays` rows are the tenant's deltas and nothing else. `observed = 1`
adds or renames a holiday, `observed = 0` suppresses a shipped one, and the
merge happens at read time in `holidays/resolve.ts`.

The alternative — copying the shipped rows into every tenant on first use, the
way `ensureSystemAccounts` seeds the chart of accounts — was rejected for two
reasons. It would make each year's update a backfill across every tenant rather
than a deploy; and once a tenant had edited a shipped row in place, "did we ship
it that way, or did they change it?" would have no answer.

Everything is keyed on **date + scope**, never date alone. A Selangor employee
and a Sarawak employee can have a holiday on the same date for different
reasons, and suppressing one must not remove the other.

### 2. Employment Act minimums warn, they never block

PRD-006: *"Employment Act minimums are a seed default and a warning, not an
enforced floor — a tenant may have contractual terms above minimum and the
system must not fight them."*

No CHECK constraint, no service-side rejection, nothing in the route layer can
refuse an entitlement for being below the statutory minimum. A policy write
returns **201/200 with the policy saved as entered**, plus a `warnings` array:

```jsonc
POST /v1/people/leave/policies
{ "leave_type_id": "lvt_…", "name": "Probation", "bands": [{ "entitlement_days": 5 }] }

201 {
  "policy": { …, "bands": [{ "entitlement_days": 5, … }] },
  "warnings": [{
    "code": "below_statutory_minimum",
    "basis": "annual",
    "entitlement_days": 5,
    "statutory_minimum_days": 8,
    "message": "5 days for all employment types at 0-24 months' service is below the
                Employment Act 1955 minimum of 8 days. Saved as entered — this is a
                warning, not a limit."
  }]
}
```

Below-minimum terms are legitimate in practice (probation bands, roles outside
the Act, non-EA contracts), so an enforced floor would be wrong even before the
PRD's instruction. The tables the warnings come from are served at
`GET /v1/people/leave/statutory-minimums` so a console can show the minimum next
to the field.

## Data model (`migrations/0025_leave_policy.sql`)

| Table | Purpose | Key columns |
|---|---|---|
| `leave_settings` | one row per tenant | `work_week` (JSON, 7 fractions), `defaults_seeded_at` |
| `leave_types` | what kinds of leave exist | `leave_type_id` (`lvt_`), `code` (unique per tenant), `is_paid`, `requires_attachment`, `max_consecutive_days`, `allows_half_day`, `carry_forward_allowed`, `allow_negative_balance`, `statutory_basis`, `archived_at` |
| `leave_policies` | how much, accrued how | `policy_id` (`lvp_`), `leave_type_id`, `accrual_method`, `carry_forward_max_days`, `carry_forward_expiry_months`, `is_default` |
| `leave_policy_bands` | entitlement by type + tenure | `band_id` (`lvb_`), `employment_type` (NULL = any), `min_months_service`, `max_months_service`, `entitlement_days` |
| `employee_leave_profiles` | leave-side employee attributes | `work_state`, `work_week` (override) |
| `employee_leave_assignments` | employee → policy, per leave type | `policy_id`, `entitlement_days_override` |
| `public_holidays` | **tenant deltas only** | `holiday_date`, `name`, `scope`, `observed` |
| `leave_balance_adjustments` | carry-forward + corrections | `leave_year`, `days`, `kind` (`carry_forward`/`adjustment`/`encashment`) |
| `leave_requests` | created here, **written by S7** | balance-relevant columns only — see below |

Design notes worth knowing before changing anything:

- **Carry-forward lives on the policy, not the type.** PRD-006 lists it under
  leave types; in practice the cap moves with the entitlement. So the type
  carries `carry_forward_allowed` (is this kind of leave carryable at all —
  annual yes, sick no) and the policy carries the cap and the expiry window.
- **Work week is 7 fractions, index 0 = Sunday**, not a bitmask: `1` = full
  working day, `0.5` = half day, `0` = non-working. A bitmask cannot express the
  Saturday half-day PRD-006 asks for, and Kelantan/Terengganu's Sun–Thu week is
  just a different array. Tenant default, optionally overridden per employee —
  one tenant genuinely can have a KL head office on Mon–Fri and a Kota Bharu
  branch on Sun–Thu.
- **`work_state` is on a leave-owned table, not on `employees`.** It keeps leave
  concerns in the leave module, and it meant S6 added no column to a table the
  concurrently-built S5 branch also reads.
- **No hard deletes** for types and policies (`archived_at`), per the
  system-wide convention. Holiday overrides *are* really deleted, because
  removing one restores the shipped calendar — it is configuration, not history.
- **`leave_settings.defaults_seeded_at` makes the seed run once.** A tenant that
  archives a leave type it does not offer does not find it back tomorrow.

### The `leave_requests` handoff to S7

S6 creates the table and owns **no** write path for it: no routes, no events, no
state machine. It exists in this migration because two of S6's own acceptance
criteria are about it — a pending request must reduce the available balance, a
rejected one must restore it — and a balance defined as
`entitlement − taken − pending` cannot be built or tested without the thing
being consumed.

The columns present are the balance-relevant ones only: `employee_id`,
`leave_type_id`, `start_date`, `end_date`, `start_half_day`, `end_half_day`,
`working_days`, `state`. **S7 adds `reason`, `attachment_file_id`, the approval
linkage and the `leave.*` events additively**, and owns the state machine. S6's
tests insert rows directly through `env.DB`.

`working_days` is stored, not recomputed, so a later holiday correction cannot
silently restate a request somebody already approved.

## Balances

```
available = entitlement + carried-forward + adjustments − taken − pending
```

Nothing is stored. A balance is recomputed on every read from the policy, the
employee's dates and their requests, so there is no counter to drift out of step
with reality. Four properties are load-bearing, and each has a test in
`test/leave-balances.test.ts`:

- **Pending counts.** A submitted-but-undecided request reduces the available
  balance immediately, or employees over-book against days they already asked for.
- **Rejection restores**, and it falls out of the design rather than needing its
  own code path: only `pending` and `approved` rows are summed.
- **Carried days are consumed first**, so an expiry rule lapses the leftovers
  instead of eating this year's entitlement.
- **A year-spanning request is charged to each year separately** — a
  28 December–5 January break is not four days of one year's balance and two of
  nothing.

Two conventions stop a balance moving on a day when nothing happened:

- The **tenure band is evaluated at the end of the leave period**, not at the
  moment of the query. Someone crossing two years' service in August is on the
  12-day band for the whole of that year rather than watching their entitlement
  jump mid-year.
- **Pro-rating counts whole calendar months, joining and leaving month
  inclusive**, rounded to the nearest half day. A 1 July joiner on 14 days gets
  14 × 6/12 = 7, which is PRD-006's own acceptance criterion.

### Accrual methods

| Method | Period | Behaviour |
|---|---|---|
| `annual_upfront` | calendar year | Granted in full at the start, pro-rated for a partial year |
| `monthly_accrual` | calendar year | `entitlement/12` per completed month, so it grows through the year |
| `on_anniversary` | the employee's own year, starting at their start date | Granted in full at each anniversary; no pro-rating, because the period starts there |

The **leave year is the calendar year** for the first two — which is how
Malaysian companies refresh annual entitlement. There is no fiscal-year leave
cycle; add one only when a design partner needs it.

### Carry-forward and the year close

`POST /v1/people/leave/year-close` computes what each employee carries into the
next year and writes it as a `carry_forward` adjustment row.

Carry-forward is the one part of a balance that *cannot* be recomputed later —
it depends on the cap as it stood at close — which is why it is written down
rather than derived. The write is `INSERT OR IGNORE` against a **partial unique
index** on `(tenant_id, employee_id, leave_type_id, leave_year) WHERE kind =
'carry_forward'`, so running the close twice is a no-op rather than
double-crediting everybody; the response reports `written: false` for a
(employee, type) pair that was already closed. `dry_run: true` previews.

Unused days are measured **after** pending requests, so days already asked for
are not carried and then spent twice. Only types with `carry_forward_allowed`
and a policy cap above zero produce a row.

`carry_forward_expiry_months` (3 = "use it by 31 March", the common Malaysian
setting; NULL = never lapses) retires the *unused* portion of the carried days
at the cutoff. Because carried days are spent first, an employee who used three
of five carried days in February keeps those three and lapses two, with this
year's entitlement untouched.

Admin-only: it writes irreversible rows for every employee at once, so the route
is held to `admin:write` above the router's `people:write` gate.

## Public holidays

The shipped calendar is `src/modules/leave/holidays/data.ts`, currently 2025,
2026 and 2027. States are ISO 3166-2:MY alpha codes in `holidays/states.ts` — a
code registry in TypeScript, like `src/departments/registry.ts`, because the
list is fixed by geography rather than by tenant.

### Accuracy, and what to do about it

Fixed-date holidays are certain. Islamic dates depend on moon sighting and
Chinese and Hindu dates on the lunar calendar, so a future year is a projection
until the gazettes confirm it. Each year therefore carries `provisional`, and
**the API surfaces it** (`holiday_data_provisional`, `source_note`) — an office
manager should be told which numbers are still soft rather than finding out in
April.

A year we have not shipped at all returns `holiday_data_available: false`
rather than an empty holiday list that reads as "no holidays this year". Day
counting still works for such a year, with the flag set: erroring would make
leave unbookable, and silently counting would over-deduct.

**Known gaps in the shipped dataset**, all fixable by a tenant override without
waiting for a release:

- **Perak and Kelantan ruler birthdays are omitted** rather than guessed. The
  other fourteen states' ruler/governor birthdays are included.
- **Substitution days are not modelled** — a holiday falling on a Sunday being
  observed on the Monday is gazetted per state per year.
- Hospitalisation leave is modelled as its own 60-day type. The Act frames it as
  an aggregate *including* outpatient sick leave; CompanyOS separates them
  because that is how Malaysian SMEs administer it, and because one combined
  bucket cannot express "medical certificate required for hospitalisation but
  not for one day off sick".

### Adding a year

Append a `HolidayYear` to `MY_PUBLIC_HOLIDAYS`, set `provisional` honestly, and
run `npm test`. `test/leave-holidays.test.ts` checks the structure — dates
inside their own year, valid scopes, no duplicate date+name pairs, the five
compulsory national holidays present. It cannot check that the dates are
*right*; only the gazette can do that.

No migration, no backfill, no per-tenant action. Tenant overrides survive
untouched because they are stored separately.

## Seeded Malaysian defaults

Seeded per tenant, once, on the first read of types or policies —
`annual`, `sick`, `hospitalisation`, `maternity`, `paternity`, `compassionate`,
`unpaid`. All editable, none hardcoded; nothing downstream keys off them.
`code` exists so the seed is idempotent, and `statutory_basis` — not `code` —
is what drives the warning, so a tenant renaming "Sick" to "Medical Leave"
keeps it.

Entitlements are the Employment Act 1955 minimums as amended in 2022: annual
8/12/16 days by under-2 / 2–5 / 5+ years of service, sick 14/18/22,
hospitalisation 60, maternity 98, paternity 7. The annual default ships a
5-day carry-forward cap expiring after 3 months, which is the common SME
setting. Compassionate (3 days) and unpaid have no statutory basis and never
warn; unpaid is the one type with `allow_negative_balance`.

> These are a **starting point for tenants to edit, not compliance guidance**.
> PRD-006's own open questions ask for the post-2022 figures to be confirmed
> with HR/legal before they are relied on.

## API

Gated by the mount table in `src/index.ts`. Two surfaces, on two different
capability axes:

**HR administration — `/v1/people/leave/*`, `people:read` / `people:write`.**
Same bar as the employee directory: `finance`, `support` and the self-service
`employee` tier get a 403, because entitlements and policy are HR data.

| Method | Path | Notes |
|---|---|---|
| GET, PUT | `/settings` | tenant work week |
| GET, POST, PATCH | `/types`, `/types/:id` | `?include_archived=true` |
| GET, POST, PATCH | `/policies`, `/policies/:id` | bands nested; response carries `warnings` |
| GET | `/statutory-minimums` | the Employment Act tables |
| GET, PUT | `/employee-profiles?employee_id=` | work state, work-week override |
| GET, PUT | `/assignments?employee_id=` | employee → policy |
| GET | `/states` | state list + shipped years |
| GET, POST, DELETE | `/holidays`, `/holidays/:id` | POST upserts an addition or a suppression |
| GET | `/balances?employee_id=&as_of=&leave_type_id=` | |
| GET | `/working-days?employee_id=&start=&end=&start_half_day=&end_half_day=` | |
| POST | `/adjustments` | manual correction or encashment |
| POST | `/year-close` | **`admin:write`**; `dry_run` supported |

**Employee self-service — `/v1/me/leave/*`, on the `self` axis.** Every role
holds `self`, so the `employee` tier — refused everywhere else under `/v1` —
reads its own balance without any business access. Ownership is resolved from
the session, so there is no id to tamper with.

`GET /v1/me/leave/balances` · `/types` · `/holidays?year=` ·
`/working-days?start=&end=`

`LeaveError` maps to 400 (`invalid_request`), 404 (`not_found`), 409
(`code_taken`, `archived`) and 422 (`invalid_work_week`, `invalid_employee`,
`invalid_leave_type`, `invalid_policy`).

## Tests

| File | Covers |
|---|---|
| `test/leave-policy.test.ts` | seeded defaults and seed-once, type/policy CRUD, **statutory warnings that never block**, default-policy uniqueness, work-week validation, capability gating |
| `test/leave-holidays.test.ts` | shipped-dataset integrity, the three holiday acceptance criteria, tenant additions/suppressions/renames, tenant isolation, unshipped and provisional years, self-service holidays |
| `test/leave-balances.test.ts` | the five entitlement acceptance criteria, all three accrual methods, band selection, overrides, year-spanning requests, carry-forward cap/expiry/idempotency, self-service balance |

Every statutory test asserts **both** that the warning appears and that the
value saved as entered — a test that only checked for the warning would pass
against an implementation that rejected the write.

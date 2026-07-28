# PRD-008 — Roles, Permissions & Employee Self-Service

**Status:** Not started · **Priority:** P0 (security gap + blocks PRD-006 self-service)
**Depends on:** none to start; must be designed against PRD-000 (approvals) and
PRD-006 (leave & claims) so it serves both

---

## Problem Statement

Platform roles are currently **labels, not constraints**. `requireRole`
(`src/gateway/middleware/session.ts:80`) is applied to only four surfaces:

- `src/gateway/routes/users.ts:27` — whole router, `admin`
- `src/gateway/routes/people.ts:32` — writes, `admin|operator`
- `src/gateway/routes/people.ts:35` — employee invite, `admin`
- `src/gateway/routes/settings.ts:83` — onboarding complete, `admin`

**Every other business route has no role gating at all** — invoices, payments,
ledger, quotes, customers, deals, leads, tickets, projects, issues, insights,
events. Any authenticated user of any role can read *and write* all of it.
Concretely: a user with role `readonly` can issue invoices, record payments, and
close deals. `readonly` does not mean readonly.

This became urgent when the "Invite to platform" action landed on employee records
(`POST /v1/people/employees/:id/invite`) with a role selector. Admins now pick a
role that grants exactly the same access as every other role, so the control is
misleading until enforcement is real.

A tenant-API-key caller becomes a `system` actor and **bypasses all role checks**
by design (`src/gateway/middleware/session.ts:83`) — trusted root for agents.
Preserve this unless there is an explicit argument otherwise.

## Why this is being designed rather than patched

A full HRMS is on the roadmap (PRD-006). Enforcing today's five roles would harden
the wrong model, because those five conflate two orthogonal axes:

1. **Business capability** — which module operations you may perform (finance,
   support, sales, admin).
2. **Self-service identity** — you are staff, and may see and act on *your own*
   records (profile, leave balance, claims), regardless of business capability.

PRD-006 requires axis 2 for every employee: *"An employee can request leave and see
their balance without asking HR."* But axis 2 must **not** be `readonly`, which once
enforced means "read all business data" — salaries, customer contracts, deal values.
A minimal self-service tier has to exist as its own concept.

There is a second interaction to design deliberately: **leave and claim approvals
route through the employee graph (manager), while quote and invoice approvals route
through user roles** (PRD-000: pluggable strategy per `subject_type`; default is the
employee's manager via People reporting lines, fallback any `admin`; quote/invoice is
role-based `admin`/`finance`; self-approval blocked unless `admin`). Both must work,
and they meet at a person who needs a login to act. Decide how `employees.user_id`,
the manager chain, and roles compose.

## Goals

1. A role means something: every business route enforces capability, and the negative
   cases are proven by tests.
2. An employee can be given self-service access without gaining access to business
   data.
3. The model serves PRD-000 approvals and PRD-006 leave/claims without rework.
4. Adding or changing a role later does not require a D1 migration.
5. No existing user silently gains or loses access during the migration.

## Non-Goals

- Payroll, statutory submissions (rejected elsewhere as a moat).
- Per-record ACLs or sharing rules. Tenant + role + ownership is the granularity.
- SSO / passkeys / SCIM provisioning.
- Rebuilding the department lens; reconcile with it (see below), don't replace it.

## Decisions required

Propose, then confirm with the user — do not settle these silently.

1. **Vocabulary vs. model.** Flat role list, or an access **tier** plus module
   **scopes** (e.g. `operator` + `["finance","crm"]`)? Consider a
   permission/capability matrix checked by a helper rather than role lists sprinkled
   per route.
2. **The self-service tier.** Name it, and define exactly what it reaches — likely own
   employee record, own leave/claims, org directory, nothing else.
3. **Should every employee become a user?** Product instinct is that eventually they
   largely should. Decide whether the self-service tier is auto-provisioned on employee
   creation or stays today's explicit invite, and how invite volume and dormant
   accounts are handled if auto.
4. **Keep or drop the DB `CHECK` constraint on `users.role`** (see constraints).
5. **Migration path for the existing five roles** — mapped with no loss of access and
   no silent privilege escalation.
6. **Enforcement mechanism** — per-route `requireRole` lists, or a declarative
   capability map. Prefer whatever makes "this route is unprotected" impossible to
   miss: a route added later with no gate should fail loudly or default to deny.

## Constraints and gotchas (verified 2026-07-28)

- **`users.role` has `CHECK (role IN (...))`** at
  `migrations/0010_users_sessions.sql:16-17`. SQLite cannot alter a CHECK in place, so
  any vocabulary change needs a **full table rebuild**. `users(user_id)` is
  FK-referenced from five places — `sessions`, `google_accounts` (`user_id` *and*
  `connected_by_user_id`), `employees`, `user_tokens` — so the rebuild needs the
  `PRAGMA defer_foreign_keys` pattern under D1. **Recommendation: use this one
  unavoidable rebuild to drop the CHECK entirely** and let `src/auth/roles.ts` be the
  single source of truth (it already is for the app — Zod schemas use `z.enum(ROLES)`).
  Pay once; never migrate for a role change again. Rebuild precedents:
  `migrations/0016_delivery_google.sql`, `migrations/0019_transactional_email.sql`.
- **Migration head is `0020_ledger_dimensions.sql`.** Never edit an applied migration.
- **Five consumers of the role vocabulary** — all must stay in parity:
  1. `src/auth/roles.ts` — canonical, dependency-free leaf.
  2. The DB CHECK constraint (above).
  3. `src/departments/registry.ts` — already maps departments → which roles may see
     them (`roles: Role[]`, ~line 46). **This is an existing role→visibility mapping
     for navigation.** Reconcile it with real route enforcement rather than leaving two
     parallel systems.
  4. `ui/src/components/modals/UserFormModal.tsx:10` — the list is **duplicated as a
     literal** in the frontend rather than imported. Worth fixing.
  5. `test/departments.test.ts:65` — asserts every registry role exists in `ROLES`.
- **Derived user status.** `invited` is not stored; it is computed from a NULL
  `pwd_hash` in `PUBLIC_COLUMNS` (`src/auth/users.ts`). Don't break it.
- **Employee ≠ user.** `employees.user_id` is an optional link;
  `POST /v1/people/employees/:id/invite` (admin only) creates + links + invites via the
  shared service `src/auth/invites.ts`. See `docs/modules/people.md`.
- **`docs/prd/SESSION-PLAN.md:350`** currently states *"**Do not add roles** without a
  decision."* This PRD is that decision — update that line as part of the work.

## Process

1. **Plan first.** Read PRD-000 (approvals, ~lines 90–120), PRD-006, PRD-007,
   `docs/architecture/department-lens.md`, and `docs/modules/people.md`. Then write the
   design: the model, the permission matrix per module and route, the self-service tier,
   the employee↔user↔approver interaction, the migration, and rollout order. Confirm the
   six decisions above before implementing.
2. **Stage the implementation** so each step is independently green and reviewable —
   e.g. vocabulary + migration → enforcement helper → apply per module → self-service
   tier → UI (role pickers, nav gating, 403 states).
3. Call out anything that changes existing users' effective access **before** doing it.

## Acceptance criteria

- [ ] Every `/v1/*` business route has an explicit capability requirement, and a route
      with none either fails closed or fails a test.
- [ ] Given a `readonly` user, when they attempt any write, then 403 — proven per module.
- [ ] Given a self-service user, when they read business data (invoices, customers,
      deals, ledger), then 403; when they read their own employee record, then 200.
- [ ] Given a tenant-API-key (system) caller, when they call any route, then role checks
      are bypassed as before.
- [ ] Given each of the five pre-migration roles, when the migration runs, then their
      effective access matches the documented mapping — no silent escalation.
- [ ] Adding a role requires changing `src/auth/roles.ts` (and the UI list) only — no
      migration.
- [ ] Approver resolution works for both strategies: manager-chain (leave/claims) and
      role-based (quote/invoice), including the no-manager → admin fallback.

## Verification

- `npm test` (330 tests pass as of this PRD — keep green; add cases per new rule) and
  `npm run typecheck`.
- `cd ui && npm run typecheck && npm run build && npm test` (18 tests).
- Tests must cover **negative** paths per role and module: the point is proving a
  `readonly` user cannot write and a self-service user cannot read business data. Mirror
  the auth patterns in `test/people.test.ts` and `test/auth-session.test.ts` (seeded
  tenant, `login()` helper, Origin header, CSRF on writes; per-test isolated storage,
  migrations auto-applied by `test/setup.ts`).
- Update `docs/prd/SESSION-PLAN.md:350`, `docs/operator-ui.md` (lists per-route
  business-role gating as not built), and `docs/modules/people.md` (carries a caveat
  saying roles aren't enforced — remove once they are).
- Suggested branch: `claude/roles-and-permissions`.

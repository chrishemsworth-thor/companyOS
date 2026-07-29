# CompanyOS — Roles, Capabilities & Enforcement

*Last updated: 2026-07-29 · Status: **implemented** (PRD-008)*

How access control works: a **capability matrix** mapping roles to
`<module>:<action>` pairs, enforced for every `/v1` route by the mount table
rather than by per-route guards a new route could forget.

Source: `src/auth/roles.ts`, `src/auth/capabilities.ts`,
`src/gateway/middleware/capability.ts`, the `V1_MOUNTS` table in
`src/index.ts`, `src/gateway/routes/me.ts`,
`src/modules/approvals/resolver.ts`. UI: `ui/src/lib/roles.ts`,
`ui/src/components/CanWrite.tsx`. Tests: `test/capabilities.test.ts`,
`test/approver-resolution.test.ts`. Migration: `0022_roles_drop_check.sql`.

---

## 1. The problem this replaced

Roles used to be labels. `requireRole` was applied to four surfaces — the whole
of `/v1/users`, People writes, the employee invite, and onboarding-complete —
and **every other business route had no gating at all**. A `readonly` user could
issue invoices, record payments and close deals. The role selector on "Invite to
platform" offered five options that granted identical access.

## 2. Two axes in one vocabulary

The six roles encode two orthogonal things deliberately:

| Axis | Roles | Means |
|---|---|---|
| Business capability | `admin`, `operator`, `finance`, `support`, `readonly` | which module operations you may perform |
| Self-service identity | `employee` | you are staff, and may act on **your own** records only |

`employee` exists because PRD-006 needs "an employee can request leave and see
their balance without asking HR", and that must **not** be `readonly` — which,
now that it is enforced, means "read *all* business data": every salary-adjacent
HR field, customer contract and deal value.

The `self` capability is held by **every** role, including `readonly`. Being
staff is not a business capability, so an observer who is also an employee still
files their own leave request.

## 3. The matrix — `src/auth/capabilities.ts`

A capability is `<module>:<action>`; actions are `read` (safe methods) and
`write` (POST/PATCH/PUT/DELETE).

| Module | Covers |
|---|---|
| `finance` | invoices, payments, ledger |
| `crm` | customers, deals, leads, activities, quotes |
| `support` | tickets |
| `build` | projects, issues |
| `insights` | cross-module read models |
| `people` | employee directory, teams |
| `agents` | the event log / agent activity feed |
| `files` | uploads and tenant-scoped reads |
| `settings` | company profile, quote branding |
| `admin` | logins, integration credentials, webhook secrets, onboarding completion |
| `meta` | `GET /v1/meta/departments` (self-filtering discovery) |
| `self` | your own records — the identity axis |

Effective grants:

| Role | Reads | Writes |
|---|---|---|
| `admin` | everything | everything |
| `operator` | every business module | every business module (not `admin`) |
| `finance` | `finance`, `crm`, `insights`, `settings`, `files` | `finance`, `files` |
| `support` | `support`, `crm`, `settings`, `files` | `support` |
| `readonly` | every business module | **nothing** |
| `employee` | `meta` | — |
| *(all roles)* | `self` | `self` |

Two edges are deliberate: `finance` and `support` read `crm` because you cannot
invoice or support a customer you cannot see, and neither can read `people` —
the directory carries employment terms and HR notes, and no finance or support
workflow needs it (issue and ticket assignees are free text, not employee
references).

## 4. Enforcement — the mount table, not per-route guards

PRD-008's requirement was that "this route is unprotected" must be impossible to
miss. So the gate is not something a route opts into:

```ts
// src/index.ts
export const V1_MOUNTS = [
  ["/v1/invoices", "finance", invoices],
  ["/v1/customers", "crm", customers],
  …
]
for (const [path, module, router] of V1_MOUNTS) app.route(path, guardModule(module, router));
```

- `guardModule(module, router)` wraps the router in a fresh Hono app whose
  middleware is registered **before** the route handlers — Hono composes in
  registration order, so `router.use("*", …)` added after the handlers would run
  too late to stop a write.
- The required capability is derived from the HTTP method, so **a route added to
  an existing router is gated the moment it exists**. There is no per-route step.
- A *new* router cannot reach `/v1` without a row in the table, and a row cannot
  be written without naming a module — the type demands it.
- `requireCapability(cap)` is used only to **raise** the bar on a single route:
  the employee invite and onboarding-complete require `admin:write` inside
  otherwise-broader routers.
- `test/capabilities.test.ts` walks `app.routes` and fails if any registered
  `/v1` path is not covered by the table. `/v1/auth` is the one exemption: it is
  the pre-authentication login surface, mounted before `authenticate()`.

A denied request returns `403 {error, code: "forbidden", required: "<module>:<action>"}`.

### System callers still bypass everything

A tenant-API-key caller resolves to a `system` actor and bypasses the matrix, as
before — trusted root credentials for agents. This is preserved by design
(PRD-008 § Problem Statement), and asserted by tests that make calls no single
human role could make.

## 5. The self-service surface — `/v1/me`

`GET /v1/me/employee` returns the caller's own employee record, resolving
ownership from the **session**, not a path parameter — there is no id to tamper
with. HR's `notes` field is withheld: it is commentary *about* the person, not a
field for them. A login with no linked employee record gets 404 (`not_linked`);
an API-key caller gets 400 (`not_a_user`), since it has no self.

PRD-006's leave balance and claim history hang off this router, which is why the
`employee` tier needs no business capability at all.

## 6. Navigation is derived, not declared twice

`src/departments/registry.ts` used to carry `roles: Role[]` per department — a
second, parallel role→visibility mapping alongside route enforcement.
`departmentsForRole()` now derives visibility from the matrix: a department is
visible when the role can read **every** module it surfaces, so the console
cannot offer a department whose pages would 403. `planned` departments that
surface no module yet (Legal, Operations) are shown to roles that can read the
whole business, since an empty list is otherwise vacuously readable.

The console mirrors the module lists (for icons and instant paint) and imports
`can()`/`canReadAll()` from the server leaves directly — `roles.ts` and
`capabilities.ts` are dependency-free, so the browser bundle can use them and
the vocabulary cannot drift. `ui/src/lib/departments.test.ts` asserts the module
lists match the server registry.

`<CanWrite module="crm">` hides create/edit actions a role cannot use, and a 403
renders as *"Not available on your role"* rather than an error. Both are
presentation only — the server enforces the same matrix on the request.

## 7. Role changes take effect immediately

A session carries the role it was minted with (KV hot copy, 7-day TTL). Once
that role decides access, a demotion that only applies at expiry is a hole, so
`PATCH /v1/users/:id` revokes the target's sessions when it changes `role` or
disables the account — the same reasoning as the password-reset path.

## 8. Adding or changing a role

1. Add it to `ROLES` in `src/auth/roles.ts`.
2. Grant it capabilities in `MATRIX` in `src/auth/capabilities.ts`.
3. Add a one-line description to `ROLE_SUMMARY` in `ui/src/lib/roles.ts`.

**No migration.** Migration 0022 rebuilt `users` to drop
`CHECK (role IN (...))` — the constraint that made every vocabulary change a
table rebuild — and the rebuild used `PRAGMA defer_foreign_keys` because
`users(user_id)` is referenced from `sessions`, `google_accounts` (twice),
`employees` and `user_tokens`. Zod validates writes with `z.enum(ROLES)`, so the
application remains the source of truth.

## 9. Migration mapping (what changed for existing logins)

No role was renamed or re-granted; the five existing values map 1:1. What
changed is that the matrix is now *enforced*:

| Role | Before | After |
|---|---|---|
| `admin` | everything | unchanged |
| `operator` | everything | everything except `admin` surfaces (already gated) |
| `finance` | full read **and write** on every module | `finance` + `files` write; `crm`/`insights`/`settings` read; no People, support or build |
| `support` | full read **and write** on every module | `support` write; `crm`/`settings`/`files` read; no finance, People or build |
| `readonly` | full read **and write** on every module | read-only, as the name always claimed |
| `employee` | *(did not exist)* | own records only |

Two further behaviour changes worth knowing:

- **Invite default.** `createUser` (and so the employee invite) defaults to
  `employee`, not `operator`. A default invite no longer grants business access.
- **Navigation.** `finance` and `support` now also see the Sales department,
  because they legitimately read customers. It is read-only: its write actions
  are hidden by capability.

## 10. Approver resolution — `src/modules/approvals/resolver.ts`

PRD-000 routes approvals through two different graphs, and both had to be
designed against this model. `resolveApprover(db, tenantId, {subject_type,
requested_by_user_id})` implements the strategy per subject type:

| Subject | Strategy |
|---|---|
| `leave_request`, `expense_claim` | `manager_chain` — climb `employees.manager_employee_id` to the first manager who is still employed **and** has an enabled login |
| `quote`, `invoice` | `role_based` — `finance` first, then `admin` |

Fallbacks and rules:

- No manager, no login anywhere up the chain, or no employee record at all →
  `admin_fallback`, preferring an admin who is not the requester.
- Self-approval is blocked (PRD-000) — the resolver routes past the requester —
  **except** for the sole admin of a one-person company, where the alternative
  is an approval nobody can ever decide.
- Returns `null` when the tenant has nobody eligible. Callers must treat that as
  "cannot route", never as auto-approved.
- A manager with no login cannot approve: the chain climbs past them, so a whole
  team is not blocked by one un-invited manager. This is the practical reason
  `employees.user_id` and the role model have to compose.

The `approvals` table itself is PRD-000's work; this resolver lands first so the
role model is proven against both strategies.

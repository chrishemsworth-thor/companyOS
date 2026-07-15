# CompanyOS — Departments as a Lens over Modules

*Last updated: 2026-07-15 · Status: **implemented***

How CompanyOS models the **org chart** (the departments a company has) without
fracturing the one-normalized-database design. Departments are a *lens* over the
existing capability modules, not a second copy of them.

Source: `src/departments/registry.ts`, `src/auth/roles.ts`,
`src/gateway/routes/meta.ts`, `ui/src/lib/departments.ts`,
`ui/src/components/Layout.tsx`, `ui/src/pages/Departments.tsx`. Tests:
`test/departments.test.ts`, `ui/src/lib/departments.test.ts`,
`ui/src/components/Layout.test.tsx`. **No schema change.**

---

## 1. The problem: departments ≠ data domains

The capability modules (`src/modules/*`) are organized by *what data exists* —
finance, crm, support, build. A company's **departments** are organized by *who
consumes* the data, and the two do not line up 1:1:

- **Sales** and **Customer Experience** both read the **customer** record.
- **Management** is a cross-module overview, not a data domain of its own.
- **Data & AI** is about agent activity (the DO runtime), which spans modules.

Mapping departments 1:1 onto modules would duplicate data into per-department
silos and break the "one normalized database" thesis. So a department instead
*declares which modules it surfaces* — a view concern layered over the data,
carrying no storage of its own.

## 2. The registry — `src/departments/registry.ts`

The canonical, machine-readable taxonomy. Each `Department` declares:

| Field | Meaning |
|---|---|
| `id`, `label`, `summary` | Identity + human description |
| `status` | `live` (backed by a shipped module, working console tools) or `planned` (part of the org model, not yet built — shown disabled so the taxonomy and build order stay visible) |
| `modules` | Which capability modules it reads from (`finance` \| `crm` \| `support` \| `build` \| `insights` \| `agents`) |
| `roles` | Which human roles may see it |
| `tools` | Console routes it exposes (empty for `planned`) |

**11 departments — 6 live, 5 planned:**

| Department | Status | Modules | Tools |
|---|---|---|---|
| Finance | live | finance | Invoices, Ledger |
| Sales & Business Development | live | crm | Customers, Deals |
| Customer Experience | live | support, crm | Tickets |
| Technology / Engineering | live | build | Projects, Issues |
| Data & AI | live | agents, insights | Agent activity |
| Management | live | insights | Dashboard |
| Product | planned | build | — |
| R&D / Innovation | planned | build | — |
| People | planned | — | — |
| Legal | planned | — | — |
| Operations | planned | — | — |

**`departmentsForRole(role?)`** is the one access function:
- no role (a `system`/agent caller) → **all** departments;
- an unknown role → **`[]`** (fails closed rather than leaking the full list);
- a known role → departments whose `roles` include it.

`BROAD = [admin, operator, readonly]` see every business department. `finance`
additionally maps to **Finance + Management**; `support` maps to **Customer
Experience**. This is why an API key sees 11, an admin/operator/readonly sees
11, a finance user sees 2, and a support user sees 1.

## 3. Roles extracted to a dependency-free leaf — `src/auth/roles.ts`

The registry (and the UI parity test) need the role vocabulary but must not drag
in credential/crypto code. `ROLES`/`Role` were extracted into
`src/auth/roles.ts`, a leaf with no imports; `src/auth/users.ts` re-exports them
so existing callers are unaffected.

## 4. Discovery endpoint — `GET /v1/meta/departments`

Serves the taxonomy so **agents can discover the org structure** the same way
the console renders it. Mounted under `/v1/*`, so it requires authentication
(no auth → 401). Filtering is by caller:

- a **human session** carries a `user` actor with a `role` → the list is scoped
  to that role via `departmentsForRole(role)`;
- a **programmatic/agent caller** (tenant API key → `system` actor, no role) →
  the **full** list.

The actor is set by the shared `authenticate()` middleware (see
[`phase-1-native.md`](phase-1-native.md) and `src/gateway/middleware/session.ts`).

## 5. Operator console

The console mirrors the server registry in `ui/src/lib/departments.ts`. The
**only** thing the UI adds is **icons** — a pure view concern the API has no
business carrying. Consumers:

- **Sidebar (`Layout.tsx`)** — regrouped by department (generalizing the old
  `adminOnly` filter): an *Overview* group, one group per **live** department
  showing its tools, a *Planned* group rendering disabled "Soon" items, and an
  *Admin* group for admins. It is driven off `departmentsForRole(user?.role)`,
  so the sidebar is itself role-filtered.
- **`/departments` overview page (`Departments.tsx`)** — lists every department
  with status + summary.

### Parity is enforced, not hoped for

The UI mirror can drift from the server registry. Two guards prevent it:

- `ui/src/lib/departments.test.ts` — asserts the UI department ids match the
  server's canonical id list.
- `ui/src/components/Layout.test.tsx` — mounts the authenticated shell and
  asserts the dashboard + department sidebar actually render (a render-time
  crash fails the suite instead of blanking the browser after login).

## 6. Why a lens, and how departments graduate

A `planned` department is a visible placeholder in the org model. It becomes
`live` by **building the underlying data module** and flipping its `status` —
not by inventing a new silo. The intended build order is
**People → Legal → Operations** (the three departments with no backing module
today); Product and R&D are `planned` but already grouped over `build`.

This ties directly to the yardstick in [`../direction.md`](../direction.md): a
department is "fully in CompanyOS" when it has a normalized data model, an event
stream, and an agent acting on it. The lens makes the *whole* org visible today
while keeping the honest distinction between what's shipped and what's mapped
but not yet built.

## 7. Scope

- **No schema change** — the registry is code, not data; net-new data modules
  (People, Legal, Operations) are a later iteration.
- **Role-filtering is visibility, not authorization** — the endpoint scopes what
  a role *sees*; per-route write authorization stays with `requireRole(...)` on
  the business routes (e.g. `/v1/users`).

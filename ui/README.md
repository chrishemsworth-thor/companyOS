# CompanyOS Operator Console

An operator UI over the CompanyOS `/v1/*` API: a dashboard, list/detail
views, and write actions for invoices (create/send/reminder/record
payment), ledger journal entries, customers (create/edit), deals
(create/stage move), activities, tickets (create/reply/status),
projects, and issues (create/status). It also surfaces the collections
agent: an **Agent activity** feed at `/agent`, a per-customer agent
snapshot card, and invoice-scoped event timelines. Scoped in
[`../docs/operator-ui.md`](../docs/operator-ui.md); auth is still the
single-operator slice from that plan (paste an API key, kept only in
the browser tab's session storage).

## Run it

```sh
npm install
npm run dev
```

Opens on `http://localhost:5173`. It talks to the CompanyOS Worker over
`/v1/*` — have `npm run dev` running in the repo root first (defaults to
`http://localhost:8787`), and a seeded tenant:

```sh
# in the repo root
npm run dev
npm run seed:local   # prints a tenant API key
npm run seed:sample -- --api-key <printed_api_key>   # optional: populate sample data
```

Paste the printed API key into the console's login screen (the base URL
field defaults to `http://localhost:8787`, override it if your Worker runs
elsewhere). `seed:sample` gives you something to look at immediately —
customers, invoices in different states (including one flipped to
`overdue`), deals, tickets, and a project with issues — instead of
starting from an empty dashboard.

## Notes

- Auth is intentionally minimal (tenant API key, session-only storage) —
  this is option 1 from the operator-ui scoping doc, appropriate for a
  single trusted operator. Don't point this at a production tenant's key
  from a shared machine.
- No pagination yet: list views fetch full result sets, matching the
  API's current behavior (documented as a known gap in the scoping doc).
- Data layer: TanStack Query. Mutations invalidate the affected query
  keys rather than patching caches, except deal-stage and issue-status
  moves, which apply optimistically and roll back on error. Invoice and
  payment creation send an `Idempotency-Key` so retries can't
  double-issue or double-charge.

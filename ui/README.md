# CompanyOS Operator Console

A read-only operator UI over the CompanyOS `/v1/*` API: a dashboard plus
list/detail views for invoices, the ledger, customers, deals, tickets,
projects, and issues. Scoped in [`../docs/operator-ui.md`](../docs/operator-ui.md);
this is the MVP slice from that plan — read-only, single-operator auth
(paste an API key, kept only in the browser tab's session storage).

No write actions (create/send/pay/status-change) yet — see the scoping doc
for what's deliberately deferred and why.

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
- Data layer: TanStack Query, no caching tricks beyond its defaults.

# CompanyOS Test Plan

Scope: everything built through Phase 2 (native Finance/CRM/Support/Build
modules, event bus + agent routing, `CollectionsAgent` with LLM-driven
decisions, real delivery providers, gateway auth). Goal is to (1) inventory
what the existing automated suite already proves, (2) close the gaps with
concrete new test cases, and (3) give a manual/exploratory pass for the
things automated tests can't reach (real provider wiring, cron in
production, load).

## 1. Current automated coverage (baseline)

`npm test` → 11 files, 82 tests, all green, run in the real Workers runtime
via `@cloudflare/vitest-pool-workers` (per-file isolated D1, migrations
auto-applied).

| File | Covers |
|---|---|
| `finance-ledger.test.ts` | Ledger invariants: balance enforcement, batch atomicity, append-only triggers, reversals, global sum-to-zero |
| `finance-service.test.ts` | Invoice/payment lifecycle, AR/Revenue + Cash/AR postings, partial payment, overpayment/mismatch rejection |
| `finance-lifecycle.test.ts` | Vertical slice: create → send → sweep → consumer → agent → payment reset |
| `crm.test.ts` | Customer CRUD, payment-history join, pipeline seeding idempotency, deal won-settlement, activity log |
| `support.test.ts` | Ticket CRUD, exhaustive state-machine matrix (model + HTTP) |
| `build.test.ts` | Project/issue CRUD, settled-status reopen rule, log-only queue path |
| `collections-agent.test.ts` | LLM-driven decisions, fallback path, rate limiting |
| `delivery.test.ts` | DeliveryProvider port (console/Resend/Twilio) |
| `llm.test.ts` | LLM provider abstraction (Anthropic/OpenAI) |
| `envelope.test.ts` | Event envelope + registry validation |
| `gateway.test.ts` | Auth middleware, routing basics |

This is solid line coverage per module in isolation. The gaps below are
mostly: cross-module interaction edge cases, negative/adversarial input,
auth/tenant-isolation depth, idempotency/concurrency, and anything that
only shows up over HTTP or across real infra boundaries.

## 2. Gap analysis → new test cases to add

### 2.1 Auth & tenant isolation (`gateway.test.ts`, currently thin)
- [ ] Missing `Authorization` header → 401 on every `/v1/*` route family (loop all route groups, not just one).
- [ ] Malformed header (`Authorization: Basic ...`, `Authorization: Bearer` with no token) → 401.
- [ ] Revoked/unknown API key → 401.
- [ ] KV cache hit path returns the same tenant as the D1 path (seed KV directly, confirm no double D1 read).
- [ ] **Tenant isolation**: create two tenants, create an invoice/customer/ticket/issue under tenant A, fetch it with tenant B's key → 404, not leaked data. Do this for every module (finance, CRM, support, build) since each uses composite `(tenant_id, id)` PKs — a single missing `WHERE tenant_id = ?` would be a cross-tenant data leak.
- [ ] `/health` requires no auth; `/v1/*` always does, including sub-resources like `/v1/invoices/:id/send`.
- [ ] Unknown route → 404 JSON `{error:"not found"}`; unhandled throw → 500 JSON, not a stack trace leak.

### 2.2 Finance
- [ ] `POST /v1/invoices` with empty `lines` array → 422.
- [ ] `POST /v1/invoices` with `unit_cents <= 0` or non-integer/float cents → 422 (confirm Zod schema actually rejects, not just app logic).
- [ ] `POST /v1/invoices` for a `customer_id` in a different tenant → 404, not silently posting.
- [ ] Double-send: `POST /v1/invoices/:id/send` twice → second call 409, ledger not double-posted.
- [ ] `recordPayment` where `applications` sum ≠ `amount_cents` → 422 `amount_mismatch`, zero rows written.
- [ ] `recordPayment` where a single application exceeds an invoice's `amount_due_cents` → 422 `overpayment`, verify no partial write (atomicity).
- [ ] `recordPayment` across invoices in different currencies / different customer → 422 `currency_mismatch` / `customer_mismatch`.
- [ ] Multi-invoice single payment: applications split across 2+ invoices in one call, verify each invoice's `amount_due_cents` decremented independently and `payment.received`/`payment.partial` emitted per invoice as documented.
- [ ] `POST /v1/ledger/entries` unbalanced (lines don't sum to 0) → 422, nothing written; balanced but single-line → 422 `too_few_lines`.
- [ ] `POST /v1/ledger/entries` referencing an `account_id` from another tenant → rejected (`unknown_account`), not cross-tenant posting.
- [ ] Reverse an already-reversed entry / reverse a reversal → decide and pin expected behavior (currently undocumented — verify code path, likely allowed as another reversal; write a test either way so behavior is locked).
- [ ] Overdue sweep: invoice exactly on `due_date` (boundary, not yet overdue) vs. one day past → confirm boundary condition (`>` vs `>=`).
- [ ] Overdue sweep re-run same day → idempotent status (`overdue` invoices stay `overdue`, not re-transitioned), but `invoice.overdue` still re-emitted each run per spec — assert event count grows, status doesn't flap.
- [ ] Cancelled/paid invoices are excluded from the sweep (only `sent` → `overdue` transitions; already-`overdue` invoices are picked up for re-emission but not `paid`/`cancelled`).
- [ ] `POST /v1/invoices/:id/reminder` with a customer that has neither email nor phone → 422 `no_recipient`.
- [ ] `POST /v1/invoices/:id/reminder` when the configured provider throws → 502 `send_failed`, and confirm the failure is NOT silently swallowed into a fake success.
- [ ] `GET /v1/ledger/accounts/:id/balance` for an account with zero postings → `{balance_cents: 0}`, not an error.
- [ ] Idempotent chart seeding: call any finance endpoint twice for a brand-new tenant, confirm `ensureSystemAccounts` doesn't create duplicate `1000`/`1100`/etc. rows (unique constraint holds).

### 2.3 CRM
- [ ] `POST /v1/deals` with a `stage_id` belonging to another tenant → 422/404, not accepted.
- [ ] `POST /v1/deals/:id/stage` moving from a `is_won`/`is_lost` stage back to an open stage — confirm whether `status` flips back to `open` (spec says "any other stage keeps/returns it to open") and pin it with a test; also check whether `deal.won` fires again if moved won→lost→won (re-entrancy).
- [ ] `logActivity` with `deal_id` referencing a deal on a different customer than `customer_id` — should this be rejected? Decide and test (currently likely unchecked — flag as a potential validation gap, see §4).
- [ ] `GET /v1/customers/:id/payment-history` for a customer with invoices but zero payments → empty array, not error.
- [ ] Default pipeline stage ordering (`sort_order`) is respected in `GET /v1/deals/stages` and omitting `stage_id` on deal creation lands in the lowest `sort_order`, not just "first row returned."

### 2.4 Support
- [ ] `POST /v1/tickets` with `body` omitted → ticket created with zero opening messages (not a null-body message row).
- [ ] `addMessage` with `author` outside the enum (`customer|agent|system`) → 422.
- [ ] Full transition matrix already exhaustively tested — extend it to also assert the emitted event(s) match spec per transition (e.g., only `resolved` stamps `resolved_at` and fires `ticket.resolved` in addition to `ticket.status_changed`; all other legal transitions fire only `ticket.status_changed`).
- [ ] Ticket for unknown `customer_id` — currently unclear if support validates customer existence like CRM/finance do; write a test to pin actual behavior (accept-or-reject) since it's a candidate gap (see §4).

### 2.5 Build
- [ ] `POST /v1/issues` for a `project_id` in another tenant → 404.
- [ ] Status no-op move (`todo` → `todo`) returns the issue unchanged without emitting `issue.status_changed` (spec says "no-op moves return the issue unchanged" — confirm no spurious event on the bus).
- [ ] `done` → `todo` and `cancelled` → `todo` both legal; `done` → `cancelled` or `cancelled` → `done` → 409 (adjacent-settled-state moves).
- [ ] `GET /v1/issues?project_id=&status=` combined filter returns the intersection, not the union.

### 2.6 Event bus / queue consumer
- [ ] Envelope with a payload that fails registry validation → `message.retry()` called, not acked, and nothing written to `events_log` (partial-failure safety).
- [ ] Duplicate `event_id` delivered twice (at-least-once semantics) → `INSERT OR IGNORE` dedupes in `events_log`, and — importantly — routed agent logic is itself idempotent or rate-limited so a duplicate delivery doesn't double-send a reminder (cross-check against the `collections-agent.test.ts` rate-limit test, but from the consumer's replay angle specifically).
- [ ] Event type with no `AGENT_ROUTES` entry (deal.*, ticket.*, issue.*, project.*) → acked, appended to `events_log`, and provably **no** DO `.fetch`/stub call happens (currently proven only for `issue.completed` in `build.test.ts`; extend to at least one CRM and one support event type for symmetry).
- [ ] Event with `AGENT_ROUTES` entry but payload missing `customer_id` → throws and retries (per code, `routeToAgent` throws before calling the stub) — add an explicit test since this is a real production failure mode if a future event type is routed without a customer.
- [ ] Full DLQ path: after N retries a message lands in the dead-letter queue (this may need a wrangler-level/integration test rather than vitest-pool-workers, since DLQ redelivery counts are infra-managed — flag for manual/staging verification, see §3).

### 2.7 CollectionsAgent (Durable Object)
- [ ] `alarm()` re-check path: schedule an alarm, advance simulated time, confirm the agent re-assesses risk without a new inbound event (existing tests focus on `onEvent`; alarm-driven re-checks look untested).
- [ ] Concurrent events for the same tenant+customer (two `invoice.overdue` events in quick succession) — DO single-threading should serialize them; confirm no lost update on the risk-score/stage state.
- [ ] LLM provider returns a valid-shaped but semantically nonsensical response (e.g., `action: "escalate"` with `risk_score: 0`) — confirm the agent trusts the schema and doesn't add hidden secondary validation that silently overrides it (or does, and that's intentional — pin whichever is true).
- [ ] LLM call times out / network error (not just malformed output) → falls back to heuristic, same as the schema-invalid case already tested.
- [ ] Reminder send fails (delivery provider throws) inside the agent — confirm the `collections.decision` audit event is still emitted even though delivery failed, so there's no silent gap in the audit trail.
- [ ] Full escalation → payment → reset cycle run twice in a row (state doesn't get "stuck" escalated after a second full overdue→pay cycle).

### 2.8 Delivery providers
- [ ] Resend: non-2xx response body (rate limit, invalid API key) surfaces as a typed failure, not an unhandled exception; confirm retry/error message shape matches what the finance route's `send_failed` (502) expects.
- [ ] Twilio: same negative-path coverage (auth failure, invalid `to` number format).
- [ ] Channel fallback: customer has phone but no email, request `channel: "email"` → falls back to whatsapp per README ("if the requested channel has no address the other channel is used") — confirm this is actually implemented and tested, not just documented.
- [ ] Every send attempt (success and failure) is logged in the `deliveries` table — add a test asserting a failed send still leaves an audit row.
- [ ] Tenant with `delivery_config.enabled = 0` — reminders fall back to console/no-op rather than erroring.

### 2.9 LLM provider abstraction
- [ ] Both `LLM_PROVIDER=anthropic` and `=openai` selectable via env, and provider auto-selection when only one API key is configured.
- [ ] `LLM_MODEL` override actually reaches the outbound request (not just accepted and ignored).
- [ ] No API key configured at all → agent uses the deterministic fallback from turn one, no attempted network call (avoid pointless outbound calls that fail predictably).

### 2.10 Cross-cutting / non-functional
- [ ] **Money handling**: no floating point anywhere on the money path — grep test assertions to confirm all cents fields are asserted as integers, and add a fuzz-style test with odd unit prices (e.g., `unit_cents: 333`, `quantity: 3`) to confirm no rounding drift.
- [ ] **Input validation depth**: every POST body schema should reject additional/unexpected fields or wrong types with 422, not 500 — sweep all routes with a quick fuzz (wrong types on each field) rather than relying on the happy-path Zod tests alone.
- [ ] **Idempotency of migrations**: `wrangler d1 migrations apply` twice against a already-migrated DB is a no-op (should already be true structurally, but worth a CI check).
- [ ] **Trace propagation**: `trace_id` on an envelope flows end-to-end (created in the service layer → visible in `events_log` → visible in the agent's log line) for at least one full-slice test — useful for debugging in prod.

## 3. Manual / exploratory test pass (things automated tests can't reach)

Run against `wrangler dev` + `npm run seed:local`:

1. **Vertical slice by hand** — follow the README's curl sequence exactly:
   create invoice → send → force the cron (`wrangler dev --test-scheduled` or manually invoke `runOverdueSweep`) → confirm console delivery log line → pay → confirm agent state resets. Watch actual timing/log output, not just assertions.
2. **Real provider smoke test** (requires test Resend/Twilio credentials, not production ones): configure `RESEND_API_KEY` + a `delivery_config` row, trigger a reminder, confirm a real email arrives in a test inbox. Same for Twilio WhatsApp sandbox.
3. **Real LLM smoke test**: configure `ANTHROPIC_API_KEY`, trigger an overdue event, read the actual composed reminder message for tone/quality (this is inherently non-deterministic — eyeball a handful of samples rather than asserting exact text).
4. **Cron trigger in a deployed environment**: after `wrangler deploy`, confirm the daily cron actually fires at 01:00 UTC (check Cloudflare dashboard cron logs) rather than trusting the local `now`-injection tests alone.
5. **DLQ inspection**: deliberately publish a malformed event (e.g. via a temporary debug route or wrangler queue producer CLI) and confirm it lands in `companyos-events-dlq` after retries, and that ops has a way to inspect/replay it.
6. **KV propagation on key rotation**: rotate a tenant's API key, confirm the old key keeps working for up to `TENANT_CACHE_TTL_SECONDS` (60s) and then starts failing — validates the documented cache-staleness tradeoff is what actually happens.
7. **Load/concurrency smoke**: fire ~50 concurrent `POST /v1/invoices` for the same tenant and confirm no D1 write contention errors, no ledger imbalance under load (sum-to-zero check after the burst).
8. **Security pass**: run `/security-review` (or equivalent) over the auth middleware and gateway routes — confirm API keys are only ever compared by hash, never logged in plaintext anywhere (`console.error` lines, error responses).

## 4. Behavioral gaps to clarify with the team (not pure test gaps)

These surfaced while mapping test cases — they're places where the *intended*
behavior isn't fully pinned by docs or code, so a test can't be written until
someone decides what "correct" means:

1. Does `logActivity` validate that `deal_id` belongs to the given `customer_id`? (§2.3)
2. Does ticket creation validate that `customer_id` exists (like finance/CRM do), or is it accepted freely? (§2.4)
3. Reversing an already-reversed ledger entry — allowed (chain of reversals) or blocked? (§2.2)
4. Re-entering a won/lost stage after leaving it — does `deal.won`/`deal.lost` fire again? (§2.3)

Recommend resolving these first since the answer determines the actual test
assertion, not just whether a test exists.

## 5. Suggested execution order

1. Auth/tenant-isolation tests (§2.1) — highest severity if broken (data leak across tenants), cheapest to add given `gateway.test.ts` is already thin.
2. Finance negative-path + atomicity tests (§2.2) — money correctness is the highest-consequence area.
3. Queue consumer failure-mode tests (§2.6) — protects every future module that plugs into the bus.
4. CollectionsAgent alarm/concurrency tests (§2.7) — DO state bugs are the hardest to debug in prod.
5. Remaining module gap-fill (§2.3–2.5) and delivery/LLM negative paths (§2.8–2.9).
6. Manual pass (§3) before/around each deploy, not just once.

## 6. Tooling notes

- All new tests should follow existing conventions: `@cloudflare/vitest-pool-workers`, per-file isolated D1 via auto-applied migrations, helper patterns already in `test/setup.ts` and the per-module test files.
- Prefer extending existing `describe` blocks in the files listed in §1 over creating many new files, to keep per-module coverage discoverable in one place — except queue/consumer cross-cutting tests, which may warrant their own `test/queue-consumer.test.ts` since currently that logic is only exercised incidentally inside `finance-lifecycle.test.ts` and `build.test.ts`.
- Run `npm run typecheck && npm test` as the CI gate; no test infra changes are needed to implement this plan, only new test cases.

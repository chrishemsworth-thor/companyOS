# Notifications & the approvals inbox

**Shipped:** S4 (PRD-000c + PRD-007) · **Migration:** `0023_notifications.sql`
**Depends on:** the approvals primitive ([`approvals.md`](approvals.md))

Two things live here: the `notifications` primitive (a row saying "somebody should
know about this", addressed to a user) and the console surfaces that make the
approvals primitive visible — the header bell and `/approvals`.

---

## The one rule

**Notification rows are written by an event consumer. Nothing else writes them.**

PRD-000 states it and standing rule 2 enforces it. If your module wants to notify
somebody, you emit an event and add an entry to the consumer's map. You do not
insert into `notifications`, and you do not build a second mechanism.

This is not ceremony. One writer means that when a notification is missing there
is exactly one place to look, and it means the idempotency and non-throwing
guarantees below hold for every notification in the system rather than for the
ones whose authors remembered.

PRD-007's nudge is the worked example. It is a user-initiated button in the
inbox, so the obvious implementation inserts a row in the route handler. Instead
it emits `approval.nudged` and the consumer maps it (SESSION-PLAN conflict C4).

---

## Adding a notification type

Three steps, no migration:

1. **Register the event** in `src/schemas/events/registry.ts` with a Zod schema.
   The consumer rejects unregistered types outright, so a mapper for an
   unregistered event is dead code that looks alive.
2. **Add a mapper** to `NOTIFICATION_MAP` in
   `src/modules/notifications/consumer.ts`. It receives the envelope and returns
   zero or more `NotificationSpec`s — one per person to tell.
3. **Add a route** to `SUBJECT_ROUTES` in `ui/src/lib/subjectRoutes.ts` if the
   subject has a console screen, so the notification deep-links instead of
   falling back to the inbox.

`subject_type` needs no migration and no enum change to *work* — the column is
plain TEXT and the consumer stores whatever it is given. Adding the value to
`notificationSubjectTypeSchema` only buys you a nicer label.

Sessions with a known entry to add: S11 (`ticket.assigned`,
`ticket.sla_breached`), S14 (`project.deadline_approaching`, `project.overdue`).

### Writing a mapper

```ts
"ticket.assigned": (envelope) => {
  const assignee = str(envelope.payload, "assignee_user_id");
  if (!assignee) return [];            // skip, do not throw
  return [{
    user_id: assignee,
    subject_type: "ticket",
    subject_id: ticketId,
    title: `Assigned to you: ticket ${ref}`,
    dedupe_key: `ticket.assigned:${ticketId}`,
  }];
},
```

Two things to get right:

- **Everything comes off the payload.** The consumer must not query the database
  to compose a row. This is why every `approval.*` payload carries *both*
  `requested_by` and `approver_user_id` — see `approvals.md`. Put the recipient on
  your event.
- **`dedupe_key` must be stable under redelivery and distinct across genuinely
  different notifications.** Key it on the subject for a one-off
  (`approval.requested:<approval_id>`); key it on `envelope.event_id` for a
  *repeatable* act (`approval.nudged:<event_id>`), or the second legitimate nudge
  a day later is silently swallowed by the unique index.

---

## Why the consumer never throws

This is the constraint the whole design bends around, and it comes from the
free-plan deploy.

On `wrangler.free.jsonc` there is no Cloudflare Queue. Events dispatch **inline**
through `src/queue/direct.ts`, which catches, logs and **drops** a throwing
consumer. There is no retry and no dead-letter queue, and the business write that
emitted the event has already committed. A throw therefore rolls nothing back — it
just loses the notification. On the queue path a throw is worse than useless: it
retries the whole envelope, re-running agent routing for a notification problem.

So `fanoutNotifications` swallows and logs. Every failure mode degrades to "no
row, one log line":

| Condition | Outcome |
|---|---|
| Payload missing a recipient or subject | No row, `console.warn` |
| `requested_by` is null (programmatic requester) | No row — normal, nobody to tell |
| Recipient is not a real user (FK violation) | No row, `console.error` |
| Same event delivered twice | One row (`INSERT OR IGNORE` on the natural key) |
| Event type with no mapper | No-op, the common case |

Inline dispatch is also **synchronous with the request that emitted the event**, so
the mapper must stay cheap. No lookups, no fan-out over a query result.

`fanoutNotifications` runs in `processEvent` *after* `logEvent` and *before*
`routeToAgent`: after the log so a notification failure can never cost the audit
record, before agent routing because the agent call is the slow one.

---

## Schema

```
notifications
  notification_id  ntf_<ulid>
  tenant_id, user_id           -- both NOT NULL; addressed to a person
  type                         -- the source event_type, e.g. approval.requested
  subject_type, subject_id     -- opaque here; the console maps them
  title, body                  -- rendered at WRITE time
  dedupe_key                   -- natural key, unique per (tenant, user)
  read_at                      -- NULL while unread
  created_at

  UNIQUE (tenant_id, user_id, dedupe_key)      -- the idempotency guarantee
  INDEX  (tenant_id, user_id, read_at, notification_id)
```

Titles are composed at write time, not read time. An event carries the facts as
they were when it happened; resolving names on read would let an old notification
silently change its wording, and would cost a join on the one query that runs on
every console page load.

The dedupe index is scoped **per user**, not per tenant: one event legitimately
notifies several people, and each of those is a separate row carrying the same
`dedupe_key`.

`approval_nudges` (same migration) is the nudge cooldown ledger — see below.

---

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/notifications?unread=true&limit=&cursor=` | `{ items, next_cursor, unread_count }`, **newest first** |
| POST | `/v1/notifications/:id/read` | Idempotent; keeps the first-seen `read_at` |
| POST | `/v1/notifications/read-all` | `{ marked, unread_count: 0 }` |
| POST | `/v1/approvals/:id/nudge` | 202; 429 + `Retry-After` inside 24h |

There is deliberately **no** `POST /v1/notifications` — that would be a second
writer.

Newest-first is the opposite of `listApprovals`, on purpose: an approvals queue is
work to get through, so the oldest item is the most urgent, whereas a notification
feed is a record of what happened.

`unread_count` counts **every** unread row, not the current page, and rides along
on every response so the badge costs no second request.

Every route is scoped to the calling **user**. A tenant API key gets **400**, not
an empty list — it authenticates a tenant, not a person, and answering `[]` would
let an integration poll forever and conclude nothing was happening. Cross-user and
cross-tenant ids return **404, not 403**, so a response never confirms an id
exists outside the caller's own feed.

`GET /v1/meta/users` was added alongside these: id → display name for the tenant,
readable by any authenticated user. `/v1/users` is admin-only, and a manager who
is not an admin still has to see "requested by Aisha" rather than a raw
`usr_01J...`. It returns id, display name and email only.

### The nudge cooldown

PRD-007: "a second nudge within 24h is blocked." The limit lives in
`src/modules/approvals/nudge.ts`, **before** the emit — a suppressed nudge did not
happen, so it should not be on the event log at all.

State lives in its own `approval_nudges` table for two reasons worth not
rediscovering:

1. **Not a column on `approvals`.** The cooldown is PRD-007's rule about a console
   affordance, not part of the approvals primitive's lifecycle.
2. **Not derived from `notifications`.** On the paid plan the notification row is
   written asynchronously by the queue consumer, so a second nudge seconds later
   would read a table that does not yet show the first one and sail straight
   through. The ledger is written synchronously by the emitting request, so the
   check is deterministic on both plans.

Requester-only, with **no admin override** — unlike cancel. An admin who wants a
request to move can decide it; nudging on somebody else's behalf would send a
reminder the named requester never asked for.

---

## Console

| Piece | Where |
|---|---|
| Header bell, on every page | `components/TopBar.tsx` → `components/NotificationBell.tsx` |
| Polling, focus-gated | `hooks/useNotifications.ts` |
| `subject_type` → route, labels | `lib/subjectRoutes.ts` |
| `/approvals`, three tabs | `pages/approvals/ApprovalsInbox.tsx` |
| Card shell + decision controls | `features/approvals/ApprovalCard.tsx` |
| **Renderer registry** | `features/approvals/renderers/registry.ts` |
| Generic fallback card | `features/approvals/renderers/GenericApprovalCard.tsx` |
| Tenant name directory | `hooks/useUserNames.ts` |

### The renderer registry

The inbox shell is generic. Everything that differs per subject — a receipt image,
a leave balance, a quote total — lives in a renderer registered in `registry.ts`.
PRD-007's success metric is that a new approvable type costs one renderer file.

**S4 registers nothing.** The map is empty on purpose, so *every* approval in this
release takes the generic fallback:

- `leave_request` → **S7** (dates, working days, remaining balance after approval,
  overlapping team leave, attachment)
- `expense_claim` → **S5** (receipt image inline and zoomable, category, limit
  status, line breakdown)
- `quote` → **S9** (total, validity, lines, discount)
- `invoice` → **never.** Reserved subject type, nothing creates one
  (SESSION-PLAN conflict C5); the fallback covers it.

`getApprovalRenderer` never returns undefined and never throws — an unknown
`subject_type` is a normal runtime condition, because the column has no CHECK and
a newer server can hand an older bundle a type it has never heard of.

To add one: write the component, add a line to `RENDERERS`, add a line to
`SUBJECT_ROUTES` if it has a detail screen. Do not touch the shell.

### Polling

60s interval **only while `document.visibilityState !== "hidden"`**, plus a
refetch on every route change. Pausing in a background tab is an acceptance
criterion, not an optimisation: a console left open on a spare monitor overnight
would otherwise make ~1,400 requests nobody reads.

### The route map lives in the console

`subject_type → path` is in `lib/subjectRoutes.ts`, not on the API payload. A
notification says what it is about; where that lives in this particular frontend is
a frontend concern, and putting a path on the payload would make every route
rename a server deploy.

`subjectRoute()` returning `null` is a first-class answer used for two cases — a
`subject_type` this bundle does not know, and a subject whose screen has not
shipped yet. Both render as unavailable and fall back to the inbox rather than
linking nowhere. `leave_request` and `expense_claim` are deliberately absent until
S7 and S5 build their pages.

---

## Tests

| File | Covers |
|---|---|
| `test/notification-consumer.test.ts` | PRD-000 criteria 1 and 2, idempotency, the never-throws contract, unknown subject types, `processEvent` ordering, tenant isolation on the write path |
| `test/notifications.test.ts` | PRD-000 criteria 3 and 4, the API surface, programmatic callers |
| `test/approval-nudge.test.ts` | PRD-007's nudge criterion, C4 (emits rather than inserts), the cooldown, authorization |
| `ui/src/components/NotificationBell.test.tsx` | All four bell criteria, including polling pause |
| `ui/src/pages/approvals/ApprovalsInbox.test.tsx` | All six inbox criteria and all three requester criteria |
| `ui/src/features/approvals/renderers/registry.test.tsx` | The fallback criterion |
| `ui/src/features/approvals/ApprovalCard.test.tsx` | Age formatting, the mobile contract |
| `ui/src/lib/subjectRoutes.test.ts` | The route map and its null cases |

**The free-plan criterion is tested on the free-plan path**, via
`ensureEventBus()` on an env with the `EVENTS` binding stripped — the same pattern
`test/direct-event-bus.test.ts` established. The test env has a *real* queue
binding, so an envelope handed to `env.EVENTS.send()` never reaches the consumer;
the two ways in are `processEvent()` directly and the inline bus.

**One honest gap.** PRD-007's mobile criteria are visual, and jsdom has no layout
engine — no assertion can measure a horizontal overflow at 375px. The tests pin
the *contract* that produces the result (no fixed widths, stacked full-width
controls, 40px targets). The rendered outcome wants one manual pass in a narrow
viewport. The "receipt image opens full screen and is zoomable" half belongs to
S5's claim renderer, which is where the image is.

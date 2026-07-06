 > **Superseded by [phase-1-native.md](phase-1-native.md).** The VPS/OSS
> module layer described below (ERPNext, Twenty, Plane, Libredesk behind a
> `ModuleAdapter`) was replaced by native Cloudflare modules; this document
> is retained for history. The spine it describes (gateway, event bus,
> Durable Object agents, D1) lives on unchanged.

# CompanyOS — Phase 0: Data Spine & Agent Orchestration

## Deployment topology

```
┌─────────────────────────────────────────────┐
│              CLOUDFLARE (the "brain")        │
│                                               │
│  Workers          → API Gateway              │
│  Durable Objects  → Agent runtime instances   │
│  Queues           → Event bus                 │
│  D1               → Gateway-normalized data   │
│  KV               → Config / lookups          │
└───────────────────┬───────────────────────────┘
                    │ HTTPS (outbound calls only)
                    ▼
┌─────────────────────────────────────────────┐
│         VPS / CONTAINER HOST (the "organs")  │
│                                               │
│  ERPNext / Frappe  → People + Finance         │
│  Twenty CRM        → Sales                    │
│  Plane             → Build                    │
│  Libredesk         → Support                  │
│  (each: unmodified, own DB, API-only access)  │
└─────────────────────────────────────────────┘
```

Nothing on the VPS side is ever modified — the gateway is the *only* consumer of their APIs. This is what keeps AGPL exposure contained: your Cloudflare-side code (gateway, event bus, agents) is entirely your own IP, with zero derivative-work relationship to the OSS modules.

---

## Event schema (v0)

All events flow through Cloudflare Queues in this envelope:

```json
{
  "event_id": "evt_01J...",          // ULID, sortable by time
  "event_type": "invoice.overdue",    // dot-namespaced: <entity>.<action>
  "source_module": "finance",         // finance | people | sales | support | build
  "tenant_id": "biz_abc123",          // SME account this belongs to
  "occurred_at": "2026-07-05T09:00:00Z",
  "payload": {
    "invoice_id": "inv_789",
    "customer_id": "cust_456",
    "amount_due": 4500.00,
    "currency": "MYR",
    "days_overdue": 9
  },
  "trace_id": "trc_xyz"                // for cross-module correlation
}
```

**Core event types for the Finance wedge (Phase 1):**
| Event | Emitted when |
|---|---|
| `invoice.created` | New invoice raised in ERPNext |
| `invoice.sent` | Invoice delivered to customer |
| `invoice.overdue` | Due date passed, unpaid |
| `payment.received` | Payment recorded against invoice |
| `payment.partial` | Partial payment recorded |
| `customer.risk_flagged` | Agent determines a customer is a collections risk |

Each event type gets a versioned JSON schema (`invoice.overdue.v1`) so you can evolve payloads without breaking older agent code — worth setting this convention now even with one event type, since Phase 2/3 will add many more.

---

## API Gateway surface (v0)

The gateway normalizes every OSS module into one internal REST/JSON API. Agents and the Insights layer only ever talk to the gateway, never to ERPNext/Twenty/etc directly.

```
GET   /v1/invoices?tenant_id=&status=overdue
GET   /v1/invoices/:id
POST  /v1/invoices/:id/reminder        # triggers agent-composed nudge, not a raw ERPNext write
GET   /v1/customers/:id
GET   /v1/customers/:id/payment-history

POST  /v1/webhooks/erpnext             # inbound webhook receiver, translates ERPNext's
                                        # native webhook payload into a normalized event
                                        # and pushes it onto the Queue
```

Internally, each `/v1/*` gateway route does three things:
1. Auth + tenant resolution (which SME's ERPNext instance to hit)
2. Translate normalized request → module-native API call (e.g. Frappe REST API)
3. Translate module-native response → normalized schema before returning

This translation layer is the part worth investing real design time in, since every future module (Sales, People, Support) plugs into the same pattern.

---

## Agent runtime (Durable Objects)

Each customer-account gets its own Durable Object instance for the Collections Agent — this gives you per-tenant state isolation for free and avoids cross-tenant data bleed, which matters a lot given you're dealing with financial data.

```
DO: CollectionsAgent(tenant_id, customer_id)
  state: { last_contact, risk_score, reminder_history, escalation_stage }
  
  onEvent(invoice.overdue)   → evaluate risk, decide action, call gateway to send reminder
  onEvent(payment.received)  → reset state, close loop
  alarm()                    → scheduled re-check (e.g. daily) for stale invoices
```

Durable Objects' built-in `alarm()` API is a natural fit for "check back in N days if nothing's changed" logic, which is most of what a collections agent does day-to-day.

---

## First vertical slice (proof of architecture)

Minimum to validate the whole spine before building real agent intelligence:

1. ERPNext webhook fires on invoice due-date passing → hits `/v1/webhooks/erpnext`
2. Gateway normalizes payload, pushes `invoice.overdue` event to Queue
3. Queue triggers the tenant's `CollectionsAgent` Durable Object
4. Agent does the dumbest possible thing: logs the event, sends one templated reminder via the gateway
5. Reminder send confirms round-trip: ERPNext → gateway → bus → agent → gateway → (email/WhatsApp out)

Once that loop works end-to-end, Phase 1 becomes "make the agent smarter," not "build new plumbing."

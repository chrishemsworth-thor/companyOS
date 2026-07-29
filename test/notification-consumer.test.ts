import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { ensureEventBus } from "../src/queue/direct";
import { processEvent } from "../src/queue/consumer";
import { makeEnvelope, type EventEnvelope } from "../src/schemas/envelope";
import { validatePayload } from "../src/schemas/events/registry";
import { fanoutNotifications, notifiableEventTypes } from "../src/modules/notifications/consumer";
import type { Notification } from "../src/modules/notifications/types";

/**
 * PRD-000c — the event→notification consumer.
 *
 * This file covers the *write* side: PRD-000's criterion 1 (an approval request
 * puts an unread notification in front of the approver), criterion 2 (it still
 * works on the free-plan inline path), and the two constraints the resolved
 * free-plan question imposes on top of them — an idempotent insert on a natural
 * key, and a consumer that never throws. `test/notifications.test.ts` covers the
 * read side and tenant isolation.
 *
 * Test-harness note inherited from S3: the test env has a real `EVENTS` queue
 * binding, so an envelope handed to `env.EVENTS.send()` never reaches the
 * consumer. The two ways in are therefore `processEvent()` directly and
 * `ensureEventBus()` on an env with the binding stripped — the latter being
 * exactly what a free-plan deploy runs, which is why it is the honest way to
 * test criterion 2.
 *
 * Isolated-storage note: D1 writes inside an `it` are rolled back before the
 * next one, so shared fixtures (tenants, users) are seeded in `beforeAll`, which
 * persists for the file. Notifications are created per test.
 */

const TENANT_ID = "biz_ntfcons";
const API_KEY = "test_api_key_ntfcons";
const OTHER_TENANT_ID = "biz_ntfcons_other";
const OTHER_API_KEY = "test_api_key_ntfcons_other";

type UserKey = "approver" | "requester" | "bystander" | "otherApprover";
const user = {} as Record<UserKey, string>;

beforeAll(async () => {
  for (const [tenantId, name, slug, key] of [
    [TENANT_ID, "Notif Consumer Tenant", "ntfcons-co", API_KEY],
    [OTHER_TENANT_ID, "Other Notif Tenant", "ntfcons-other-co", OTHER_API_KEY],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(tenantId, name, slug, await sha256Hex(key))
      .run();
  }

  for (const [key, email, role, tenantId] of [
    ["approver", "approver@ntfcons.test", "admin", TENANT_ID],
    ["requester", "requester@ntfcons.test", "operator", TENANT_ID],
    ["bystander", "bystander@ntfcons.test", "operator", TENANT_ID],
    ["otherApprover", "approver@ntfcons-other.test", "admin", OTHER_TENANT_ID],
  ] as const) {
    const created = await createUser(env.DB, {
      tenant_id: tenantId,
      email,
      password: `${key}-password`,
      display_name: key,
      role,
    });
    user[key] = created.user_id;
  }
});

/** An env a free-plan deploy sees: everything except the EVENTS binding. */
function bareEnv(): Env {
  const clone = { ...(env as unknown as Env) };
  delete (clone as { EVENTS?: Queue }).EVENTS;
  return clone;
}

function approvalEvent(
  eventType: string,
  payload: Record<string, unknown>,
  tenantId = TENANT_ID,
): EventEnvelope {
  return makeEnvelope({
    event_type: eventType,
    source_module: "platform",
    tenant_id: tenantId,
    payload,
  });
}

const requestedPayload = (overrides: Record<string, unknown> = {}) => ({
  approval_id: "apr_ntf_req_1",
  subject_type: "expense_claim",
  subject_id: "clm_1",
  requested_by: user.requester,
  approver_user_id: user.approver,
  resolution_strategy: "manager_chain",
  resolution_hops: 1,
  ...overrides,
});

const decisionPayload = (overrides: Record<string, unknown> = {}) => ({
  approval_id: "apr_ntf_dec_1",
  subject_type: "leave_request",
  subject_id: "lv_1",
  requested_by: user.requester,
  approver_user_id: user.approver,
  decided_by: user.approver,
  decided_at: new Date().toISOString(),
  ...overrides,
});

async function notificationsFor(userId: string, tenantId = TENANT_ID): Promise<Notification[]> {
  const { results } = await env.DB.prepare(
    `SELECT notification_id, tenant_id, user_id, type, subject_type, subject_id, title, body,
            dedupe_key, read_at, created_at
       FROM notifications WHERE tenant_id = ? AND user_id = ? ORDER BY notification_id ASC`,
  )
    .bind(tenantId, userId)
    .all<Notification>();
  return results ?? [];
}

describe("the event→notification map", () => {
  it("covers exactly the four approval events S4 owns, and nothing else", () => {
    // A guard on the extension point: a session adding an entry should add it
    // deliberately, and a session that accidentally registers a high-volume
    // event type here would fill every user's bell with noise.
    expect(notifiableEventTypes().sort()).toEqual([
      "approval.approved",
      "approval.nudged",
      "approval.rejected",
      "approval.requested",
    ]);
  });

  it("every notifiable event type is registered in the schema registry", () => {
    // The consumer rejects unregistered types outright, so a mapper for a type
    // the registry does not know is dead code that looks alive.
    for (const eventType of notifiableEventTypes()) {
      const check = validatePayload(eventType, {});
      expect(check, `${eventType} is not in the event registry`).not.toMatchObject({
        error: `unknown event_type: ${eventType}`,
      });
    }
  });
});

describe("approval.requested → the approver's badge", () => {
  it("gives the approver an unread notification (PRD-000 criterion 1)", async () => {
    await fanoutNotifications(env as unknown as Env, approvalEvent("approval.requested", requestedPayload()));

    const rows = await notificationsFor(user.approver);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: user.approver,
      type: "approval.requested",
      subject_type: "expense_claim",
      subject_id: "clm_1",
      read_at: null,
    });
    // The title is rendered at write time and must name the thing, not the id.
    expect(rows[0]!.title).toBe("Approval needed: expense claim");
  });

  it("tells nobody but the approver", async () => {
    await fanoutNotifications(env as unknown as Env, approvalEvent("approval.requested", requestedPayload()));

    expect(await notificationsFor(user.requester)).toHaveLength(0);
    expect(await notificationsFor(user.bystander)).toHaveLength(0);
  });

  it("writes exactly one row when the same event is delivered twice", async () => {
    // The queue retries on any consumer failure, so redelivery is the normal
    // case rather than an edge one. The natural key is what makes it harmless.
    const envelope = approvalEvent("approval.requested", requestedPayload());
    await fanoutNotifications(env as unknown as Env, envelope);
    await fanoutNotifications(env as unknown as Env, envelope);

    expect(await notificationsFor(user.approver)).toHaveLength(1);
  });

  it("deduplicates on the approval, so a re-emitted request does not double-badge", async () => {
    // Two distinct envelopes (different event_id) for the same approval: the
    // dedupe key is derived from the approval, not the delivery.
    await fanoutNotifications(env as unknown as Env, approvalEvent("approval.requested", requestedPayload()));
    await fanoutNotifications(env as unknown as Env, approvalEvent("approval.requested", requestedPayload()));

    expect(await notificationsFor(user.approver)).toHaveLength(1);
  });
});

describe("approval.approved / approval.rejected → the requester's badge", () => {
  it("notifies the requester on approval", async () => {
    await fanoutNotifications(env as unknown as Env, approvalEvent("approval.approved", decisionPayload()));

    const rows = await notificationsFor(user.requester);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "approval.approved", read_at: null, body: null });
    expect(rows[0]!.title).toBe("Approved: your leave request");
    expect(await notificationsFor(user.approver)).toHaveLength(0);
  });

  it("carries the decision comment as the body on a rejection", async () => {
    // "Why was this rejected" is the whole reason a requester opens the
    // notification, and the destination screen may not lead with it.
    await fanoutNotifications(
      env as unknown as Env,
      approvalEvent("approval.rejected", decisionPayload({ comment: "Receipt is illegible" })),
    );

    const rows = await notificationsFor(user.requester);
    expect(rows[0]).toMatchObject({
      type: "approval.rejected",
      title: "Rejected: your leave request",
      body: "Receipt is illegible",
    });
  });

  it("writes nothing when the requester was a programmatic caller", async () => {
    // `approvals.requested_by` is nullable — a claim raised with a tenant API key
    // has no human to tell. A normal outcome, not an error.
    await expect(
      fanoutNotifications(
        env as unknown as Env,
        approvalEvent("approval.rejected", decisionPayload({ requested_by: null })),
      ),
    ).resolves.toBeUndefined();

    expect(await notificationsFor(user.requester)).toHaveLength(0);
    expect(await notificationsFor(user.approver)).toHaveLength(0);
  });

  it("keeps a request and its decision as separate rows", async () => {
    // Same approval, two events, two different people — and the requester's
    // decision notification must not collide with anything.
    await fanoutNotifications(
      env as unknown as Env,
      approvalEvent("approval.requested", requestedPayload({ approval_id: "apr_pair" })),
    );
    await fanoutNotifications(
      env as unknown as Env,
      approvalEvent("approval.approved", decisionPayload({ approval_id: "apr_pair" })),
    );

    expect(await notificationsFor(user.approver)).toHaveLength(1);
    expect(await notificationsFor(user.requester)).toHaveLength(1);
  });
});

describe("approval.nudged → a second reminder for the approver", () => {
  const nudgePayload = (overrides: Record<string, unknown> = {}) => ({
    approval_id: "apr_ntf_nudge_1",
    subject_type: "expense_claim",
    subject_id: "clm_9",
    requested_by: user.requester,
    approver_user_id: user.approver,
    pending_hours: 51.5,
    ...overrides,
  });

  it("notifies the approver", async () => {
    await fanoutNotifications(env as unknown as Env, approvalEvent("approval.nudged", nudgePayload()));

    const rows = await notificationsFor(user.approver);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "approval.nudged", read_at: null });
    expect(rows[0]!.title).toBe("Reminder: expense claim is still waiting for you");
  });

  it("deduplicates on the event, not the approval, so a later nudge still lands", async () => {
    // The distinction that matters: keying a nudge on the approval id would
    // silently swallow a legitimate second nudge the next day. Two nudges for
    // one approval are two events, so they are two rows — the 24h limit is
    // enforced in the service, not by this key.
    const first = approvalEvent("approval.nudged", nudgePayload());
    await fanoutNotifications(env as unknown as Env, first);
    await fanoutNotifications(env as unknown as Env, first); // redelivery
    await fanoutNotifications(env as unknown as Env, approvalEvent("approval.nudged", nudgePayload()));

    expect(await notificationsFor(user.approver)).toHaveLength(2);
  });
});

describe("the consumer never throws", () => {
  // The free-plan path catches, logs and DROPS a throwing consumer, and the
  // business write that emitted the event has already committed. So every
  // recoverable condition must degrade to "no row" rather than an exception —
  // see the resolved free-plan question in SESSION-PLAN.
  const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["an empty payload", {}],
    ["no approver to notify", { approval_id: "apr_x", subject_type: "quote", subject_id: "q_1" }],
    ["a missing subject_id", { approval_id: "apr_x", subject_type: "quote", approver_user_id: "usr_x" }],
    ["a non-string approver", { approval_id: "apr_x", subject_type: "quote", subject_id: "q_1", approver_user_id: 42 }],
  ];

  for (const [label, payload] of cases) {
    it(`resolves and writes nothing given ${label}`, async () => {
      await expect(
        fanoutNotifications(env as unknown as Env, approvalEvent("approval.requested", payload)),
      ).resolves.toBeUndefined();
      expect(await notificationsFor(user.approver)).toHaveLength(0);
    });
  }

  it("resolves when the recipient is not a real user", async () => {
    // The FK on notifications.user_id rejects this insert. A genuine failure,
    // and still not one the emitting request can do anything about.
    await expect(
      fanoutNotifications(
        env as unknown as Env,
        approvalEvent("approval.requested", requestedPayload({ approver_user_id: "usr_does_not_exist" })),
      ),
    ).resolves.toBeUndefined();
  });

  it("is a no-op for an event type nobody registered a mapper for", async () => {
    await expect(
      fanoutNotifications(
        env as unknown as Env,
        makeEnvelope({
          event_type: "invoice.created",
          source_module: "finance",
          tenant_id: TENANT_ID,
          payload: { invoice_id: "inv_1" },
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe("unknown subject types still notify", () => {
  it("writes a row for a subject_type this build has never heard of", async () => {
    // PRD-007's inbox falls back to a generic card for an unregistered
    // subject_type. Dropping the notification instead would trade that
    // cosmetic gap for a silently missing badge.
    await fanoutNotifications(
      env as unknown as Env,
      approvalEvent("approval.requested", requestedPayload({ subject_type: "purchase_order" })),
    );

    const rows = await notificationsFor(user.approver);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_type: "purchase_order" });
    // Humanized rather than rejected.
    expect(rows[0]!.title).toBe("Approval needed: purchase order");
  });
});

describe("processEvent wiring", () => {
  it("audit-logs and notifies from the one pipeline", async () => {
    const envelope = approvalEvent("approval.requested", requestedPayload());
    await processEvent(env as unknown as Env, envelope);

    const logged = await env.DB.prepare("SELECT event_id FROM events_log WHERE event_id = ?")
      .bind(envelope.event_id)
      .first();
    expect(logged).not.toBeNull();
    expect(await notificationsFor(user.approver)).toHaveLength(1);
  });

  it("still audit-logs when the notification insert fails", async () => {
    // Ordering guarantee: fanout runs after logEvent, so a notification failure
    // can never cost us the audit record.
    const envelope = approvalEvent(
      "approval.requested",
      requestedPayload({ approver_user_id: "usr_nonexistent" }),
    );
    await processEvent(env as unknown as Env, envelope);

    const logged = await env.DB.prepare("SELECT event_id FROM events_log WHERE event_id = ?")
      .bind(envelope.event_id)
      .first();
    expect(logged).not.toBeNull();
  });

  it("rejects an unregistered event type before any notification work", async () => {
    await expect(
      processEvent(
        env as unknown as Env,
        makeEnvelope({
          event_type: "approval.nudged_typo",
          source_module: "platform",
          tenant_id: TENANT_ID,
          payload: requestedPayload(),
        }),
      ),
    ).rejects.toThrow(/unknown event_type/);
  });
});

describe("the free-plan inline path (PRD-000 criterion 2)", () => {
  it("creates a notification with no queue binding at all", async () => {
    // The criterion in full: on `wrangler.free.jsonc` there is no EVENTS queue,
    // so every send() runs the consumer pipeline inline. If notifications only
    // worked on the paid plan, the free-plan deploy would ship a permanently
    // empty bell.
    const bus = ensureEventBus(bareEnv()).EVENTS;
    const envelope = approvalEvent("approval.requested", requestedPayload());

    await bus.send(envelope);

    const rows = await notificationsFor(user.approver);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "approval.requested", read_at: null });
  });

  it("notifies on a decision inline too", async () => {
    const bus = ensureEventBus(bareEnv()).EVENTS;
    await bus.send(approvalEvent("approval.approved", decisionPayload()));

    expect(await notificationsFor(user.requester)).toHaveLength(1);
  });

  it("delivers every notification in an inline sendBatch", async () => {
    const bus = ensureEventBus(bareEnv()).EVENTS;
    await bus.sendBatch(
      ["apr_batch_a", "apr_batch_b"].map((approvalId) => ({
        body: approvalEvent("approval.requested", requestedPayload({ approval_id: approvalId })),
      })),
    );

    expect(await notificationsFor(user.approver)).toHaveLength(2);
  });

  it("does not fail the emitting send() when the notification cannot be written", async () => {
    // The inline bus swallows consumer errors, and the consumer swallows its own
    // — belt and braces, because the emitting request has already committed.
    const bus = ensureEventBus(bareEnv()).EVENTS;
    await expect(
      bus.send(approvalEvent("approval.requested", requestedPayload({ approver_user_id: "usr_ghost" }))),
    ).resolves.toBeDefined();
  });
});

describe("tenant isolation on the write path", () => {
  it("stamps the notification with the event's tenant, not the recipient's", async () => {
    // Belt on the isolation rule: the row lands under the emitting tenant, so a
    // user id that exists in another tenant cannot pull a notification across.
    await fanoutNotifications(
      env as unknown as Env,
      approvalEvent(
        "approval.requested",
        requestedPayload({ approver_user_id: user.otherApprover }),
        OTHER_TENANT_ID,
      ),
    );

    expect(await notificationsFor(user.otherApprover, OTHER_TENANT_ID)).toHaveLength(1);
    expect(await notificationsFor(user.otherApprover, TENANT_ID)).toHaveLength(0);
  });

  it("lets two tenants hold the same dedupe key without colliding", async () => {
    // The unique index is (tenant_id, user_id, dedupe_key). Two tenants can
    // legitimately mint the same approval id shape, and one must not swallow the
    // other's notification.
    const payload = requestedPayload({ approval_id: "apr_shared_id" });
    await fanoutNotifications(env as unknown as Env, approvalEvent("approval.requested", payload));
    await fanoutNotifications(
      env as unknown as Env,
      approvalEvent(
        "approval.requested",
        { ...payload, approver_user_id: user.otherApprover },
        OTHER_TENANT_ID,
      ),
    );

    expect(await notificationsFor(user.approver, TENANT_ID)).toHaveLength(1);
    expect(await notificationsFor(user.otherApprover, OTHER_TENANT_ID)).toHaveLength(1);
  });
});

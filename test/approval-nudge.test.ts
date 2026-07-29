import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { ensureEventBus } from "../src/queue/direct";
import { validatePayload } from "../src/schemas/events/registry";
import type { EventEnvelope } from "../src/schemas/envelope";
import { requestApproval } from "../src/modules/approvals/service";
import { nudge, NudgeRateLimited, NUDGE_COOLDOWN_HOURS } from "../src/modules/approvals/nudge";

/**
 * PRD-007 § "Requester visibility" — the nudge.
 *
 * The acceptance criterion is one sentence with two halves: "given a nudge, then
 * the approver receives ONE notification; a second nudge within 24h is blocked."
 * Both halves are here, plus the thing that makes the feature legitimate at all
 * — SESSION-PLAN conflict C4. The nudge does NOT insert a notification row. It
 * emits `approval.nudged` and the S4 consumer writes the row, so the
 * notifications table keeps exactly one writer.
 *
 * The cooldown is deliberately tested against the ledger table rather than by
 * waiting 24 hours: `approval_nudges` is the state the check reads, so rewriting
 * a row's `nudged_at` is the same as time having passed.
 *
 * Isolated-storage note: approvals and nudges are created per test; tenants,
 * users and reporting lines are seeded in `beforeAll`.
 */

const WORKSPACE = "nudge-co";
const TENANT_ID = "biz_nudge";
const API_KEY = "test_api_key_nudge";
const ORIGIN = "http://localhost:5173";
const PASSWORD = "nudge-password";

type UserKey = "admin" | "requester" | "approver" | "bystander";
const user = {} as Record<UserKey, string>;

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface Session {
  cookie: string;
  csrf: string;
}

async function login(email: string): Promise<Session> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace: WORKSPACE, email, password: PASSWORD }),
  });
  const cookie = (res.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const body = (await res.json()) as { csrf_token: string };
  return { cookie, csrf: body.csrf_token };
}

function sessionHeaders(s: Session): Record<string, string> {
  return {
    Cookie: s.cookie,
    "X-CSRF-Token": s.csrf,
    "Content-Type": "application/json",
    Origin: ORIGIN,
  };
}

/**
 * An env whose bus records instead of dispatching — S3's pattern. The test env
 * has a real EVENTS binding, so a sent envelope never reaches the consumer;
 * capturing it lets the exact payload be asserted and run through the registry.
 */
function capturingEnv(): { env: Env; sent: EventEnvelope[] } {
  const sent: EventEnvelope[] = [];
  const bus = {
    async send(message: unknown) {
      sent.push(message as EventEnvelope);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
    async sendBatch(messages: Iterable<MessageSendRequest<unknown>>) {
      for (const m of messages) sent.push(m.body as EventEnvelope);
      return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
    },
  };
  return { env: { ...(env as unknown as Env), EVENTS: bus as unknown as Queue }, sent };
}

/** An env with no queue binding — what a free-plan deploy runs. */
function bareEnv(): Env {
  const clone = { ...(env as unknown as Env) };
  delete (clone as { EVENTS?: Queue }).EVENTS;
  return clone;
}

/** Raise a pending approval from `requester`, assigned to `approver`. */
async function raise(subjectId = "clm_nudge"): Promise<string> {
  const { env: capturing } = capturingEnv();
  const approval = await requestApproval(capturing, TENANT_ID, {
    subject_type: "expense_claim",
    subject_id: subjectId,
    requested_by: user.requester,
    approver_user_id: user.approver,
  });
  return approval.approval_id;
}

/** Backdate the most recent nudge, standing in for the passage of time. */
async function backdateNudge(approvalId: string, hoursAgo: number): Promise<void> {
  const when = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
  await env.DB.prepare(
    "UPDATE approval_nudges SET nudged_at = ? WHERE tenant_id = ? AND approval_id = ?",
  )
    .bind(when, TENANT_ID, approvalId)
    .run();
}

async function nudgeCount(approvalId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM approval_nudges WHERE tenant_id = ? AND approval_id = ?",
  )
    .bind(TENANT_ID, approvalId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function notificationCount(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM notifications WHERE tenant_id = ? AND user_id = ? AND type = 'approval.nudged'",
  )
    .bind(TENANT_ID, userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(TENANT_ID, "Nudge Tenant", WORKSPACE, await sha256Hex(API_KEY))
    .run();

  for (const [key, email, role] of [
    ["admin", "admin@nudge.test", "admin"],
    ["requester", "requester@nudge.test", "operator"],
    ["approver", "approver@nudge.test", "operator"],
    ["bystander", "bystander@nudge.test", "operator"],
  ] as const) {
    const created = await createUser(env.DB, {
      tenant_id: TENANT_ID,
      email,
      password: PASSWORD,
      display_name: key,
      role,
    });
    user[key] = created.user_id;
  }
});

describe("nudge emits rather than inserting (SESSION-PLAN C4)", () => {
  it("emits one approval.nudged event and writes no notification itself", async () => {
    const { env: capturing, sent } = capturingEnv();
    const approvalId = await raise();

    const result = await nudge(capturing, TENANT_ID, approvalId, user.requester);

    expect(result).toMatchObject({ approval_id: approvalId, approver_user_id: user.approver });
    const nudged = sent.filter((e) => e.event_type === "approval.nudged");
    expect(nudged).toHaveLength(1);
    expect(nudged[0]!.source_module).toBe("platform");
    expect(nudged[0]!.payload).toMatchObject({
      approval_id: approvalId,
      subject_type: "expense_claim",
      subject_id: "clm_nudge",
      requested_by: user.requester,
      approver_user_id: user.approver,
    });

    // The point of C4: the row is the consumer's job, not the service's. With a
    // capturing bus nothing consumes the event, so there is no notification.
    expect(await notificationCount(user.approver)).toBe(0);
  });

  it("emits a payload the registry accepts", async () => {
    const { env: capturing, sent } = capturingEnv();
    const approvalId = await raise();
    await nudge(capturing, TENANT_ID, approvalId, user.requester);

    const nudged = sent.find((e) => e.event_type === "approval.nudged")!;
    expect(validatePayload("approval.nudged", nudged.payload)).toEqual({ ok: true });
  });

  it("reports how long the request had been waiting", async () => {
    const { env: capturing, sent } = capturingEnv();
    const approvalId = await raise();
    // Backdate the approval itself: the payload's pending_hours is what makes
    // "chased after six days" reportable later.
    await env.DB.prepare("UPDATE approvals SET created_at = ? WHERE tenant_id = ? AND approval_id = ?")
      .bind(new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), TENANT_ID, approvalId)
      .run();

    await nudge(capturing, TENANT_ID, approvalId, user.requester);

    const nudged = sent.find((e) => e.event_type === "approval.nudged")!;
    expect(nudged.payload.pending_hours as number).toBeGreaterThanOrEqual(47.9);
    expect(nudged.payload.pending_hours as number).toBeLessThanOrEqual(48.1);
  });
});

describe("the approver receives exactly one notification", () => {
  it("end to end on the inline free-plan path", async () => {
    // The acceptance criterion's first half, through the real pipeline: emit →
    // consumer → row. The inline bus is used because the test env's real queue
    // never delivers to the consumer.
    const approvalId = await raise();

    await nudge(ensureEventBus(bareEnv()), TENANT_ID, approvalId, user.requester);

    expect(await notificationCount(user.approver)).toBe(1);
    const row = await env.DB.prepare(
      "SELECT title, subject_id, read_at FROM notifications WHERE tenant_id = ? AND user_id = ? AND type = 'approval.nudged'",
    )
      .bind(TENANT_ID, user.approver)
      .first<{ title: string; subject_id: string; read_at: string | null }>();
    expect(row).toMatchObject({ subject_id: "clm_nudge", read_at: null });
    expect(row!.title).toContain("Reminder");
  });

  it("tells the approver, not the requester", async () => {
    const approvalId = await raise();
    await nudge(ensureEventBus(bareEnv()), TENANT_ID, approvalId, user.requester);

    expect(await notificationCount(user.approver)).toBe(1);
    expect(await notificationCount(user.requester)).toBe(0);
  });
});

describe(`a second nudge within ${NUDGE_COOLDOWN_HOURS}h is blocked`, () => {
  it("rejects the second nudge and sends no second notification", async () => {
    const approvalId = await raise();
    const bus = ensureEventBus(bareEnv());

    await nudge(bus, TENANT_ID, approvalId, user.requester);
    await expect(nudge(bus, TENANT_ID, approvalId, user.requester)).rejects.toBeInstanceOf(
      NudgeRateLimited,
    );

    expect(await notificationCount(user.approver)).toBe(1);
    // And the blocked attempt left no trace in the ledger — a suppressed nudge
    // did not happen, so it must not extend the cooldown either.
    expect(await nudgeCount(approvalId)).toBe(1);
  });

  it("says how long to wait", async () => {
    const approvalId = await raise();
    const { env: capturing } = capturingEnv();
    await nudge(capturing, TENANT_ID, approvalId, user.requester);
    await backdateNudge(approvalId, 20);

    await expect(nudge(capturing, TENANT_ID, approvalId, user.requester)).rejects.toMatchObject({
      httpStatus: 429,
      // ~4h left of the 24h window.
      retryAfterSeconds: expect.any(Number),
    });
  });

  it("allows a nudge once the window has passed", async () => {
    const approvalId = await raise();
    const bus = ensureEventBus(bareEnv());

    await nudge(bus, TENANT_ID, approvalId, user.requester);
    await backdateNudge(approvalId, NUDGE_COOLDOWN_HOURS + 1);
    await nudge(bus, TENANT_ID, approvalId, user.requester);

    // Two genuine reminders, a day apart — and two rows, which is why the
    // consumer dedupes a nudge on event_id rather than on the approval.
    expect(await notificationCount(user.approver)).toBe(2);
    expect(await nudgeCount(approvalId)).toBe(2);
  });

  it("rate-limits per approval, not per user", async () => {
    // Chasing one stuck request must not silence the button on a different one.
    const first = await raise("clm_a");
    const second = await raise("clm_b");
    const bus = ensureEventBus(bareEnv());

    await nudge(bus, TENANT_ID, first, user.requester);
    await nudge(bus, TENANT_ID, second, user.requester);

    expect(await notificationCount(user.approver)).toBe(2);
  });
});

describe("who may nudge, and what", () => {
  it("403s for anyone but the requester", async () => {
    const { env: capturing } = capturingEnv();
    const approvalId = await raise();

    await expect(nudge(capturing, TENANT_ID, approvalId, user.bystander)).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it("403s for the approver themselves", async () => {
    const { env: capturing } = capturingEnv();
    const approvalId = await raise();

    await expect(nudge(capturing, TENANT_ID, approvalId, user.approver)).rejects.toMatchObject({
      httpStatus: 403,
    });
  });

  it("404s on an unknown approval", async () => {
    const { env: capturing } = capturingEnv();
    await expect(nudge(capturing, TENANT_ID, "apr_nope", user.requester)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });

  it("409s once the request has been decided", async () => {
    // Nothing to chase: the approver already answered.
    const { env: capturing } = capturingEnv();
    const approvalId = await raise();
    await env.DB.prepare("UPDATE approvals SET state = 'approved' WHERE tenant_id = ? AND approval_id = ?")
      .bind(TENANT_ID, approvalId)
      .run();

    await expect(nudge(capturing, TENANT_ID, approvalId, user.requester)).rejects.toMatchObject({
      httpStatus: 409,
    });
  });

  it("409s on a cancelled request", async () => {
    const { env: capturing } = capturingEnv();
    const approvalId = await raise();
    await env.DB.prepare("UPDATE approvals SET state = 'cancelled' WHERE tenant_id = ? AND approval_id = ?")
      .bind(TENANT_ID, approvalId)
      .run();

    await expect(nudge(capturing, TENANT_ID, approvalId, user.requester)).rejects.toMatchObject({
      httpStatus: 409,
    });
  });
});

describe("POST /v1/approvals/:id/nudge", () => {
  it("202s for the requester and carries Retry-After on the second attempt", async () => {
    const approvalId = await raise();
    const requester = await login("requester@nudge.test");

    const first = await fetchWorker(`/v1/approvals/${approvalId}/nudge`, {
      method: "POST",
      headers: sessionHeaders(requester),
    });
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ approval_id: approvalId });

    const second = await fetchWorker(`/v1/approvals/${approvalId}/nudge`, {
      method: "POST",
      headers: sessionHeaders(requester),
    });
    expect(second.status).toBe(429);
    // A client needs to know when the button becomes useful again rather than
    // guessing.
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await second.json()).toMatchObject({ code: "rate_limited" });
  });

  it("403s for a user who did not raise the request", async () => {
    const approvalId = await raise();
    const bystander = await login("bystander@nudge.test");

    const res = await fetchWorker(`/v1/approvals/${approvalId}/nudge`, {
      method: "POST",
      headers: sessionHeaders(bystander),
    });
    expect(res.status).toBe(403);
  });

  it("403s for an admin who is not the requester", async () => {
    // Unlike cancel, there is no admin override: an admin who wants a request to
    // move can decide it themselves. Nudging on somebody's behalf would send a
    // reminder the named requester never asked for.
    const approvalId = await raise();
    const admin = await login("admin@nudge.test");

    const res = await fetchWorker(`/v1/approvals/${approvalId}/nudge`, {
      method: "POST",
      headers: sessionHeaders(admin),
    });
    expect(res.status).toBe(403);
  });

  it("404s on another tenant's approval id", async () => {
    const requester = await login("requester@nudge.test");
    const res = await fetchWorker("/v1/approvals/apr_from_elsewhere/nudge", {
      method: "POST",
      headers: sessionHeaders(requester),
    });
    expect(res.status).toBe(404);
  });

  it("400s for a tenant API key, which has no user identity to nudge as", async () => {
    const approvalId = await raise();
    const res = await fetchWorker(`/v1/approvals/${approvalId}/nudge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("requires a CSRF token", async () => {
    const approvalId = await raise();
    const requester = await login("requester@nudge.test");
    const res = await fetchWorker(`/v1/approvals/${approvalId}/nudge`, {
      method: "POST",
      headers: { Cookie: requester.cookie, "Content-Type": "application/json", Origin: ORIGIN },
    });
    expect(res.status).toBe(403);
  });
});

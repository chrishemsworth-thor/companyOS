import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { ensureEventBus } from "../src/queue/direct";
import { validatePayload } from "../src/schemas/events/registry";
import type { EventEnvelope } from "../src/schemas/envelope";
import { decide, listApprovals } from "../src/modules/approvals/service";
import { applyLeaveDecision } from "../src/modules/people/leave/consumer";
import {
  cancelLeaveRequest,
  getBalances,
  getLeaveRequest,
  submitLeaveRequest,
  LeaveError,
} from "../src/modules/people/leave/service";

/**
 * S6's annual entitlement for the fixtures below: the middle tenure band of the
 * Malaysian defaults migration 0025 seeds. Named rather than spelled out at each
 * use, because every balance assertion here is derived from it.
 *
 * Deliberately NOT the leave policy port's provisional figure (8). Since S6
 * landed, this module reads real policy rather than its own fallback, and these
 * numbers moving from 8 to 12 is what that reconciliation looks like.
 */
const ANNUAL_ENTITLEMENT_DAYS = 12;


/**
 * PRD-006c — approval routing, decision handling and cancellation.
 *
 * Covers the two PRD-006 § "Leave: request and approval" criteria that need the
 * approvals primitive:
 *
 *  - *"Given a submitted request, then the manager has a notification and a
 *    pending approval."*
 *  - *"Given approval, then the balance is decremented and the employee is
 *    notified."*
 *
 * plus PRD-000's own criterion, which the S7 brief calls out explicitly:
 *
 *  - *"Given a cancelled subject (e.g. withdrawn leave request), then the
 *    approval is `cancelled` and no longer appears in pending lists."* Asserted
 *    against the live `GET /v1/approvals?state=pending&mine=true` endpoint, not
 *    just the row — "no longer appears in pending lists" is a claim about the
 *    list, so checking the column alone would not test it.
 *
 * and PRD-006's cancellation rule in all three of its branches: withdraw while
 * pending, admin cancels approved leave outright, employee cancels approved
 * leave and it goes back for re-approval.
 *
 * Where a test needs the notification consumer to have run, it uses
 * `ensureEventBus` on an env with no EVENTS binding so the bus dispatches inline
 * — the same trick test/approvals.test.ts uses for its one end-to-end check.
 */

const WORKSPACE = "leave-apr-co";
const TENANT_ID = "biz_leave_apr";
const API_KEY = "test_api_key_leave_apr";
const ORIGIN = "http://localhost:5173";

const YEAR = 2027;
const MON = `${YEAR}-03-01`;
const TUE = `${YEAR}-03-02`;
const WED = `${YEAR}-03-03`;
const THU = `${YEAR}-03-04`;

/**
 * A span in the past, for the "already started" 409.
 *
 * Inside the employees' employment, not merely in the past. The fixtures join on
 * `${YEAR - 3}-01-01`, and since S6 landed the entitlement behind a request is
 * real policy evaluated for that request's own leave year — so a span from
 * before somebody was hired now correctly has nothing to draw on and is blocked
 * for insufficient balance before it can ever be approved and cancelled. 2024-03-04
 * is a Monday.
 */
const PAST_START = `${YEAR - 3}-03-04`;
const PAST_END = `${YEAR - 3}-03-06`;

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

async function login(email: string, password: string): Promise<Session> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace: WORKSPACE, email, password }),
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

/**
 * An env whose event bus dispatches INLINE through the real consumer, so
 * notification rows and leave-state transitions actually happen. `ensureEventBus`
 * installs the direct bus when EVENTS is absent (the free-plan path).
 */
function inlineEnv(): Env {
  const stripped = { ...(env as unknown as Env) } as Record<string, unknown>;
  delete stripped.EVENTS;
  return ensureEventBus(stripped as unknown as Env);
}

type UserKey = "admin" | "staff" | "manager" | "topboss" | "bystander";
const user = {} as Record<UserKey, string>;

const EMP_STAFF = "emp_lva_staff";
const EMP_MANAGER = "emp_lva_manager";
const EMP_TOPBOSS = "emp_lva_topboss";
const EMP_BYSTANDER = "emp_lva_bystander";
/** No manager at all, for the admin-fallback route. */
const EMP_ORPHAN = "emp_lva_orphan";
/** A manager with no console login, for the C1 upward walk. */
const EMP_NOLOGIN_MGR = "emp_lva_nologin_mgr";
const EMP_UNDER_NOLOGIN = "emp_lva_under_nologin";

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(TENANT_ID, "Leave Approval Tenant", WORKSPACE, await sha256Hex(API_KEY))
    .run();

  const seeded: ReadonlyArray<[UserKey, string, string, Parameters<typeof createUser>[1]["role"]]> = [
    ["admin", "admin@leave-apr.test", "admin-password", "admin"],
    ["staff", "staff@leave-apr.test", "staff-password", "employee"],
    // The approver. `employee` role on purpose: a team lead who holds no
    // business capability must still be able to open and decide the request,
    // which is the case that justifies mounting leave on `self`.
    ["manager", "manager@leave-apr.test", "manager-password", "employee"],
    ["topboss", "topboss@leave-apr.test", "topboss-password", "employee"],
    // Holds an approval on nothing — the negative case for per-row access.
    ["bystander", "bystander@leave-apr.test", "bystander-password", "employee"],
  ];
  for (const [key, email, password, role] of seeded) {
    const created = await createUser(env.DB, {
      tenant_id: TENANT_ID,
      email,
      password,
      display_name: key,
      role,
    });
    user[key] = created.user_id;
  }

  // Managers before reports (FK on (tenant_id, manager_employee_id)).
  for (const [id, name, login] of [
    [EMP_TOPBOSS, "Top Boss", "topboss"],
    [EMP_MANAGER, "Line Manager", "manager"],
    [EMP_NOLOGIN_MGR, "Manager Without Login", null],
    [EMP_STAFF, "Staff Member", "staff"],
    [EMP_BYSTANDER, "Bystander", "bystander"],
    [EMP_ORPHAN, "Orphan", null],
    [EMP_UNDER_NOLOGIN, "Under A Loginless Manager", null],
  ] as const) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO employees
         (employee_id, tenant_id, name, department_id, user_id, start_date)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, TENANT_ID, name, "operations", login ? user[login as UserKey] : null, `${YEAR - 3}-01-01`)
      .run();
  }
  for (const [id, manager] of [
    [EMP_STAFF, EMP_MANAGER],
    [EMP_MANAGER, EMP_TOPBOSS],
    [EMP_NOLOGIN_MGR, EMP_TOPBOSS],
    [EMP_UNDER_NOLOGIN, EMP_NOLOGIN_MGR],
  ] as const) {
    await env.DB.prepare(
      "UPDATE employees SET manager_employee_id = ? WHERE tenant_id = ? AND employee_id = ?",
    )
      .bind(manager, TENANT_ID, id)
      .run();
  }
});

/** File a request on the capturing bus and hand back the row plus the events. */
async function file(
  overrides: Partial<Parameters<typeof submitLeaveRequest>[2]> = {},
): Promise<{ request: Awaited<ReturnType<typeof submitLeaveRequest>>; sent: EventEnvelope[]; env: Env }> {
  const { env: capturing, sent } = capturingEnv();
  const request = await submitLeaveRequest(capturing, TENANT_ID, {
    employee_id: EMP_STAFF,
    leave_type_code: "annual",
    start_date: MON,
    end_date: WED,
    requested_by: user.staff,
    ...overrides,
  });
  return { request, sent, env: capturing };
}

/**
 * Decide an approval on the INLINE bus, so the consumer chain actually runs.
 *
 * Not over HTTP, and the reason matters. `worker.fetch` is handed the test env,
 * which has a real EVENTS queue binding — so `approval.approved` is enqueued and
 * nothing drains it inside a test, meaning `processEvent` never runs and no
 * downstream effect is observable. Calling `decide()` on an env with the direct
 * bus installed exercises the same service the route calls plus the real
 * consumer, and it is precisely the free-plan production path (src/queue/direct.ts
 * awaits `processEvent` inline).
 *
 * The HTTP surface is covered separately, by the authorization tests below and
 * by test/approvals.test.ts.
 */
async function decideInline(
  approvalId: string,
  decision: "approved" | "rejected",
  actorUserId: string,
  actorRole: string,
  comment?: string,
) {
  return decide(inlineEnv(), TENANT_ID, approvalId, {
    actor_user_id: actorUserId,
    actor_role: actorRole,
    decision,
    comment: comment ?? null,
  });
}

/** Decide through the HTTP route — used where the assertion is authorization. */
async function decideOverHttp(
  approvalId: string,
  decision: "approve" | "reject",
  session: Session,
  comment?: string,
): Promise<Response> {
  return fetchWorker(`/v1/approvals/${approvalId}/${decision}`, {
    method: "POST",
    headers: sessionHeaders(session),
    body: JSON.stringify(comment ? { comment } : {}),
  });
}

/* -------------------------------------------------------- approval routing */

describe("acceptance: a submitted request gives the manager a pending approval and a notification", () => {
  it("routes the approval to the employee's manager", async () => {
    const { request } = await file();
    const approvals = await listApprovals(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      subject_id: request.leave_request_id,
      limit: 10,
    });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      state: "pending",
      approver_user_id: user.manager,
      requested_by: user.staff,
      subject_type: "leave_request",
    });
  });

  it("puts it in the manager's own pending queue", async () => {
    await file();
    const manager = await login("manager@leave-apr.test", "manager-password");
    const res = await fetchWorker("/v1/approvals?state=pending&mine=true", {
      headers: sessionHeaders(manager),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ subject_type: string }> };
    expect(body.items.filter((a) => a.subject_type === "leave_request").length).toBeGreaterThan(0);
  });

  it("notifies the manager, through the real consumer", async () => {
    // End to end on the inline bus: submit → approval.requested → S4's fanout.
    // No new NOTIFICATION_MAP entry was needed for this, which is the point.
    const inline = inlineEnv();
    const request = await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });

    const rows = await env.DB.prepare(
      "SELECT user_id, type, title FROM notifications WHERE tenant_id = ? AND subject_id = ?",
    )
      .bind(TENANT_ID, request.leave_request_id)
      .all<{ user_id: string; type: string; title: string }>();

    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]).toMatchObject({
      user_id: user.manager,
      type: "approval.requested",
    });
    expect(rows.results![0]!.title).toContain("leave request");
  });

  it("walks up past a manager with no console login (SESSION-PLAN C1)", async () => {
    const { request } = await file({ employee_id: EMP_UNDER_NOLOGIN, requested_by: null });
    const approvals = await listApprovals(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      subject_id: request.leave_request_id,
      limit: 10,
    });
    // The immediate manager cannot act, so it lands on the one above.
    expect(approvals[0]!.approver_user_id).toBe(user.topboss);
  });

  it("falls back to a tenant admin when the employee has no manager", async () => {
    const { request } = await file({ employee_id: EMP_ORPHAN, requested_by: null });
    const approvals = await listApprovals(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      subject_id: request.leave_request_id,
      limit: 10,
    });
    expect(approvals[0]!.approver_user_id).toBe(user.admin);
  });

  it("writes no leave request when the tenant has nobody who can approve", async () => {
    // The compensating delete: a request row with a dangling approval would be
    // worse than no row, so submission is atomic from the caller's side.
    const emptyTenant = "biz_leave_apr_empty";
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(emptyTenant, "No Approver", "leave-apr-empty-co", await sha256Hex("k-empty"))
      .run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO employees (employee_id, tenant_id, name, department_id, start_date)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind("emp_lva_alone", emptyTenant, "Alone", "operations", `${YEAR - 1}-01-01`)
      .run();

    const { env: capturing } = capturingEnv();
    await expect(
      submitLeaveRequest(capturing, emptyTenant, {
        employee_id: "emp_lva_alone",
        leave_type_code: "unpaid",
        start_date: MON,
        end_date: MON,
        requested_by: null,
      }),
    ).rejects.toMatchObject({ httpStatus: 422, code: "no_approver" });

    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM leave_requests WHERE tenant_id = ?",
    )
      .bind(emptyTenant)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

/* -------------------------------------------------------------- a decision */

describe("acceptance: on approval the balance is decremented and the employee is notified", () => {
  it("moves the request to approved and the days from pending to taken", async () => {
    const inline = inlineEnv();
    const request = await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });

    const approval = await decideInline(request.approval_id!, "approved", user.manager, "employee");
    expect(approval.state).toBe("approved");

    const after = await getLeaveRequest(env.DB, TENANT_ID, request.leave_request_id);
    expect(after!.state).toBe("approved");
    expect(after!.decided_at).not.toBeNull();

    const annual = (await getBalances(inline, TENANT_ID, EMP_STAFF, YEAR)).find(
      (b) => b.leave_type_code === "annual",
    )!;
    // Decremented at submission and still decremented — the days simply moved
    // buckets, which is why approval needs no atomicity guarantee here.
    expect(annual.taken_days).toBe(3);
    expect(annual.pending_days).toBe(0);
    expect(annual.available_days).toBe(ANNUAL_ENTITLEMENT_DAYS - 3);
  });

  it("notifies the employee of the decision, with no leave-specific mapper", async () => {
    const inline = inlineEnv();
    const request = await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });
    await decideInline(request.approval_id!, "approved", user.manager, "employee");

    const rows = await env.DB.prepare(
      "SELECT user_id, type FROM notifications WHERE tenant_id = ? AND subject_id = ? ORDER BY type",
    )
      .bind(TENANT_ID, request.leave_request_id)
      .all<{ user_id: string; type: string }>();

    // Two rows, both from S4's existing `approval.*` mappers: the approver was
    // told to decide, the employee was told the outcome. Registering
    // `leave.approved` as well would have produced a third, duplicate badge.
    expect(rows.results).toHaveLength(2);
    expect(rows.results).toEqual(
      expect.arrayContaining([
        { user_id: user.manager, type: "approval.requested" },
        { user_id: user.staff, type: "approval.approved" },
      ]),
    );
  });

  it("emits a registry-valid leave.approved alongside the primitive's approval.approved", async () => {
    const { request } = await file();
    const { env: capturing, sent } = capturingEnv();
    await applyLeaveDecision(capturing, {
      event_id: "evt_test_approved",
      event_type: "approval.approved",
      source_module: "platform",
      tenant_id: TENANT_ID,
      occurred_at: new Date().toISOString(),
      trace_id: "trc_test",
      payload: {
        approval_id: request.approval_id,
        subject_type: "leave_request",
        subject_id: request.leave_request_id,
        requested_by: user.staff,
        approver_user_id: user.manager,
        decided_by: user.manager,
        decided_at: new Date().toISOString(),
      },
    });

    const approved = sent.find((e) => e.event_type === "leave.approved")!;
    expect(approved).toBeDefined();
    expect(approved.source_module).toBe("people");
    expect(validatePayload("leave.approved", approved.payload)).toEqual({ ok: true });
    expect(approved.payload).toMatchObject({
      leave_request_id: request.leave_request_id,
      employee_id: EMP_STAFF,
      approved_by: user.manager,
    });
  });

  it("rejects: state becomes rejected, the balance comes back, and leave.rejected carries the comment", async () => {
    const inline = inlineEnv();
    const request = await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });
    await decideInline(
      request.approval_id!,
      "rejected",
      user.manager,
      "employee",
      "Too busy that week",
    );

    const after = await getLeaveRequest(env.DB, TENANT_ID, request.leave_request_id);
    expect(after!.state).toBe("rejected");

    const annual = (await getBalances(inline, TENANT_ID, EMP_STAFF, YEAR)).find(
      (b) => b.leave_type_code === "annual",
    )!;
    expect(annual.available_days).toBe(ANNUAL_ENTITLEMENT_DAYS);

    const logged = await env.DB.prepare(
      "SELECT payload FROM events_log WHERE tenant_id = ? AND event_type = 'leave.rejected'",
    )
      .bind(TENANT_ID)
      .first<{ payload: string }>();
    expect(JSON.parse(logged!.payload)).toMatchObject({
      leave_request_id: request.leave_request_id,
      comment: "Too busy that week",
    });
  });

  it("is idempotent — a redelivered approval event emits nothing the second time", async () => {
    const { request } = await file();
    const decidedAt = new Date().toISOString();
    const envelope: EventEnvelope = {
      event_id: "evt_test_redeliver",
      event_type: "approval.approved",
      source_module: "platform",
      tenant_id: TENANT_ID,
      occurred_at: decidedAt,
      trace_id: "trc_test",
      payload: {
        approval_id: request.approval_id,
        subject_type: "leave_request",
        subject_id: request.leave_request_id,
        requested_by: user.staff,
        approver_user_id: user.manager,
        decided_by: user.manager,
        decided_at: decidedAt,
      },
    };

    const first = capturingEnv();
    await applyLeaveDecision(first.env, envelope);
    expect(first.sent.filter((e) => e.event_type === "leave.approved")).toHaveLength(1);

    const second = capturingEnv();
    await applyLeaveDecision(second.env, envelope);
    // The guarded UPDATE matched nothing, so no second domain event.
    expect(second.sent).toHaveLength(0);
  });

  it("ignores an approval decision about some other subject type", async () => {
    const { env: capturing, sent } = capturingEnv();
    await applyLeaveDecision(capturing, {
      event_id: "evt_test_other",
      event_type: "approval.approved",
      source_module: "platform",
      tenant_id: TENANT_ID,
      occurred_at: new Date().toISOString(),
      trace_id: "trc_test",
      payload: {
        approval_id: "apr_whatever",
        subject_type: "expense_claim",
        subject_id: "clm_whatever",
        requested_by: null,
        approver_user_id: user.manager,
        decided_by: user.manager,
        decided_at: new Date().toISOString(),
      },
    });
    expect(sent).toHaveLength(0);
  });

  it("403s a decision from somebody who is neither the approver nor an admin", async () => {
    const { request } = await file();
    const bystander = await login("bystander@leave-apr.test", "bystander-password");
    const res = await decideOverHttp(request.approval_id!, "approve", bystander);
    expect(res.status).toBe(403);
    // And the request is untouched.
    expect((await getLeaveRequest(env.DB, TENANT_ID, request.leave_request_id))!.state).toBe(
      "pending",
    );
  });
});

/* -------------------------------------------- PRD-000: cancelled subject */

describe("PRD-000 acceptance: a cancelled subject's approval is cancelled and leaves pending lists", () => {
  it("cancels the approval and drops it out of the approver's pending list", async () => {
    const inline = inlineEnv();
    const request = await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });

    const manager = await login("manager@leave-apr.test", "manager-password");
    const listPending = async () => {
      const res = await fetchWorker("/v1/approvals?state=pending&mine=true", {
        headers: sessionHeaders(manager),
      });
      const body = (await res.json()) as { items: Array<{ subject_id: string }> };
      return body.items.map((a) => a.subject_id);
    };

    // Present before.
    expect(await listPending()).toContain(request.leave_request_id);

    const staff = await login("staff@leave-apr.test", "staff-password");
    const cancelRes = await fetchWorker(
      `/v1/leave/requests/${request.leave_request_id}/cancel`,
      { method: "POST", headers: sessionHeaders(staff), body: "{}" },
    );
    expect(cancelRes.status).toBe(200);
    expect((await cancelRes.json()) as { outcome: string }).toMatchObject({
      outcome: "cancelled",
    });

    // The approval row is `cancelled`...
    const approvals = await listApprovals(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      subject_id: request.leave_request_id,
      limit: 10,
    });
    expect(approvals[0]!.state).toBe("cancelled");
    // ...and gone from the pending list, which is the half of the criterion a
    // column check would miss.
    expect(await listPending()).not.toContain(request.leave_request_id);

    // The leave request itself is cancelled and the days are back.
    expect((await getLeaveRequest(env.DB, TENANT_ID, request.leave_request_id))!.state).toBe(
      "cancelled",
    );
    const annual = (await getBalances(inline, TENANT_ID, EMP_STAFF, YEAR)).find(
      (b) => b.leave_type_code === "annual",
    )!;
    expect(annual.available_days).toBe(ANNUAL_ENTITLEMENT_DAYS);
  });

  it("emits leave.cancelled and no approval.cancelled", async () => {
    const { request, env: capturing, sent } = await file();
    sent.length = 0;

    await cancelLeaveRequest(capturing, TENANT_ID, request.leave_request_id, {
      actor_user_id: user.staff,
      actor_is_admin: false,
    });

    expect(sent.map((e) => e.event_type)).toEqual(["leave.cancelled"]);
    const cancelled = sent[0]!;
    expect(validatePayload("leave.cancelled", cancelled.payload)).toEqual({ ok: true });
    expect(cancelled.payload).toMatchObject({
      leave_request_id: request.leave_request_id,
      previous_state: "pending",
      cancelled_by: user.staff,
    });
    // The primitive deliberately has no `approval.cancelled` — a second event
    // would have the notification consumer telling the approver about work that
    // simply evaporated.
    expect(sent.some((e) => e.event_type.startsWith("approval."))).toBe(false);
  });

  it("does not notify the employee about their own withdrawal", async () => {
    const inline = inlineEnv();
    const request = await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: WED,
      requested_by: user.staff,
    });
    await cancelLeaveRequest(inline, TENANT_ID, request.leave_request_id, {
      actor_user_id: user.staff,
      actor_is_admin: false,
    });

    const rows = await env.DB.prepare(
      "SELECT type FROM notifications WHERE tenant_id = ? AND subject_id = ? AND type = 'leave.cancelled'",
    )
      .bind(TENANT_ID, request.leave_request_id)
      .all<{ type: string }>();
    expect(rows.results).toEqual([]);
  });
});

/* --------------------------------------- cancelling APPROVED future leave */

describe("cancelling approved future leave (PRD-006: re-approval or admin action)", () => {
  /** Get a request into `approved` through the real decision path. */
  async function approvedRequest(start = MON, end = WED) {
    const inline = inlineEnv();
    const request = await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: start,
      end_date: end,
      requested_by: user.staff,
    });
    await decideInline(request.approval_id!, "approved", user.manager, "employee");
    return { request, inline };
  }

  it("an admin cancels it outright", async () => {
    const { request, inline } = await approvedRequest();
    const result = await cancelLeaveRequest(inline, TENANT_ID, request.leave_request_id, {
      actor_user_id: user.admin,
      actor_is_admin: true,
    });
    expect(result.outcome).toBe("cancelled");
    expect(result.request.state).toBe("cancelled");
    expect(result.request.cancelled_at).not.toBeNull();

    const annual = (await getBalances(inline, TENANT_ID, EMP_STAFF, YEAR)).find(
      (b) => b.leave_type_code === "annual",
    )!;
    expect(annual.available_days).toBe(ANNUAL_ENTITLEMENT_DAYS);
  });

  it("notifies the employee when an admin cancels it — the one leave.* mapper", async () => {
    // The genuine notification gap: no approval decision is involved, so
    // without the `leave.cancelled` mapper the employee would find their leave
    // gone and never be told.
    const { request, inline } = await approvedRequest();
    await cancelLeaveRequest(inline, TENANT_ID, request.leave_request_id, {
      actor_user_id: user.admin,
      actor_is_admin: true,
    });

    const rows = await env.DB.prepare(
      `SELECT user_id, title FROM notifications
        WHERE tenant_id = ? AND subject_id = ? AND type = 'leave.cancelled'`,
    )
      .bind(TENANT_ID, request.leave_request_id)
      .all<{ user_id: string; title: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results![0]).toMatchObject({ user_id: user.staff });
    expect(rows.results![0]!.title).toContain("cancelled");
  });

  it("an employee's cancellation goes back for re-approval instead", async () => {
    const { request, inline } = await approvedRequest();
    const result = await cancelLeaveRequest(inline, TENANT_ID, request.leave_request_id, {
      actor_user_id: user.staff,
      actor_is_admin: false,
    });

    expect(result.outcome).toBe("cancellation_pending");
    expect(result.request.state).toBe("cancellation_pending");

    // A SECOND approval exists, and it is pending on the manager again.
    const approvals = await listApprovals(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      subject_id: request.leave_request_id,
      limit: 10,
    });
    expect(approvals).toHaveLength(2);
    const pending = approvals.filter((a) => a.state === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.approver_user_id).toBe(user.manager);
    // The request points at the live approval, not the decided one.
    expect(result.request.approval_id).toBe(pending[0]!.approval_id);

    // The leave is still booked, so it still consumes balance.
    const annual = (await getBalances(inline, TENANT_ID, EMP_STAFF, YEAR)).find(
      (b) => b.leave_type_code === "annual",
    )!;
    expect(annual.available_days).toBe(ANNUAL_ENTITLEMENT_DAYS - 3);
  });

  it("approving the cancellation cancels the leave and gives the days back", async () => {
    const { request, inline } = await approvedRequest();
    const result = await cancelLeaveRequest(inline, TENANT_ID, request.leave_request_id, {
      actor_user_id: user.staff,
      actor_is_admin: false,
    });

    await decideInline(result.request.approval_id!, "approved", user.manager, "employee");

    const after = await getLeaveRequest(env.DB, TENANT_ID, request.leave_request_id);
    expect(after!.state).toBe("cancelled");
    expect(after!.cancelled_at).not.toBeNull();

    const annual = (await getBalances(inline, TENANT_ID, EMP_STAFF, YEAR)).find(
      (b) => b.leave_type_code === "annual",
    )!;
    expect(annual.available_days).toBe(ANNUAL_ENTITLEMENT_DAYS);

    // The event describes what happened to the LEAVE, not which button was
    // pressed: an approve decision produced a `leave.cancelled`.
    const logged = await env.DB.prepare(
      `SELECT payload FROM events_log
        WHERE tenant_id = ? AND event_type = 'leave.cancelled'
          AND payload LIKE ?`,
    )
      .bind(TENANT_ID, `%${request.leave_request_id}%`)
      .first<{ payload: string }>();
    expect(JSON.parse(logged!.payload)).toMatchObject({
      previous_state: "cancellation_pending",
      cancelled_by: user.manager,
    });
  });

  it("refusing the cancellation leaves the leave approved", async () => {
    const { request, inline } = await approvedRequest();
    const result = await cancelLeaveRequest(inline, TENANT_ID, request.leave_request_id, {
      actor_user_id: user.staff,
      actor_is_admin: false,
    });

    await decideInline(
      result.request.approval_id!,
      "rejected",
      user.manager,
      "employee",
      "We need the cover",
    );

    const after = await getLeaveRequest(env.DB, TENANT_ID, request.leave_request_id);
    expect(after!.state).toBe("approved");
    expect(after!.cancelled_at).toBeNull();

    // Still booked, still consuming.
    const annual = (await getBalances(inline, TENANT_ID, EMP_STAFF, YEAR)).find(
      (b) => b.leave_type_code === "annual",
    )!;
    expect(annual.available_days).toBe(ANNUAL_ENTITLEMENT_DAYS - 3);
  });

  it("409s cancelling approved leave that has already started", async () => {
    const { request, inline } = await approvedRequest(PAST_START, PAST_END);
    await expect(
      cancelLeaveRequest(inline, TENANT_ID, request.leave_request_id, {
        actor_user_id: user.admin,
        actor_is_admin: true,
      }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("409s cancelling an already-cancelled request", async () => {
    const { request, env: capturing } = await file();
    await cancelLeaveRequest(capturing, TENANT_ID, request.leave_request_id, {
      actor_user_id: user.staff,
      actor_is_admin: false,
    });
    await expect(
      cancelLeaveRequest(capturing, TENANT_ID, request.leave_request_id, {
        actor_user_id: user.staff,
        actor_is_admin: false,
      }),
    ).rejects.toBeInstanceOf(LeaveError);
  });

  it("403s a cancellation by somebody else's manager", async () => {
    // A manager can DECIDE the request but not withdraw it — withdrawing is the
    // employee's act, or an administrator's.
    const { request } = await file();
    const manager = await login("manager@leave-apr.test", "manager-password");
    const res = await fetchWorker(`/v1/leave/requests/${request.leave_request_id}/cancel`, {
      method: "POST",
      headers: sessionHeaders(manager),
      body: "{}",
    });
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------- per-row read access */

describe("per-row read access (what makes the approvals inbox card work)", () => {
  it("lets the assigned approver read the request despite holding no people:read", async () => {
    const { request } = await file();
    const manager = await login("manager@leave-apr.test", "manager-password");

    // Proof the role really is business-blind: the People directory 403s.
    const directory = await fetchWorker("/v1/people/employees", {
      headers: sessionHeaders(manager),
    });
    expect(directory.status).toBe(403);

    const res = await fetchWorker(`/v1/leave/requests/${request.leave_request_id}`, {
      headers: sessionHeaders(manager),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      employee_name: string;
      working_days: number;
      balance_after_days: number;
      team_overlaps: unknown[];
      approval: { state: string } | null;
    };
    // Everything PRD-006c's card needs, in one call.
    expect(body.employee_name).toBe("Staff Member");
    expect(body.working_days).toBe(3);
    expect(body.balance_after_days).toBe(ANNUAL_ENTITLEMENT_DAYS - 3);
    expect(body.team_overlaps).toEqual([]);
    expect(body.approval).toMatchObject({ state: "pending" });
  });

  it("404s the same request for a bystander with no approval on it", async () => {
    const { request } = await file();
    const bystander = await login("bystander@leave-apr.test", "bystander-password");
    const res = await fetchWorker(`/v1/leave/requests/${request.leave_request_id}`, {
      headers: sessionHeaders(bystander),
    });
    // 404 rather than 403: a 403 would confirm the id exists.
    expect(res.status).toBe(404);
  });

  it("lets the employee read their own request", async () => {
    const { request } = await file();
    const staff = await login("staff@leave-apr.test", "staff-password");
    const res = await fetchWorker(`/v1/leave/requests/${request.leave_request_id}`, {
      headers: sessionHeaders(staff),
    });
    expect(res.status).toBe(200);
  });

  it("still lets the approver read it after they have decided it", async () => {
    // The inbox lists decided items too, so access cannot be scoped to a
    // *pending* approval.
    const inline = inlineEnv();
    const request = await submitLeaveRequest(inline, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: TUE,
      requested_by: user.staff,
    });
    await decideInline(request.approval_id!, "approved", user.manager, "employee");

    const manager = await login("manager@leave-apr.test", "manager-password");
    const res = await fetchWorker(`/v1/leave/requests/${request.leave_request_id}`, {
      headers: sessionHeaders(manager),
    });
    expect(res.status).toBe(200);
  });

  it("scope=mine returns only the caller's own requests", async () => {
    const { env: capturing } = capturingEnv();
    await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_STAFF,
      leave_type_code: "annual",
      start_date: MON,
      end_date: TUE,
      requested_by: user.staff,
    });
    await submitLeaveRequest(capturing, TENANT_ID, {
      employee_id: EMP_BYSTANDER,
      leave_type_code: "annual",
      start_date: WED,
      end_date: THU,
      requested_by: user.bystander,
    });

    const staff = await login("staff@leave-apr.test", "staff-password");
    const res = await fetchWorker("/v1/leave/requests?scope=mine", {
      headers: sessionHeaders(staff),
    });
    const body = (await res.json()) as { items: Array<{ employee_id: string }> };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((r) => r.employee_id === EMP_STAFF)).toBe(true);
  });

  it("403s scope=all without people:read", async () => {
    const staff = await login("staff@leave-apr.test", "staff-password");
    const res = await fetchWorker("/v1/leave/requests?scope=all", {
      headers: sessionHeaders(staff),
    });
    expect(res.status).toBe(403);
  });
});

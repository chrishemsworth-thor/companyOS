import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { ensureEventBus } from "../src/queue/direct";
import { validatePayload } from "../src/schemas/events/registry";
import type { EventEnvelope } from "../src/schemas/envelope";
import {
  ApprovalsError,
  cancel,
  cancelForSubject,
  decide,
  getApproval,
  listApprovals,
  requestApproval,
} from "../src/modules/approvals/service";
import { resolveApprover } from "../src/modules/approvals/resolution";
import type { Approval } from "../src/modules/approvals/types";

/**
 * PRD-000b — the approvals primitive.
 *
 * Every acceptance criterion in PRD-000 § "P0 — Approvals primitive" has a test
 * here, plus the three the S3 brief and SESSION-PLAN conflicts add:
 *
 *  - **C1** — a manager who has no console login. PRD-000 covers *no manager
 *    set*; it does not cover *manager set, no login*, and that is the case that
 *    would leave a request pending forever. Covered here at one level, at three
 *    levels terminating at admin, and for a manager whose login is disabled.
 *  - **C5** — `invoice` is reserved and resolvable but unused.
 *  - **C8** — resubmission after rejection creates a NEW row and the rejected
 *    one stands. No `supersedes` column.
 *
 * Isolated-storage note: D1 writes made inside an `it` are rolled back before
 * the next one, so the fixtures every test shares (tenants, users, reporting
 * lines) are seeded in `beforeAll`, which persists for the file. Approvals
 * themselves are created per test.
 */

const WORKSPACE = "approvals-co";
const TENANT_ID = "biz_approvals";
const API_KEY = "test_api_key_approvals";

const OTHER_WORKSPACE = "approvals-other-co";
const OTHER_TENANT_ID = "biz_approvals_other";
const OTHER_API_KEY = "test_api_key_approvals_other";

/** A tenant with users but no active admin, for the "nobody can approve" case. */
const EMPTY_TENANT_ID = "biz_approvals_noadmin";
const EMPTY_API_KEY = "test_api_key_approvals_noadmin";

const ORIGIN = "http://localhost:5173";
const bearer = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

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

async function login(email: string, password: string, workspace = WORKSPACE): Promise<Session> {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace, email, password }),
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
 * An env whose event bus records instead of dispatching. The test env has a
 * real EVENTS queue binding, so a sent envelope does not reach the consumer and
 * never lands in `events_log` — capturing it is both simpler and a stricter
 * assertion, because the exact payload is inspectable and can be run through
 * the registry.
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

/**
 * The seeded users, keyed by role in the fixture rather than by id. Declared as
 * a closed key set so a typo in a test is a compile error rather than an
 * `undefined` that silently resolves to a different approver.
 */
type UserKey =
  | "admin"
  | "admin2"
  | "finance"
  | "operator"
  | "staff"
  | "disabled"
  | "director"
  | "orphan"
  | "report"
  | "manager"
  | "topboss"
  | "soloreport"
  | "solomgr"
  | "nl0"
  | "otherAdmin"
  | "noAdminOperator";

/** Ids of the users seeded in beforeAll, filled in there. */
const user = {} as Record<UserKey, string>;

const EMPLOYEES: ReadonlyArray<{
  id: string;
  name: string;
  /** Key into `user`, or null for an employee with no console login. */
  login: UserKey | null;
  manager: string | null;
}> = [
  // The C1 chain: staff → (no login) → (disabled login) → director.
  { id: "emp_apr_staff", name: "Staff Member", login: "staff", manager: "emp_apr_nologin" },
  { id: "emp_apr_nologin", name: "Manager Without Login", login: null, manager: "emp_apr_disabled" },
  { id: "emp_apr_disabled", name: "Manager With Disabled Login", login: "disabled", manager: "emp_apr_director" },
  { id: "emp_apr_director", name: "Director", login: "director", manager: null },

  // No manager at all → tenant admin.
  { id: "emp_apr_orphan", name: "Orphan", login: "orphan", manager: null },

  // Requester-is-the-approver: report → manager → topboss.
  { id: "emp_apr_report", name: "Report", login: "report", manager: "emp_apr_manager" },
  { id: "emp_apr_manager", name: "Line Manager", login: "manager", manager: "emp_apr_topboss" },
  { id: "emp_apr_topboss", name: "Top Boss", login: "topboss", manager: null },

  // Requester-is-the-approver with nothing above them → tenant admin.
  { id: "emp_apr_solo_report", name: "Solo Report", login: "soloreport", manager: "emp_apr_solo_mgr" },
  { id: "emp_apr_solo_mgr", name: "Solo Manager", login: "solomgr", manager: null },

  // A three-deep chain where nobody at all can log in → tenant admin.
  { id: "emp_apr_nl0", name: "Bottom", login: "nl0", manager: "emp_apr_nl1" },
  { id: "emp_apr_nl1", name: "Middle (no login)", login: null, manager: "emp_apr_nl2" },
  { id: "emp_apr_nl2", name: "Upper (no login)", login: null, manager: "emp_apr_nl3" },
  { id: "emp_apr_nl3", name: "Top (no login)", login: null, manager: null },
];

beforeAll(async () => {
  for (const [tenantId, name, slug, key] of [
    [TENANT_ID, "Approvals Tenant", WORKSPACE, API_KEY],
    [OTHER_TENANT_ID, "Other Approvals Tenant", OTHER_WORKSPACE, OTHER_API_KEY],
    [EMPTY_TENANT_ID, "No Admin Tenant", "approvals-noadmin-co", EMPTY_API_KEY],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
    )
      .bind(tenantId, name, slug, await sha256Hex(key))
      .run();
  }

  // Order matters for the two admins: the admin fallback is deterministic on
  // (role preference, created_at, user_id), so `admin` is always chosen ahead
  // of `admin2` — and `admin2` is what a request FROM `admin` falls back to.
  const seeded: ReadonlyArray<[UserKey, string, string, Parameters<typeof createUser>[1]["role"]]> = [
    ["admin", "admin@approvals.test", "admin-password", "admin"],
    ["admin2", "admin2@approvals.test", "admin2-password", "admin"],
    ["finance", "finance@approvals.test", "finance-password", "finance"],
    ["operator", "operator@approvals.test", "operator-password", "operator"],
    ["staff", "staff@approvals.test", "staff-password", "operator"],
    ["disabled", "disabled@approvals.test", "disabled-password", "operator"],
    ["director", "director@approvals.test", "director-password", "operator"],
    ["orphan", "orphan@approvals.test", "orphan-password", "operator"],
    ["report", "report@approvals.test", "report-password", "operator"],
    ["manager", "manager@approvals.test", "manager-password", "operator"],
    ["topboss", "topboss@approvals.test", "topboss-password", "operator"],
    ["soloreport", "soloreport@approvals.test", "soloreport-password", "operator"],
    ["solomgr", "solomgr@approvals.test", "solomgr-password", "operator"],
    ["nl0", "nl0@approvals.test", "nl0-password", "operator"],
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

  // The disabled account, for the "manager can log in on paper only" case.
  await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?")
    .bind(user.disabled)
    .run();

  // Other tenant: its own admin, for the isolation tests.
  user.otherAdmin = (
    await createUser(env.DB, {
      tenant_id: OTHER_TENANT_ID,
      email: "admin@other-approvals.test",
      password: "other-admin-password",
      role: "admin",
    })
  ).user_id;

  // A tenant with a user but no active admin at all.
  user.noAdminOperator = (
    await createUser(env.DB, {
      tenant_id: EMPTY_TENANT_ID,
      email: "operator@noadmin.test",
      password: "noadmin-password",
      role: "operator",
    })
  ).user_id;

  // Employees, parents last: the FK on (tenant_id, manager_employee_id) means a
  // manager must exist before the row pointing at it, so insert with a NULL
  // manager and wire the reporting lines up afterwards.
  for (const e of EMPLOYEES) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO employees (employee_id, tenant_id, name, department_id, user_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(e.id, TENANT_ID, e.name, "operations", e.login ? user[e.login] : null)
      .run();
  }
  for (const e of EMPLOYEES) {
    if (!e.manager) continue;
    await env.DB.prepare(
      "UPDATE employees SET manager_employee_id = ? WHERE tenant_id = ? AND employee_id = ?",
    )
      .bind(e.manager, TENANT_ID, e.id)
      .run();
  }
});

/** Raise a leave-request approval on the capturing bus. */
async function raise(
  input: Parameters<typeof requestApproval>[2],
  tenantId = TENANT_ID,
): Promise<{ approval: Approval; sent: EventEnvelope[] }> {
  const cap = capturingEnv();
  const approval = await requestApproval(cap.env, tenantId, input);
  return { approval, sent: cap.sent };
}

async function expectError(fn: () => Promise<unknown>): Promise<ApprovalsError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApprovalsError);
    return err as ApprovalsError;
  }
  throw new Error("expected an ApprovalsError, but the call resolved");
}

// ---------------------------------------------------------------------------
// Approver resolution — SESSION-PLAN C1
// ---------------------------------------------------------------------------

describe("approver resolution", () => {
  it("routes to the requester's manager when that manager can log in", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_1",
      requested_by: user.report,
    });
    expect(approval.approver_user_id).toBe(user.manager);
    expect(approval.state).toBe("pending");
  });

  /**
   * SESSION-PLAN C1, and the case PRD-000 does not cover. The immediate manager
   * exists and is correctly set — they simply have no `user_id`, so they could
   * never act. Before C1 this row would have been created pointing at nobody
   * and the request would have sat pending forever with no error.
   */
  it("walks past a manager who has no console login", async () => {
    const { approval, sent } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_2",
      requested_by: user.staff,
    });
    // staff → nologin (no user_id) → disabled (login, but disabled) → director.
    expect(approval.approver_user_id).toBe(user.director);
    expect(sent[0]!.payload).toMatchObject({
      resolution_strategy: "manager_chain",
      resolution_hops: 3,
    });
  });

  it("walks past a manager whose login exists but is disabled", async () => {
    // Same chain, entered one level higher: the disabled account is the very
    // first candidate, so this isolates the status check from the null check.
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subjectType: "leave_request",
      requesterUserId: user.staff,
      subjectEmployeeId: "emp_apr_nologin",
    });
    expect(resolved).toEqual({
      approver_user_id: user.director,
      strategy: "manager_chain",
      hops: 2,
    });
  });

  /** PRD-000: "an employee with no manager routes to a tenant admin". */
  it("routes to a tenant admin when the employee has no manager", async () => {
    const { approval, sent } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_3",
      requested_by: user.orphan,
    });
    expect(approval.approver_user_id).toBe(user.admin);
    expect(sent[0]!.payload).toMatchObject({ resolution_strategy: "tenant_admin" });
  });

  /**
   * PRD-000: "a requester who is also the resolved approver and is not admin
   * routes to the next level up". The manager files on behalf of their own
   * report, so the walk's first candidate IS the requester.
   */
  it("skips the requester and climbs when they are their own resolved approver", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_4",
      requested_by: user.manager,
      subject_employee_id: "emp_apr_report",
    });
    expect(approval.approver_user_id).toBe(user.topboss);
  });

  /** The same criterion's second half: "...or to an admin if none". */
  it("falls back to an admin when the requester is the only person above the subject", async () => {
    const { approval, sent } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_5",
      requested_by: user.solomgr,
      subject_employee_id: "emp_apr_solo_report",
    });
    expect(approval.approver_user_id).toBe(user.admin);
    expect(sent[0]!.payload).toMatchObject({ resolution_strategy: "tenant_admin" });
  });

  /** The S3 brief's "multi-level walk terminating at admin". */
  it("walks a three-deep chain with no logins anywhere and terminates at an admin", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_6",
      requested_by: user.nl0,
    });
    expect(approval.approver_user_id).toBe(user.admin);
  });

  it("prefers a different admin when the requester is themselves an admin", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_7",
      requested_by: user.admin,
    });
    expect(approval.approver_user_id).toBe(user.admin2);
  });

  /**
   * The solo-admin tenant. Refusing to create the approval would make claims
   * and leave unusable for a one-person finance function, and PRD-000 permits
   * self-approval for an admin — so it routes back to them rather than 422ing.
   */
  it("routes an admin's own request back to them when no other admin exists", async () => {
    const soloAdmin = await createUser(env.DB, {
      tenant_id: EMPTY_TENANT_ID,
      email: "solo@noadmin.test",
      password: "solo-password",
      role: "admin",
    });
    const { approval, sent } = await raise(
      { subject_type: "leave_request", subject_id: "lv_8", requested_by: soloAdmin.user_id },
      EMPTY_TENANT_ID,
    );
    expect(approval.approver_user_id).toBe(soloAdmin.user_id);
    expect(sent[0]!.payload).toMatchObject({ resolution_strategy: "self_admin" });
  });

  /**
   * Nobody in the tenant can approve: no reporting line, no active admin, and
   * the requester is not an admin either. 422 — and critically, no row, so a
   * tenant in this state has nothing unactionable to clean up later.
   */
  it("422s and writes no row when nobody in the tenant can approve", async () => {
    const err = await expectError(() =>
      raise(
        {
          subject_type: "leave_request",
          subject_id: "lv_9",
          requested_by: user.noAdminOperator,
        },
        EMPTY_TENANT_ID,
      ),
    );
    expect(err.code).toBe("no_approver");
    expect(err.httpStatus).toBe(422);

    const rows = await listApprovals(env.DB, EMPTY_TENANT_ID, { limit: 10 });
    expect(rows).toEqual([]);
  });

  it("routes a programmatic caller with no user identity to an admin", async () => {
    // A tenant-API-key caller has no user, so there is no reporting line to
    // start from and nobody to exclude as the requester.
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_10",
      requested_by: null,
    });
    expect(approval.approver_user_id).toBe(user.admin);
    expect(approval.requested_by).toBeNull();
  });

  /**
   * The service rejects reporting cycles on write (`assertNoManagerCycle`), so a
   * cycle here is data inserted around that guard. The walk is depth-bounded
   * exactly like that guard, so it terminates and falls through to the admin
   * rather than spinning.
   */
  it("terminates on a reporting cycle instead of looping", async () => {
    for (const id of ["emp_apr_cycle_a", "emp_apr_cycle_b"]) {
      await env.DB.prepare(
        `INSERT INTO employees (employee_id, tenant_id, name, department_id) VALUES (?, ?, ?, ?)`,
      )
        .bind(id, TENANT_ID, id, "operations")
        .run();
    }
    await env.DB.prepare(
      "UPDATE employees SET manager_employee_id = ? WHERE tenant_id = ? AND employee_id = ?",
    )
      .bind("emp_apr_cycle_b", TENANT_ID, "emp_apr_cycle_a")
      .run();
    await env.DB.prepare(
      "UPDATE employees SET manager_employee_id = ? WHERE tenant_id = ? AND employee_id = ?",
    )
      .bind("emp_apr_cycle_a", TENANT_ID, "emp_apr_cycle_b")
      .run();

    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subjectType: "leave_request",
      requesterUserId: user.operator,
      subjectEmployeeId: "emp_apr_cycle_a",
    });
    // Neither employee in the cycle has a login, so the bounded walk yields
    // nothing and the admin fallback answers.
    expect(resolved?.approver_user_id).toBe(user.admin);
  });
});

// ---------------------------------------------------------------------------
// Per-subject-type strategies, including reserved `invoice` (C5)
// ---------------------------------------------------------------------------

describe("resolution strategies per subject type", () => {
  it("routes a quote to finance or admin rather than up the reporting chain", async () => {
    const { approval, sent } = await raise({
      subject_type: "quote",
      subject_id: "qte_1",
      // The requester has a perfectly good manager; a financial document is
      // still not signed off by their line manager.
      requested_by: user.report,
    });
    expect(approval.approver_user_id).toBe(user.finance);
    expect(sent[0]!.payload).toMatchObject({ resolution_strategy: "role_based" });
  });

  /**
   * SESSION-PLAN C5: `invoice` is in the enum because PRD-000 lists it, but no
   * PRD requests an invoice approval and S4 builds no renderer for it. It is
   * asserted resolvable so that the day something does request one it does not
   * throw on an unmapped subject type.
   */
  it("accepts the reserved `invoice` subject type and resolves it by role", async () => {
    const { approval } = await raise({
      subject_type: "invoice",
      subject_id: "inv_1",
      requested_by: user.report,
    });
    expect(approval.subject_type).toBe("invoice");
    expect(approval.approver_user_id).toBe(user.finance);
  });

  it("rejects an unknown subject type with 400", async () => {
    const err = await expectError(() =>
      raise({
        subject_type: "purchase_order" as "leave_request",
        subject_id: "po_1",
        requested_by: user.report,
      }),
    );
    expect(err.code).toBe("invalid_request");
    expect(err.httpStatus).toBe(400);
    expect(err.message).toContain("purchase_order");
  });

  it("honours an explicitly supplied approver without resolving", async () => {
    const { approval, sent } = await raise({
      subject_type: "expense_claim",
      subject_id: "clm_1",
      requested_by: user.report,
      approver_user_id: user.topboss,
    });
    expect(approval.approver_user_id).toBe(user.topboss);
    expect(sent[0]!.payload).toMatchObject({ resolution_strategy: "explicit" });
  });
});

// ---------------------------------------------------------------------------
// Decisions — terminal, attributed, authorized
// ---------------------------------------------------------------------------

describe("decisions", () => {
  async function pending(subjectId = "lv_dec") {
    return raise({
      subject_type: "leave_request",
      subject_id: subjectId,
      requested_by: user.report,
    });
  }

  /** PRD-000 criterion 1. */
  it("records an approval with actor and timestamp and emits approval.approved", async () => {
    const { approval } = await pending();
    const cap = capturingEnv();
    const decided = await decide(cap.env, TENANT_ID, approval.approval_id, {
      actor_user_id: user.manager,
      actor_role: "operator",
      decision: "approved",
      comment: "Enjoy the break",
    });

    expect(decided.state).toBe("approved");
    expect(decided.decided_by).toBe(user.manager);
    expect(decided.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(decided.decision_comment).toBe("Enjoy the break");

    expect(cap.sent).toHaveLength(1);
    expect(cap.sent[0]!.event_type).toBe("approval.approved");
    expect(cap.sent[0]!.payload).toMatchObject({
      approval_id: approval.approval_id,
      subject_type: "leave_request",
      subject_id: "lv_dec",
      requested_by: user.report,
      approver_user_id: user.manager,
      decided_by: user.manager,
      comment: "Enjoy the break",
    });
  });

  it("records a rejection with its comment and emits approval.rejected", async () => {
    const { approval } = await pending("lv_rej");
    const cap = capturingEnv();
    const decided = await decide(cap.env, TENANT_ID, approval.approval_id, {
      actor_user_id: user.manager,
      decision: "rejected",
      comment: "Clashes with the release",
    });
    expect(decided.state).toBe("rejected");
    expect(decided.decision_comment).toBe("Clashes with the release");
    expect(cap.sent[0]!.event_type).toBe("approval.rejected");
  });

  /** PRD-000 criterion 2: decisions are terminal. */
  it("409s with the current state when a decided approval is decided again", async () => {
    const { approval } = await pending();
    const cap = capturingEnv();
    await decide(cap.env, TENANT_ID, approval.approval_id, {
      actor_user_id: user.manager,
      decision: "approved",
    });

    const err = await expectError(() =>
      decide(cap.env, TENANT_ID, approval.approval_id, {
        actor_user_id: user.manager,
        decision: "approved",
      }),
    );
    expect(err.code).toBe("illegal_transition");
    expect(err.httpStatus).toBe(409);
    expect(err.message).toContain("approved");
    // And no second event: the row did not change, so nothing happened.
    expect(cap.sent).toHaveLength(1);
  });

  it("409s when a rejected approval is later approved", async () => {
    const { approval } = await pending();
    const cap = capturingEnv();
    await decide(cap.env, TENANT_ID, approval.approval_id, {
      actor_user_id: user.manager,
      decision: "rejected",
    });
    const err = await expectError(() =>
      decide(cap.env, TENANT_ID, approval.approval_id, {
        actor_user_id: user.manager,
        decision: "approved",
      }),
    );
    expect(err.httpStatus).toBe(409);
    expect(err.message).toContain("rejected");
  });

  /** PRD-000 criterion 3. */
  it("403s a user who is neither the approver nor an admin", async () => {
    const { approval } = await pending();
    const err = await expectError(() =>
      decide(capturingEnv().env, TENANT_ID, approval.approval_id, {
        actor_user_id: user.operator,
        actor_role: "operator",
        decision: "approved",
      }),
    );
    expect(err.code).toBe("forbidden");
    expect(err.httpStatus).toBe(403);
  });

  it("lets an admin decide an approval assigned to somebody else", async () => {
    const { approval } = await pending();
    const decided = await decide(capturingEnv().env, TENANT_ID, approval.approval_id, {
      actor_user_id: user.admin,
      actor_role: "admin",
      decision: "approved",
    });
    // The assignment is untouched; `decided_by` records who actually acted.
    expect(decided.approver_user_id).toBe(user.manager);
    expect(decided.decided_by).toBe(user.admin);
  });

  it("blocks self-approval for a non-admin even when they are the named approver", async () => {
    // An explicit approver puts the requester on their own request — the one
    // way to reach this state, since resolution refuses to.
    const { approval } = await raise({
      subject_type: "expense_claim",
      subject_id: "clm_self",
      requested_by: user.report,
      approver_user_id: user.report,
    });
    const err = await expectError(() =>
      decide(capturingEnv().env, TENANT_ID, approval.approval_id, {
        actor_user_id: user.report,
        actor_role: "operator",
        decision: "approved",
      }),
    );
    expect(err.code).toBe("forbidden");
    expect(err.message).toContain("your own request");
  });

  /** PRD-000: "self-approval blocked unless the approver holds role admin". */
  it("permits self-approval when the decider holds admin", async () => {
    const { approval } = await raise({
      subject_type: "expense_claim",
      subject_id: "clm_admin_self",
      requested_by: user.admin,
      approver_user_id: user.admin,
    });
    const decided = await decide(capturingEnv().env, TENANT_ID, approval.approval_id, {
      actor_user_id: user.admin,
      actor_role: "admin",
      decision: "approved",
    });
    expect(decided.state).toBe("approved");
    expect(decided.decided_by).toBe(user.admin);
  });

  it("404s a decision on another tenant's approval", async () => {
    const { approval } = await pending();
    const err = await expectError(() =>
      decide(capturingEnv().env, OTHER_TENANT_ID, approval.approval_id, {
        actor_user_id: user.otherAdmin,
        actor_role: "admin",
        decision: "approved",
      }),
    );
    // 404, not 403: the response must not confirm the id exists.
    expect(err.code).toBe("not_found");
    expect(err.httpStatus).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Cancellation — PRD-000 criterion 6
// ---------------------------------------------------------------------------

describe("cancellation", () => {
  it("cancels a pending approval and drops it from pending lists", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_cancel",
      requested_by: user.report,
    });
    const cap = capturingEnv();
    const cancelled = await cancel(cap.env, TENANT_ID, approval.approval_id);

    expect(cancelled.state).toBe("cancelled");
    // Not a decision: nobody decided anything, so the decision fields stay NULL.
    expect(cancelled.decided_by).toBeNull();
    expect(cancelled.decided_at).toBeNull();
    // And no event — the subject module emits its own `*.cancelled`, so a
    // second one here would notify an approver about vanished work.
    expect(cap.sent).toEqual([]);

    const stillPending = await listApprovals(env.DB, TENANT_ID, {
      state: "pending",
      approver_user_id: user.manager,
      limit: 50,
    });
    expect(stillPending.map((a) => a.approval_id)).not.toContain(approval.approval_id);
  });

  it("cancels by subject, which is how a module withdraws its own request", async () => {
    await raise({
      subject_type: "leave_request",
      subject_id: "lv_by_subject",
      requested_by: user.report,
    });
    const cancelled = await cancelForSubject(
      capturingEnv().env,
      TENANT_ID,
      "leave_request",
      "lv_by_subject",
    );
    expect(cancelled?.state).toBe("cancelled");

    // Nothing pending left to cancel — a no-op, not an error.
    expect(
      await cancelForSubject(capturingEnv().env, TENANT_ID, "leave_request", "lv_by_subject"),
    ).toBeNull();
  });

  it("409s when cancelling an already-decided approval", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_decided",
      requested_by: user.report,
    });
    const cap = capturingEnv();
    await decide(cap.env, TENANT_ID, approval.approval_id, {
      actor_user_id: user.manager,
      decision: "approved",
    });
    const err = await expectError(() => cancel(cap.env, TENANT_ID, approval.approval_id));
    expect(err.httpStatus).toBe(409);
  });

  it("409s when deciding a cancelled approval", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_cancelled_then_decided",
      requested_by: user.report,
    });
    const cap = capturingEnv();
    await cancel(cap.env, TENANT_ID, approval.approval_id);
    const err = await expectError(() =>
      decide(cap.env, TENANT_ID, approval.approval_id, {
        actor_user_id: user.manager,
        decision: "approved",
      }),
    );
    expect(err.httpStatus).toBe(409);
    expect(err.message).toContain("cancelled");
  });
});

// ---------------------------------------------------------------------------
// Resubmission — SESSION-PLAN C8
// ---------------------------------------------------------------------------

describe("resubmission after rejection (C8)", () => {
  /**
   * PRD-006 answers PRD-000's open question for claims: rejection returns the
   * subject to the requester and resubmission is allowed. The primitive models
   * that with a new row and no new column — the subject owns its own history,
   * so nothing here needs a `supersedes` link. Pinned as a test so S4 can see
   * the behaviour before deciding whether the inbox wants that linkage.
   */
  it("creates a new pending row and leaves the rejected one rejected", async () => {
    const first = await raise({
      subject_type: "expense_claim",
      subject_id: "clm_resub",
      requested_by: user.report,
    });
    const cap = capturingEnv();
    await decide(cap.env, TENANT_ID, first.approval.approval_id, {
      actor_user_id: user.manager,
      decision: "rejected",
      comment: "Receipt is illegible",
    });

    const second = await raise({
      subject_type: "expense_claim",
      subject_id: "clm_resub",
      requested_by: user.report,
    });

    expect(second.approval.approval_id).not.toBe(first.approval.approval_id);
    expect(second.approval.state).toBe("pending");

    const original = await getApproval(env.DB, TENANT_ID, first.approval.approval_id);
    expect(original!.state).toBe("rejected");
    expect(original!.decision_comment).toBe("Receipt is illegible");

    // Both rows survive against the same subject: that IS the history.
    const all = await listApprovals(env.DB, TENANT_ID, {
      subject_type: "expense_claim",
      subject_id: "clm_resub",
      limit: 50,
    });
    expect(all).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency", () => {
  it("returns the existing approval for a repeated idempotency key", async () => {
    const input = {
      subject_type: "expense_claim" as const,
      subject_id: "clm_idem",
      requested_by: user.report,
      idempotency_key: "claim-clm_idem-submit",
    };
    const first = await raise(input);
    const second = await raise(input);

    expect(second.approval.approval_id).toBe(first.approval.approval_id);
    // No second request event, or the approver is notified twice for one claim.
    expect(second.sent).toEqual([]);

    const all = await listApprovals(env.DB, TENANT_ID, {
      subject_type: "expense_claim",
      subject_id: "clm_idem",
      limit: 50,
    });
    expect(all).toHaveLength(1);
  });

  it("keys idempotency per tenant, so the same key in another tenant is a new row", async () => {
    const key = "shared-key-across-tenants";
    const mine = await raise({
      subject_type: "leave_request",
      subject_id: "lv_idem",
      requested_by: user.report,
      idempotency_key: key,
    });
    const theirs = await raise(
      { subject_type: "leave_request", subject_id: "lv_idem", requested_by: null, idempotency_key: key },
      OTHER_TENANT_ID,
    );
    expect(theirs.approval.approval_id).not.toBe(mine.approval.approval_id);
    expect(theirs.approval.approver_user_id).toBe(user.otherAdmin);
  });
});

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

describe("HTTP surface", () => {
  it("lists only the caller's queue for ?mine=true, oldest first", async () => {
    // Two for the manager, one for the director — the director's must not leak.
    await raise({ subject_type: "leave_request", subject_id: "lv_h1", requested_by: user.report });
    await raise({ subject_type: "leave_request", subject_id: "lv_h2", requested_by: user.report });
    await raise({ subject_type: "leave_request", subject_id: "lv_h3", requested_by: user.staff });

    const session = await login("manager@approvals.test", "manager-password");
    const res = await fetchWorker("/v1/approvals?mine=true&state=pending", {
      headers: { Cookie: session.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Approval[]; next_cursor: string | null };

    expect(body.items.map((a) => a.subject_id)).toEqual(["lv_h1", "lv_h2"]);
    expect(body.items.every((a) => a.approver_user_id === user.manager)).toBe(true);
    // ULID ids sort chronologically, so this is oldest-first — what PRD-007's
    // inbox wants, because the longest wait is the most likely blocker.
    expect(body.items[0]!.approval_id < body.items[1]!.approval_id).toBe(true);
  });

  it("lists the caller's own requests for ?requester=me", async () => {
    await raise({ subject_type: "leave_request", subject_id: "lv_mine", requested_by: user.report });
    await raise({ subject_type: "leave_request", subject_id: "lv_theirs", requested_by: user.staff });

    const session = await login("report@approvals.test", "report-password");
    const res = await fetchWorker("/v1/approvals?requester=me", {
      headers: { Cookie: session.cookie },
    });
    const body = (await res.json()) as { items: Approval[] };
    expect(body.items.map((a) => a.subject_id)).toEqual(["lv_mine"]);
  });

  it("400s ?mine=true for a tenant-API-key caller, which has no user identity", async () => {
    const res = await fetchWorker("/v1/approvals?mine=true", { headers: bearer });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      code: "invalid_request",
    });
  });

  it("approves over HTTP and 409s the second attempt", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_http_ok",
      requested_by: user.report,
    });
    const session = await login("manager@approvals.test", "manager-password");

    const first = await fetchWorker(`/v1/approvals/${approval.approval_id}/approve`, {
      method: "POST",
      headers: sessionHeaders(session),
      body: JSON.stringify({ comment: "Approved" }),
    });
    expect(first.status).toBe(200);
    expect((await first.json()) as Approval).toMatchObject({
      state: "approved",
      decided_by: user.manager,
      decision_comment: "Approved",
    });

    const second = await fetchWorker(`/v1/approvals/${approval.approval_id}/approve`, {
      method: "POST",
      headers: sessionHeaders(session),
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(409);
    expect((await second.json()) as { code: string }).toMatchObject({
      code: "illegal_transition",
    });
  });

  it("rejects over HTTP with no comment, because the primitive does not require one", async () => {
    // PRD-000 says the comment is optional; PRD-007's console requires it on
    // reject and enforces that client-side, so a programmatic caller is not
    // blocked by a UI rule.
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_http_reject",
      requested_by: user.report,
    });
    const session = await login("manager@approvals.test", "manager-password");
    const res = await fetchWorker(`/v1/approvals/${approval.approval_id}/reject`, {
      method: "POST",
      headers: sessionHeaders(session),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Approval).toMatchObject({
      state: "rejected",
      decision_comment: null,
    });
  });

  it("403s a decision from a user who is neither approver nor admin", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_http_403",
      requested_by: user.report,
    });
    const session = await login("operator@approvals.test", "operator-password");
    const res = await fetchWorker(`/v1/approvals/${approval.approval_id}/approve`, {
      method: "POST",
      headers: sessionHeaders(session),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it("404s across tenants on read and on decide", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_http_iso",
      requested_by: user.report,
    });
    const otherSession = await login(
      "admin@other-approvals.test",
      "other-admin-password",
      OTHER_WORKSPACE,
    );

    const read = await fetchWorker(`/v1/approvals/${approval.approval_id}`, {
      headers: { Cookie: otherSession.cookie },
    });
    expect(read.status).toBe(404);

    const act = await fetchWorker(`/v1/approvals/${approval.approval_id}/approve`, {
      method: "POST",
      headers: sessionHeaders(otherSession),
      body: JSON.stringify({}),
    });
    expect(act.status).toBe(404);
  });

  it("never returns another tenant's rows in a list", async () => {
    await raise({ subject_type: "leave_request", subject_id: "lv_iso_a", requested_by: user.report });
    await raise(
      { subject_type: "leave_request", subject_id: "lv_iso_b", requested_by: null },
      OTHER_TENANT_ID,
    );

    const res = await fetchWorker("/v1/approvals", {
      headers: { Authorization: `Bearer ${OTHER_API_KEY}` },
    });
    const body = (await res.json()) as { items: Approval[] };
    expect(body.items.map((a) => a.subject_id)).toEqual(["lv_iso_b"]);
    expect(body.items.every((a) => a.tenant_id === OTHER_TENANT_ID)).toBe(true);
  });

  it("lets a requester cancel their own pending request but not an approver", async () => {
    const { approval } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_http_cancel",
      requested_by: user.report,
    });

    // The approver cannot duck a request by cancelling it — they must decide.
    const approver = await login("manager@approvals.test", "manager-password");
    const refused = await fetchWorker(`/v1/approvals/${approval.approval_id}/cancel`, {
      method: "POST",
      headers: sessionHeaders(approver),
    });
    expect(refused.status).toBe(403);

    const requester = await login("report@approvals.test", "report-password");
    const ok = await fetchWorker(`/v1/approvals/${approval.approval_id}/cancel`, {
      method: "POST",
      headers: sessionHeaders(requester),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()) as Approval).toMatchObject({ state: "cancelled" });
  });

  it("400s an unknown state filter rather than silently ignoring it", async () => {
    const res = await fetchWorker("/v1/approvals?state=maybe", { headers: bearer });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Event registration
// ---------------------------------------------------------------------------

describe("event registration", () => {
  it("emits approval.requested with everything the notification consumer needs", async () => {
    const { approval, sent } = await raise({
      subject_type: "leave_request",
      subject_id: "lv_evt",
      requested_by: user.report,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.event_type).toBe("approval.requested");
    expect(sent[0]!.source_module).toBe("platform");
    expect(sent[0]!.payload).toMatchObject({
      approval_id: approval.approval_id,
      subject_type: "leave_request",
      subject_id: "lv_evt",
      requested_by: user.report,
      approver_user_id: user.manager,
    });
  });

  it("registers all three payloads in the schema registry", async () => {
    // An unregistered event type is a hard failure in the consumer, so the
    // emitted payloads are validated against the registry exactly as it will.
    const requested = await raise({
      subject_type: "leave_request",
      subject_id: "lv_reg",
      requested_by: user.report,
    });
    expect(validatePayload("approval.requested", requested.sent[0]!.payload)).toEqual({ ok: true });

    for (const decision of ["approved", "rejected"] as const) {
      const { approval } = await raise({
        subject_type: "leave_request",
        subject_id: `lv_reg_${decision}`,
        requested_by: user.report,
      });
      const cap = capturingEnv();
      await decide(cap.env, TENANT_ID, approval.approval_id, {
        actor_user_id: user.manager,
        decision,
        comment: "noted",
      });
      expect(validatePayload(`approval.${decision}`, cap.sent[0]!.payload)).toEqual({ ok: true });
    }
  });

  /**
   * The free-plan inline path. S4 owns the notification-consumer test, but the
   * events have to survive the real consumer first: an unregistered type or a
   * payload the registry rejects is dropped silently on this path (no retry, no
   * DLQ), which would be a missing notification nobody sees.
   */
  it("survives the queue-less consumer path and lands in events_log", async () => {
    const bare = { ...(env as unknown as Env) };
    delete (bare as { EVENTS?: Queue }).EVENTS;
    const inline = ensureEventBus(bare);

    const approval = await requestApproval(inline, TENANT_ID, {
      subject_type: "leave_request",
      subject_id: "lv_inline",
      requested_by: user.report,
    });
    await decide(inline, TENANT_ID, approval.approval_id, {
      actor_user_id: user.manager,
      decision: "approved",
    });

    const { results } = await env.DB.prepare(
      `SELECT event_type FROM events_log
       WHERE tenant_id = ? AND event_type LIKE 'approval.%' ORDER BY event_id ASC`,
    )
      .bind(TENANT_ID)
      .all<{ event_type: string }>();
    expect(results!.map((r) => r.event_type)).toEqual([
      "approval.requested",
      "approval.approved",
    ]);
  });
});

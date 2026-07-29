import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { resolveApprover } from "../src/modules/approvals/resolver";

/**
 * Approver resolution (PRD-008 § the employee↔user↔approver interaction, ahead
 * of PRD-000's approvals table).
 *
 * Both strategies have to work and they route through different graphs: leave
 * and claims climb the employee reporting line, quotes and invoices go to
 * whoever holds the money. The cases that matter are the joins between the two
 * models — a manager with no login, a manager who has left, a requester who is
 * their own approver, and a tenant with nobody but one admin.
 */

const TENANT_ID = "biz_appr";
const SOLO_TENANT_ID = "biz_appr_solo";
const BARE_TENANT_ID = "biz_appr_bare";
const PAIR_TENANT_ID = "biz_appr_pair";

const userIds = new Map<string, string>();
/** Seeded user id by key. `noUncheckedIndexedAccess` makes the map lookup
 * optional, and every id here is seeded in beforeAll, so assert it once. */
const uid = (key: string): string => userIds.get(key)!;

async function seedTenant(tenantId: string, slug: string, key: string): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(tenantId, slug, slug, await sha256Hex(key))
    .run();
}

async function seedUser(
  tenantId: string,
  key: string,
  role: "admin" | "operator" | "finance" | "employee",
  status: "active" | "disabled" = "active",
): Promise<string> {
  const user = await createUser(env.DB, {
    tenant_id: tenantId,
    email: `${key}@appr.test`,
    password: "approver-password",
    role,
  });
  if (status === "disabled") {
    await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE user_id = ?")
      .bind(user.user_id)
      .run();
  }
  userIds.set(key, user.user_id);
  return user.user_id;
}

async function seedEmployee(input: {
  id: string;
  name: string;
  manager?: string;
  user?: string;
  status?: "active" | "inactive";
  tenant?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO employees (employee_id, tenant_id, name, department_id, manager_employee_id,
                            user_id, status)
     VALUES (?, ?, ?, 'people', ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.tenant ?? TENANT_ID,
      input.name,
      input.manager ?? null,
      input.user ?? null,
      input.status ?? "active",
    )
    .run();
}

beforeAll(async () => {
  await seedTenant(TENANT_ID, "appr-co", "test_api_key_appr");
  await seedTenant(SOLO_TENANT_ID, "appr-solo", "test_api_key_appr_solo");
  await seedTenant(BARE_TENANT_ID, "appr-bare", "test_api_key_appr_bare");

  await seedUser(TENANT_ID, "admin", "admin");
  await seedUser(TENANT_ID, "finance", "finance");
  await seedUser(TENANT_ID, "operator", "operator");
  await seedUser(TENANT_ID, "ic", "employee");
  await seedUser(TENANT_ID, "lead", "employee");
  await seedUser(TENANT_ID, "head", "operator");
  await seedUser(TENANT_ID, "gone", "employee");
  await seedUser(TENANT_ID, "locked", "employee", "disabled");
  await seedUser(TENANT_ID, "loginless", "employee");

  // head (login) ← lead (login) ← ic (login)
  await seedEmployee({ id: "emp_head", name: "Head", user: uid("head") });
  await seedEmployee({ id: "emp_lead", name: "Lead", manager: "emp_head", user: uid("lead") });
  await seedEmployee({ id: "emp_ic", name: "IC", manager: "emp_lead", user: uid("ic") });

  // head ← manager with no console login ← report
  await seedEmployee({ id: "emp_nologin", name: "No Login", manager: "emp_head" });
  await seedEmployee({ id: "emp_under_nologin", name: "Under NoLogin", manager: "emp_nologin", user: uid("loginless") });

  // head ← manager who has left the company ← report
  await seedEmployee({ id: "emp_left", name: "Departed", manager: "emp_head", user: uid("gone"), status: "inactive" });
  await seedEmployee({ id: "emp_under_left", name: "Under Departed", manager: "emp_left", user: uid("operator") });

  // head ← manager whose login is disabled ← report
  await seedEmployee({ id: "emp_locked", name: "Locked Out", manager: "emp_head", user: uid("locked") });
  await seedEmployee({ id: "emp_under_locked", name: "Under Locked", manager: "emp_locked", user: uid("finance") });

  // Nobody above them at all.
  await seedEmployee({ id: "emp_orphan", name: "Orphan", user: uid("admin") });

  // A one-person company: a single admin, who is also the employee.
  const soloAdmin = await seedUser(SOLO_TENANT_ID, "solo", "admin");
  await seedEmployee({ id: "emp_solo", name: "Solo Founder", user: soloAdmin, tenant: SOLO_TENANT_ID });
});

describe("manager-chain strategy (leave and claims)", () => {
  it("routes a leave request to the requester's manager", async () => {
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      requested_by_user_id: uid("ic"),
    });
    expect(resolved).toEqual({ approver_user_id: uid("lead"), strategy: "manager_chain" });
  });

  it("uses the same strategy for an expense claim", async () => {
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "expense_claim",
      requested_by_user_id: uid("ic"),
    });
    expect(resolved?.strategy).toBe("manager_chain");
    expect(resolved?.approver_user_id).toBe(uid("lead"));
  });

  it("climbs past a manager who has no console login", async () => {
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      requested_by_user_id: uid("loginless"),
    });
    expect(resolved).toEqual({ approver_user_id: uid("head"), strategy: "manager_chain" });
  });

  it("climbs past a manager who has left the company", async () => {
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      requested_by_user_id: uid("operator"),
    });
    expect(resolved).toEqual({ approver_user_id: uid("head"), strategy: "manager_chain" });
  });

  it("climbs past a manager whose login is disabled", async () => {
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      requested_by_user_id: uid("finance"),
    });
    expect(resolved).toEqual({ approver_user_id: uid("head"), strategy: "manager_chain" });
  });

  it("falls back to an admin when the employee has no manager", async () => {
    // The orphan here *is* the admin, and is the only admin — the one case where
    // self-approval is permitted, because otherwise nobody could ever decide it.
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      requested_by_user_id: uid("admin"),
    });
    expect(resolved).toEqual({ approver_user_id: uid("admin"), strategy: "admin_fallback" });
  });

  it("falls back to an admin when the requester has no employee record", async () => {
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "leave_request",
      requested_by_user_id: uid("head"),
    });
    expect(resolved).toEqual({ approver_user_id: uid("admin"), strategy: "admin_fallback" });
  });

  // The chain can never hand someone their own request, because one login
  // cannot be two employee records (idx_employees_user). Asserting the invariant
  // documents *why* the manager strategy needs no self-approval check of its
  // own — the resolver keeps a defensive skip in case that ever changes.
  it("cannot route to the requester: one login is at most one employee record", async () => {
    await expect(
      seedEmployee({ id: "emp_second_seat", name: "Second Seat", manager: "emp_head", user: uid("ic") }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("prefers another admin over the requester on the admin fallback", async () => {
    // Two admins, no reporting line: the requester must not be their own
    // approver when someone else can decide (PRD-000: self-approval blocked
    // unless there is genuinely nobody else).
    await seedTenant(PAIR_TENANT_ID, "appr-pair", "test_api_key_appr_pair");
    const first = await seedUser(PAIR_TENANT_ID, "pair-admin-a", "admin");
    const second = await seedUser(PAIR_TENANT_ID, "pair-admin-b", "admin");
    await seedEmployee({ id: "emp_pair_a", name: "Admin A", user: first, tenant: PAIR_TENANT_ID });

    const resolved = await resolveApprover(env.DB, PAIR_TENANT_ID, {
      subject_type: "leave_request",
      requested_by_user_id: first,
    });
    expect(resolved).toEqual({ approver_user_id: second, strategy: "admin_fallback" });
  });
});

describe("role-based strategy (quotes and invoices)", () => {
  it("routes a quote to the finance role ahead of an admin", async () => {
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "quote",
      requested_by_user_id: uid("operator"),
    });
    expect(resolved).toEqual({ approver_user_id: uid("finance"), strategy: "role_based" });
  });

  it("routes an invoice the same way", async () => {
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "invoice",
      requested_by_user_id: uid("ic"),
    });
    expect(resolved?.strategy).toBe("role_based");
    expect(resolved?.approver_user_id).toBe(uid("finance"));
  });

  it("routes past a finance requester to the next eligible approver", async () => {
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "quote",
      requested_by_user_id: uid("finance"),
    });
    expect(resolved).toEqual({
      approver_user_id: uid("admin"),
      strategy: "role_based",
      skipped_self: true,
    });
  });

  it("does not use the employee reporting line for money decisions", async () => {
    // The IC has a manager, but a quote is not their manager's call.
    const resolved = await resolveApprover(env.DB, TENANT_ID, {
      subject_type: "quote",
      requested_by_user_id: uid("ic"),
    });
    expect(resolved?.approver_user_id).not.toBe(uid("lead"));
  });

  it("permits the sole admin of a one-person company to approve their own quote", async () => {
    const resolved = await resolveApprover(env.DB, SOLO_TENANT_ID, {
      subject_type: "quote",
      requested_by_user_id: uid("solo"),
    });
    expect(resolved).toEqual({ approver_user_id: uid("solo"), strategy: "admin_fallback" });
  });
});

describe("nowhere to route", () => {
  it("returns null rather than auto-approving when the tenant has no eligible approver", async () => {
    const orphanUser = await seedUser(BARE_TENANT_ID, "bare-operator", "operator");
    for (const subject of ["leave_request", "quote"] as const) {
      expect(
        await resolveApprover(env.DB, BARE_TENANT_ID, {
          subject_type: subject,
          requested_by_user_id: orphanUser,
        }),
      ).toBeNull();
    }
  });

  it("stays tenant-scoped: an approver in another company is never chosen", async () => {
    const resolved = await resolveApprover(env.DB, SOLO_TENANT_ID, {
      subject_type: "leave_request",
      requested_by_user_id: uid("solo"),
    });
    expect(resolved?.approver_user_id).toBe(uid("solo"));
    expect(resolved?.approver_user_id).not.toBe(uid("admin"));
  });
});

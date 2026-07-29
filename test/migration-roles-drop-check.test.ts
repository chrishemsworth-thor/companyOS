import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { sha256Hex } from "../src/gateway/middleware/auth";

/**
 * Migration 0022_roles_drop_check — the `users` rebuild.
 *
 * ## Why this file exists
 *
 * The first version of that migration passed CI and every fresh database, and
 * failed on every database that had data in it: D1 refuses to drop a table while
 * rows in other tables reference it, and `users` is referenced from seven
 * places. It could not be applied to production at all.
 *
 * The test suite could not have caught it. `applyD1Migrations` runs against an
 * empty database, where a `DROP TABLE users` has no referencing rows to object
 * to — the exact blind spot that let it through.
 *
 * So this file does not test the migration by running it (it has already run by
 * the time any test executes). It asserts the *properties the migration was
 * supposed to produce*, on a database with real referencing rows in it. If
 * somebody rebuilds `users` again and drops an index, loses the FK, or
 * reinstates the CHECK, these fail.
 *
 * The one thing genuinely not covered here is the migration's own data-preserving
 * behaviour on a populated database — the stash-and-restore of
 * `employees.user_id`, `google_accounts`, and `approvals`. Verifying that needs a
 * pre-0022 database, which the harness cannot produce. It was verified manually
 * against local D1 via `wrangler d1 migrations apply` on a populated database;
 * the recipe is in docs/running-locally.md.
 */

const TENANT_ID = "biz_mig22";
const API_KEY = "test_api_key_mig22";

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)",
  )
    .bind(TENANT_ID, "Migration 22 Tenant", "mig22-co", await sha256Hex(API_KEY))
    .run();
});

async function usersDdl(): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'",
  ).first<{ sql: string }>();
  return row?.sql ?? "";
}

describe("the users table after the rebuild", () => {
  it("carries no CHECK on role, so a new role costs no migration", async () => {
    // The entire point of 0022. `src/auth/roles.ts` is the vocabulary now.
    expect(await usersDdl()).not.toMatch(/CHECK\s*\(\s*role/i);
  });

  it("accepts a role the old CHECK would have rejected", async () => {
    // `employee` is PRD-008's self-service tier and did not exist in the old
    // constraint. This insert is what used to fail.
    await env.DB.prepare(
      "INSERT INTO users (user_id, tenant_id, email, role) VALUES (?, ?, ?, ?)",
    )
      .bind("usr_mig22_emp", TENANT_ID, "emp@mig22.test", "employee")
      .run();

    const row = await env.DB.prepare("SELECT role FROM users WHERE user_id = ?")
      .bind("usr_mig22_emp")
      .first<{ role: string }>();
    expect(row?.role).toBe("employee");
  });

  it("defaults an unspecified role to the least-privilege tier", async () => {
    // A row written without a role must never come out business-capable.
    await env.DB.prepare("INSERT INTO users (user_id, tenant_id, email) VALUES (?, ?, ?)")
      .bind("usr_mig22_default", TENANT_ID, "default@mig22.test")
      .run();

    const row = await env.DB.prepare("SELECT role FROM users WHERE user_id = ?")
      .bind("usr_mig22_default")
      .first<{ role: string }>();
    expect(row?.role).toBe("employee");
  });

  it("kept the constraints that were not the target", async () => {
    const ddl = await usersDdl();
    expect(ddl).toMatch(/CHECK\s*\(\s*cred_type/i);
    expect(ddl).toMatch(/CHECK\s*\(\s*status/i);
    expect(ddl).toMatch(/REFERENCES tenants\(tenant_id\)/i);
  });

  it("still has both indexes the old table carried", async () => {
    // DROP TABLE takes indexes with it. Losing idx_users_email_tenant would let
    // two accounts share an email inside one tenant, which login resolves by.
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'users' AND name NOT LIKE 'sqlite_%'",
    ).all<{ name: string }>();
    expect((results ?? []).map((r) => r.name).sort()).toEqual([
      "idx_users_email_tenant",
      "idx_users_tenant",
    ]);
  });

  it("still enforces one email per tenant", async () => {
    await env.DB.prepare("INSERT INTO users (user_id, tenant_id, email) VALUES (?, ?, ?)")
      .bind("usr_mig22_first", TENANT_ID, "dup@mig22.test")
      .run();

    await expect(
      env.DB.prepare("INSERT INTO users (user_id, tenant_id, email) VALUES (?, ?, ?)")
        .bind("usr_mig22_second", TENANT_ID, "dup@mig22.test")
        .run(),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("leaves no migration scratch tables behind", async () => {
    // The rebuild stashes referencing values in `_mig22_*` tables and drops them
    // at the end. One left behind would mean the migration exited early.
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE name LIKE '_mig22%'",
    ).all<{ name: string }>();
    expect(results ?? []).toEqual([]);
  });
});

describe("the foreign keys into users still work", () => {
  // The migration drops and recreates `users`, so every child FK is re-resolved
  // by name. If the rename had not rewired them, these would silently stop
  // enforcing — the failure mode that is invisible until bad data appears.

  it("rejects an approval whose approver is not a real user", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO approvals (approval_id, tenant_id, subject_type, subject_id, approver_user_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind("apr_mig22_orphan", TENANT_ID, "quote", "qte_1", "usr_does_not_exist")
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("rejects a notification addressed to a user that does not exist", async () => {
    // notifications is created by 0023, after the rebuild — so this also proves
    // the table that arrives later binds to the rebuilt users correctly.
    await expect(
      env.DB.prepare(
        `INSERT INTO notifications
           (notification_id, tenant_id, user_id, type, subject_type, subject_id, title, dedupe_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind("ntf_mig22", TENANT_ID, "usr_does_not_exist", "approval.requested", "quote", "q", "t", "k")
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("accepts the same rows once the user exists", async () => {
    await env.DB.prepare("INSERT INTO users (user_id, tenant_id, email) VALUES (?, ?, ?)")
      .bind("usr_mig22_real", TENANT_ID, "real@mig22.test")
      .run();

    await env.DB.prepare(
      `INSERT INTO approvals (approval_id, tenant_id, subject_type, subject_id, approver_user_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind("apr_mig22_ok", TENANT_ID, "quote", "qte_2", "usr_mig22_real")
      .run();

    const row = await env.DB.prepare(
      "SELECT approver_user_id FROM approvals WHERE approval_id = ?",
    )
      .bind("apr_mig22_ok")
      .first<{ approver_user_id: string }>();
    expect(row?.approver_user_id).toBe("usr_mig22_real");
  });

  it("still allows employees with no console login", async () => {
    // `employees.user_id` is nullable, and the migration nulls it wholesale
    // before restoring. If the rebuild had made it NOT NULL, every employee
    // without a login would have become unrepresentable.
    await env.DB.prepare(
      `INSERT INTO employees (employee_id, tenant_id, name, department_id, user_id)
       VALUES (?, ?, ?, ?, NULL)`,
    )
      .bind("emp_mig22_nologin", TENANT_ID, "No Login", "operations")
      .run();

    const row = await env.DB.prepare(
      "SELECT user_id FROM employees WHERE employee_id = ?",
    )
      .bind("emp_mig22_nologin")
      .first<{ user_id: string | null }>();
    expect(row?.user_id).toBeNull();
  });
});

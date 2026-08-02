import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { sha256Hex } from "../src/gateway/middleware/auth";

/**
 * Migration 0027_crm_depth — the contact-roles half.
 *
 * ## What this file can and cannot test
 *
 * `applyD1Migrations` runs against an EMPTY database, so 0027's backfill has no
 * rows to act on by the time any test executes — the same blind spot
 * `test/migration-roles-drop-check.test.ts` documents for 0022. So, following
 * that precedent, this file asserts the *properties the migration was supposed
 * to produce*, on a database with real rows in it:
 *
 *   1. the schema objects exist and are shaped as intended;
 *   2. the "exactly one primary per customer" guarantee is actually enforced by
 *      the database and not only by the service;
 *   3. the backfill's ranking rule picks the contact the PRD says it should,
 *      in all three states a pre-0027 database can be in (no contact flagged,
 *      one flagged, several flagged — nothing enforced it before now).
 *
 * (3) re-runs the ranking expression from the migration against fixture rows.
 * It is a transcription, so it can drift from the migration; the guard against
 * that is that (1) and (2) fail loudly if the schema half is ever changed, and
 * `test/contact-roles.test.ts` covers the rule the service applies to new rows.
 */

const TENANT_ID = "biz_mig27";
const API_KEY = "test_api_key_mig27";

/** Direct inserts, bypassing the service — the pre-0027 shape had no roles. */
async function seedContact(
  customerId: string,
  contactId: string,
  opts: { isPrimary?: boolean; createdAt: string },
) {
  await env.DB.prepare(
    `INSERT INTO contacts (contact_id, tenant_id, customer_id, name, is_primary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(contactId, TENANT_ID, customerId, contactId, opts.isPrimary ? 1 : 0, opts.createdAt)
    .run();
}

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Migration 27 Tenant", await sha256Hex(API_KEY))
    .run();
  for (const id of ["cust_mig27_none", "cust_mig27_one", "cust_mig27_many"]) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO customers (customer_id, tenant_id, name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(id, TENANT_ID, id, "2026-01-01T00:00:00.000Z")
      .run();
  }
});

// The ROW_NUMBER expression transcribed from migrations/0027_crm_depth.sql.
const RANKING = `
  SELECT contact_id, ROW_NUMBER() OVER (
           PARTITION BY tenant_id, customer_id
           ORDER BY is_primary DESC, created_at, contact_id
         ) AS rn
    FROM contacts
   WHERE tenant_id = ? AND customer_id = ?`;

async function rankedFirst(customerId: string): Promise<string | null> {
  const { results } = await env.DB.prepare(RANKING)
    .bind(TENANT_ID, customerId)
    .all<{ contact_id: string; rn: number }>();
  return results.find((r) => r.rn === 1)?.contact_id ?? null;
}

describe("the schema 0027 produces", () => {
  it("created contact_roles with a composite tenant-scoped key", async () => {
    const row = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contact_roles'",
    ).first<{ sql: string }>();
    expect(row?.sql).toBeTruthy();
    expect(row!.sql).toMatch(/PRIMARY KEY \(tenant_id, contact_id, role\)/i);
    expect(row!.sql).toMatch(/REFERENCES contacts\(tenant_id, contact_id\)/i);
  });

  it("carries NO CHECK on role, so adding one costs no migration", async () => {
    // The deliberate divergence, same reasoning as approvals.subject_type in
    // 0022. src/modules/crm/contact-roles.ts owns the vocabulary.
    const row = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contact_roles'",
    ).first<{ sql: string }>();
    expect(row!.sql).not.toMatch(/CHECK\s*\(\s*role/i);
  });

  it("indexed the resolveContact lookup", async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_contact_roles_role'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("idx_contact_roles_role");
  });

  it("added the delivery audit column", async () => {
    const { results } = await env.DB.prepare("PRAGMA table_info(deliveries)").all<{ name: string }>();
    expect(results.map((r) => r.name)).toContain("contact_id");
  });
});

describe("'exactly one is_primary per customer' is enforced by the database", () => {
  it("rejects a second primary at the storage layer, not just in the service", async () => {
    await seedContact("cust_mig27_one", "contact_mig27_a", {
      isPrimary: true,
      createdAt: "2026-02-01T00:00:00.000Z",
    });

    await expect(
      seedContact("cust_mig27_one", "contact_mig27_b", {
        isPrimary: true,
        createdAt: "2026-03-01T00:00:00.000Z",
      }),
    ).rejects.toThrow(/UNIQUE/i);
  });

  it("allows any number of NON-primary contacts", async () => {
    await seedContact("cust_mig27_one", "contact_mig27_c", {
      createdAt: "2026-02-02T00:00:00.000Z",
    });
    await seedContact("cust_mig27_one", "contact_mig27_d", {
      createdAt: "2026-02-03T00:00:00.000Z",
    });
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ? AND customer_id = ?",
    )
      .bind(TENANT_ID, "cust_mig27_one")
      .first<{ n: number }>();
    expect(row!.n).toBe(2);
  });

  it("scopes the constraint per customer, so two customers each keep a primary", async () => {
    await seedContact("cust_mig27_none", "contact_mig27_p1", {
      isPrimary: true,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    await seedContact("cust_mig27_many", "contact_mig27_p2", {
      isPrimary: true,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ? AND is_primary = 1",
    )
      .bind(TENANT_ID)
      .first<{ n: number }>();
    expect(row!.n).toBe(2);
  });
});

describe("the backfill's ranking rule", () => {
  it("picks the EARLIEST by created_at when nothing was flagged", async () => {
    // PRD-003's stated default: "primary on the first (by created_at)".
    await seedContact("cust_mig27_none", "contact_mig27_late", {
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    await seedContact("cust_mig27_none", "contact_mig27_early", {
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await rankedFirst("cust_mig27_none")).toBe("contact_mig27_early");
  });

  it("keeps an EXPLICITLY flagged primary even when it is not the earliest", async () => {
    // The deliberate divergence from the brief's letter: honouring a flag
    // somebody set on purpose is closer to "a safe default, not a guess at
    // intent" than overwriting it with whoever was created first.
    await seedContact("cust_mig27_one", "contact_mig27_oldest", {
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await seedContact("cust_mig27_one", "contact_mig27_flagged", {
      isPrimary: true,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    expect(await rankedFirst("cust_mig27_one")).toBe("contact_mig27_flagged");
  });

  it("breaks a created_at tie deterministically on the ULID", async () => {
    // Nothing stopped two contacts sharing a timestamp before 0027, and a
    // non-deterministic backfill would give different tenants different results
    // on re-run.
    const sameMoment = "2026-04-04T00:00:00.000Z";
    await seedContact("cust_mig27_many", "contact_mig27_zzz", { createdAt: sameMoment });
    await seedContact("cust_mig27_many", "contact_mig27_aaa", { createdAt: sameMoment });
    expect(await rankedFirst("cust_mig27_many")).toBe("contact_mig27_aaa");
  });

  it("ranks every other contact behind the chosen one, so they all become 'other'", async () => {
    // Isolated storage rolls back between tests, so this seeds its own three.
    await seedContact("cust_mig27_none", "contact_mig27_w", {
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    await seedContact("cust_mig27_none", "contact_mig27_x", {
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    await seedContact("cust_mig27_none", "contact_mig27_y", {
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const { results } = await env.DB.prepare(RANKING)
      .bind(TENANT_ID, "cust_mig27_none")
      .all<{ contact_id: string; rn: number }>();
    expect(results.filter((r) => r.rn === 1).map((r) => r.contact_id)).toEqual([
      "contact_mig27_w",
    ]);
    expect(results.filter((r) => r.rn > 1).map((r) => r.contact_id).sort()).toEqual([
      "contact_mig27_x",
      "contact_mig27_y",
    ]);
  });
});

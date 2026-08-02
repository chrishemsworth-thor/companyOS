import { z } from "zod";
import type { Contact, ContactRole } from "./types";

/**
 * PRD-003 P0 — contact roles and the resolution chain.
 *
 * A contact is no longer undifferentiated: Aina signs quotes, Ravi pays
 * invoices, Wei Ming is the day-to-day user. Roles are a join table
 * (`contact_roles`, migration 0027) rather than a column on `contacts`,
 * because the relationship is many-to-many in both directions and
 * `resolveContact` is an indexed lookup by role.
 *
 * ## The `is_primary` invariant
 *
 * PRD-003 asks for BOTH a `primary` role and an `is_primary` flag. They are one
 * fact, so this module holds them equal: `contacts.is_primary = 1` if and only
 * if the contact holds the `primary` role. `normalizeRoles` is where the two
 * inputs a caller might send (`{is_primary: true}` or `{roles: ["primary"]}`)
 * collapse into one, so a write cannot leave them disagreeing. Migration 0027's
 * partial unique index is the backstop.
 */

export const CONTACT_ROLES = ["primary", "billing", "technical", "signatory", "other"] as const;

/**
 * The closed vocabulary. `contact_roles.role` carries no SQL CHECK (see the
 * migration comment), so this schema is the only thing standing between the API
 * and a typo'd role that would silently never resolve.
 */
export const contactRoleSchema = z.enum(CONTACT_ROLES);

/** How `resolveContact` arrived at the contact it returned. */
export type ContactMatch = "role" | "primary" | "any";

export interface ResolvedContact {
  contact: Contact;
  /**
   * `role` — the requested role was held by this contact.
   * `primary` — nobody held it, so the customer's primary contact answered.
   * `any` — there is no primary either, so the oldest contact answered.
   *
   * PRD-003's second acceptance criterion requires the fallback be *recorded*
   * on the decision, which is why this is returned rather than inferred.
   */
  matched: ContactMatch;
}

/**
 * Reconcile the two ways a caller can express "this is the primary contact"
 * into a single, deduplicated, sorted role list plus the flag that must agree
 * with it.
 *
 * `roles` is authoritative when supplied. `is_primary` is honoured as an
 * addition (true) or a removal (false) so the existing console checkbox, which
 * predates roles, keeps working on its own.
 */
export function normalizeRoles(input: {
  roles?: readonly ContactRole[];
  is_primary?: boolean;
  fallback?: readonly ContactRole[];
}): { roles: ContactRole[]; is_primary: boolean } {
  // An EMPTY `roles` array counts as "not specified", not as "clear them all":
  // the fallback (the caller's current roles on a patch, or create's
  // first-contact rule) is a better answer than silently demoting everybody to
  // `other`, and it lets the console send `roles` unconditionally.
  const stated = input.roles && input.roles.length > 0 ? input.roles : undefined;
  const set = new Set<ContactRole>(stated ?? input.fallback ?? []);
  if (input.is_primary === true) set.add("primary");
  if (input.is_primary === false) set.delete("primary");

  // A contact with no roles at all is not a useful record — `other` is the
  // PRD's own name for "a contact whose role nobody has stated".
  if (set.size === 0) set.add("other");

  const roles = CONTACT_ROLES.filter((r) => set.has(r));
  return { roles, is_primary: set.has("primary") };
}

interface ContactRoleRow {
  contact_id: string;
  role: string;
}

/** Roles for every contact at one customer — one query, not N+1. */
export async function listRolesByContact(
  db: D1Database,
  tenantId: string,
  customerId: string,
): Promise<Map<string, ContactRole[]>> {
  const { results } = await db
    .prepare(
      `SELECT r.contact_id, r.role
         FROM contact_roles r
         JOIN contacts c ON c.tenant_id = r.tenant_id AND c.contact_id = r.contact_id
        WHERE r.tenant_id = ? AND c.customer_id = ?`,
    )
    .bind(tenantId, customerId)
    .all<ContactRoleRow>();

  const byContact = new Map<string, ContactRole[]>();
  for (const row of results) {
    const parsed = contactRoleSchema.safeParse(row.role);
    if (!parsed.success) continue; // a role written before the vocabulary closed
    const list = byContact.get(row.contact_id) ?? [];
    list.push(parsed.data);
    byContact.set(row.contact_id, list);
  }
  for (const [id, list] of byContact) {
    byContact.set(id, CONTACT_ROLES.filter((r) => list.includes(r)));
  }
  return byContact;
}

/** Roles held by one contact. */
export async function getContactRoles(
  db: D1Database,
  tenantId: string,
  contactId: string,
): Promise<ContactRole[]> {
  const { results } = await db
    .prepare("SELECT role FROM contact_roles WHERE tenant_id = ? AND contact_id = ?")
    .bind(tenantId, contactId)
    .all<{ role: string }>();
  const held = new Set(results.map((r) => r.role));
  return CONTACT_ROLES.filter((r) => held.has(r));
}

/**
 * Statements that replace a contact's role set and keep `contacts.is_primary`
 * in step. Returned rather than executed so the caller can run them in the same
 * `db.batch()` as the contact INSERT/UPDATE — the primary swap has to be atomic
 * or the partial unique index will reject a legitimate hand-over.
 *
 * The clear-then-set order is what makes "exactly one primary per customer"
 * work: PRD-003 offers "clears the previous primary atomically (or 409 — pick
 * one and test it)" and this picks clear-atomically. SQLite checks uniqueness
 * per statement, so the intermediate state (nobody primary) is legal inside one
 * transaction.
 */
export function roleWriteStatements(
  db: D1Database,
  tenantId: string,
  args: { customer_id: string; contact_id: string; roles: readonly ContactRole[] },
): D1PreparedStatement[] {
  const { customer_id: customerId, contact_id: contactId, roles } = args;
  const isPrimary = roles.includes("primary");

  const statements: D1PreparedStatement[] = [
    db
      .prepare("DELETE FROM contact_roles WHERE tenant_id = ? AND contact_id = ?")
      .bind(tenantId, contactId),
    ...roles.map((role) =>
      db
        .prepare("INSERT INTO contact_roles (tenant_id, contact_id, role) VALUES (?, ?, ?)")
        .bind(tenantId, contactId, role),
    ),
  ];

  if (isPrimary) {
    // Demote whoever held it — both halves of the invariant, in that order.
    statements.push(
      db
        .prepare(
          `DELETE FROM contact_roles
            WHERE tenant_id = ? AND role = 'primary' AND contact_id <> ?
              AND contact_id IN (SELECT contact_id FROM contacts
                                  WHERE tenant_id = ? AND customer_id = ?)`,
        )
        .bind(tenantId, contactId, tenantId, customerId),
      db
        .prepare(
          `UPDATE contacts SET is_primary = 0
            WHERE tenant_id = ? AND customer_id = ? AND contact_id <> ?`,
        )
        .bind(tenantId, customerId, contactId),
    );
  }

  statements.push(
    db
      .prepare("UPDATE contacts SET is_primary = ? WHERE tenant_id = ? AND contact_id = ?")
      .bind(isPrimary ? 1 : 0, tenantId, contactId),
  );

  return statements;
}

interface ContactWithRoleRow {
  contact_id: string;
  customer_id: string;
  name: string;
  title: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  is_primary: number;
  created_at: string;
}

function toContact(row: ContactWithRoleRow, roles: ContactRole[]): Contact {
  return { ...row, is_primary: row.is_primary === 1, roles };
}

const RESOLVE_COLUMNS =
  "c.contact_id, c.customer_id, c.name, c.title, c.department, c.email, c.phone, c.is_primary, c.created_at";

/**
 * PRD-003's resolution helper. Documented fallback chain:
 *
 *   requested role -> primary -> any contact -> null
 *
 * Used by the CollectionsAgent (via the delivery port), invoice delivery, and —
 * once S9 lands — quote signing, which asks for `signatory`.
 *
 * Returns `null` rather than throwing when the customer has no contacts at all:
 * the caller decides what a missing contact means, and for reminder dispatch
 * that means emitting `customer.no_contact` (see src/delivery/dispatch.ts).
 *
 * Costs at most two queries and usually one — the fallback query only runs when
 * the role query misses.
 */
export async function resolveContact(
  db: D1Database,
  tenantId: string,
  customerId: string,
  role: ContactRole,
): Promise<ResolvedContact | null> {
  const byRole = await db
    .prepare(
      `SELECT ${RESOLVE_COLUMNS}
         FROM contacts c
         JOIN contact_roles r ON r.tenant_id = c.tenant_id AND r.contact_id = c.contact_id
        WHERE c.tenant_id = ? AND c.customer_id = ? AND r.role = ?
        ORDER BY c.is_primary DESC, c.created_at, c.contact_id
        LIMIT 1`,
    )
    .bind(tenantId, customerId, role)
    .first<ContactWithRoleRow>();

  if (byRole) {
    return {
      contact: toContact(byRole, await getContactRoles(db, tenantId, byRole.contact_id)),
      matched: "role",
    };
  }

  // Fallback: primary first (is_primary DESC), then oldest. One query covers
  // both rungs of the chain; `is_primary` tells us which rung answered.
  const fallback = await db
    .prepare(
      `SELECT ${RESOLVE_COLUMNS}
         FROM contacts c
        WHERE c.tenant_id = ? AND c.customer_id = ?
        ORDER BY c.is_primary DESC, c.created_at, c.contact_id
        LIMIT 1`,
    )
    .bind(tenantId, customerId)
    .first<ContactWithRoleRow>();

  if (!fallback) return null;

  return {
    contact: toContact(fallback, await getContactRoles(db, tenantId, fallback.contact_id)),
    matched: fallback.is_primary === 1 ? "primary" : "any",
  };
}

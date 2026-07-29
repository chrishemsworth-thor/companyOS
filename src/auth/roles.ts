/**
 * Role vocabulary — a dependency-free leaf so it can be imported anywhere
 * (services, the department registry, and the operator UI's parity test)
 * without dragging in credential/crypto code. `src/auth/users.ts` re-exports
 * these for existing callers.
 *
 * This list is the **single source of truth**: migration 0022 dropped the
 * `CHECK (role IN (...))` constraint from `users.role` precisely so adding a
 * role means editing this file (plus the UI mirror in
 * `ui/src/components/modals/UserFormModal.tsx`, which a parity test guards) and
 * granting it capabilities in `./capabilities.ts` — never a D1 migration.
 *
 * Two orthogonal axes are deliberately encoded in one list (see
 * docs/prd/PRD-008-roles-and-permissions.md):
 *
 * - **Business capability** — `admin`, `operator`, `finance`, `support`,
 *   `readonly`: which module operations you may perform.
 * - **Self-service identity** — `employee`: you are staff and may act on your
 *   *own* records, with no access to business data at all. This is not
 *   `readonly`, which means "read *all* business data".
 */
export const ROLES = [
  "admin",
  "operator",
  "finance",
  "support",
  "readonly",
  "employee",
] as const;
export type Role = (typeof ROLES)[number];

/**
 * The least-privilege role — what a new login gets when no role is specified,
 * including the employee-invite flow. Business access is granted deliberately,
 * never by default.
 */
export const DEFAULT_ROLE: Role = "employee";

/**
 * Platform roles for the console, **imported from the server's vocabulary**
 * rather than restated as a literal.
 *
 * `src/auth/roles.ts` and `src/auth/capabilities.ts` are deliberately
 * dependency-free leaves — no Hono, no D1, no crypto — so the browser bundle can
 * import them directly and the two sides cannot drift. Before PRD-008 this list
 * was duplicated here as a string literal, which is exactly how a role gets
 * added to one side and silently forgotten on the other.
 *
 * The console adds only what the API has no business carrying: display labels
 * and the one-line description shown next to a role in a picker, so choosing a
 * role is an informed act rather than a guess.
 */
export { ROLES, DEFAULT_ROLE, type Role } from "../../../src/auth/roles";
export {
  can,
  canReadAll,
  capabilitiesFor,
  type Capability,
  type CapabilityModule,
} from "../../../src/auth/capabilities";

import { type Role } from "../../../src/auth/roles";

/** What each role actually grants, in one line, for role pickers. */
export const ROLE_SUMMARY: Record<Role, string> = {
  admin: "Everything, including logins, integrations and company settings.",
  operator: "Full read and write across every business module. No admin surfaces.",
  finance: "Invoices, payments and the ledger. Reads customers; cannot edit them.",
  support: "Tickets. Reads customers; no finance, people or delivery access.",
  readonly: "Reads all business data. Cannot change anything.",
  employee: "Their own records only — no access to business data.",
};

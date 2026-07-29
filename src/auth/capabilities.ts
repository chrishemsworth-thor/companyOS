import { ROLES, type Role } from "./roles";

/**
 * Capability matrix — the single answer to "may this role do this?".
 *
 * A capability is `<module>:<action>`, where a **module** is a capability
 * surface (roughly one `/v1` router family) and an **action** is `read` for
 * safe methods or `write` for anything mutating. Roles are mapped to sets of
 * capabilities here, once, instead of role lists being sprinkled through route
 * files — so the answer to "what can `finance` do?" is readable in one place
 * and provable by one test.
 *
 * Enforcement lives in `src/gateway/middleware/capability.ts`: every `/v1`
 * router is mounted against a declared module and the action is derived from
 * the HTTP method, so a route added to an existing router is gated the moment
 * it exists — there is no per-route step to forget. Per-route
 * `requireCapability()` only ever *raises* the bar (e.g. admin-only surfaces).
 *
 * `system` actors (tenant API key) bypass the matrix entirely — they are
 * trusted root credentials for agents. See PRD-008.
 */

/**
 * Capability surfaces. `self` and `meta` are deliberately not business
 * modules:
 *
 * - `self` is the **identity axis** — your own employee record, your own leave
 *   and claims. Every role holds it, because being staff is orthogonal to what
 *   business data you may touch. It is what makes an `employee` login useful
 *   while it reads nothing else.
 * - `meta` is the discovery surface (`GET /v1/meta/departments`), which
 *   self-filters by role and so is readable by everyone who can log in.
 * - `admin` covers tenant administration — logins, integration credentials,
 *   webhook signing secrets, onboarding completion.
 */
export const CAPABILITY_MODULES = [
  "finance",
  "crm",
  "support",
  "build",
  "insights",
  "people",
  "agents",
  "files",
  "settings",
  "admin",
  "meta",
  "self",
] as const;

export type CapabilityModule = (typeof CAPABILITY_MODULES)[number];
export type Action = "read" | "write";
export type Capability = `${CapabilityModule}:${Action}`;

/** Read + write on each listed module. */
function rw(...modules: CapabilityModule[]): Capability[] {
  return modules.flatMap((m) => [`${m}:read`, `${m}:write`] as Capability[]);
}

/** Read only on each listed module. */
function ro(...modules: CapabilityModule[]): Capability[] {
  return modules.map((m) => `${m}:read` as Capability);
}

/** Every business module — the observer surface `readonly` reads in full. */
const BUSINESS_MODULES: CapabilityModule[] = [
  "finance",
  "crm",
  "support",
  "build",
  "insights",
  "people",
  "agents",
  "files",
  "settings",
];

/**
 * Role → capabilities. Notes on the deliberate edges:
 *
 * - `finance` reads `crm` because you cannot raise an invoice without reading
 *   the customer, but it cannot write CRM records or see People.
 * - `support` reads `crm` for the same reason (tickets hang off customers) and
 *   cannot see People either — issue/ticket assignees are free-text, so no
 *   support workflow needs the employee directory.
 * - `readonly` is a full business observer with **no** write anywhere, and no
 *   `admin` module: it cannot list or edit logins.
 * - `employee` is the self-service tier: `self` and `meta` only. Reading any
 *   business data — including the employee directory, which carries HR notes
 *   and employment terms — is a 403.
 * - Every role holds `self:read`/`self:write`, including `readonly`: the
 *   identity axis is not a business capability, so an observer who is also
 *   staff can still file their own leave request.
 */
const MATRIX: Record<Role, readonly Capability[]> = {
  admin: rw(...CAPABILITY_MODULES),
  operator: [
    ...rw("finance", "crm", "support", "build", "insights", "people", "agents", "files", "settings", "self"),
    ...ro("meta"),
  ],
  finance: [...rw("finance", "files", "self"), ...ro("crm", "insights", "settings", "meta")],
  support: [...rw("support", "self"), ...ro("crm", "files", "settings", "meta")],
  readonly: [...ro(...BUSINESS_MODULES), ...ro("meta"), ...rw("self")],
  employee: [...rw("self"), ...ro("meta")],
};

const GRANTED: Record<string, ReadonlySet<Capability>> = Object.fromEntries(
  ROLES.map((role) => [role, new Set(MATRIX[role])]),
);

/**
 * Does `role` hold `capability`? Fails closed: an absent or unknown role (a
 * stale session carrying a role that has since been removed from `ROLES`) is
 * granted nothing.
 */
export function can(role: string | undefined, capability: Capability): boolean {
  if (!role) return false;
  return GRANTED[role]?.has(capability) ?? false;
}

/** Sorted capability list for a role — served to the console so it can hide
 * actions the user would only get a 403 from, and used by the parity tests. */
export function capabilitiesFor(role: string | undefined): Capability[] {
  if (!role) return [];
  return [...(GRANTED[role] ?? [])].sort();
}

/** Can `role` read every one of `modules`? The department lens's question. */
export function canReadAll(role: string | undefined, modules: CapabilityModule[]): boolean {
  return modules.every((m) => can(role, `${m}:read`));
}

/** Can `role` read at least one of `modules`? */
export function canReadAny(role: string | undefined, modules: CapabilityModule[]): boolean {
  return modules.some((m) => can(role, `${m}:read`));
}

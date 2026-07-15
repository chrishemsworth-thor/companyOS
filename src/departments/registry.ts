import { ROLES, type Role } from "../auth/roles";

/**
 * Department registry — the org-chart *lens* over CompanyOS's capability
 * modules.
 *
 * A department is *who consumes* the data, not *what data exists*. Several
 * departments read the same module (Sales and Customer Experience both need the
 * customer record), so departments are deliberately NOT a 1:1 mirror of the
 * `src/modules/*` data domains — mapping them 1:1 would duplicate data and
 * break the one-normalized-database thesis. Instead each department declares
 * which capability modules it surfaces, which human roles may see it, and the
 * console routes it exposes as tools.
 *
 * This is the canonical source of truth: `GET /v1/meta/departments` serves it
 * (so agents can discover the taxonomy) and the operator console mirrors it in
 * `ui/src/lib/departments.ts` (kept honest by a parity test). Adding a genuinely
 * new data domain (People → Legal → Operations) later means building the module
 * and flipping that department's `status` from `planned` to `live`.
 */

/** Capability modules a department can surface. `agents` is the DO runtime. */
export type ModuleKey = "finance" | "crm" | "support" | "build" | "insights" | "agents";

/**
 * `live` — backed by a shipped module, with working console tools.
 * `planned` — part of the org model but not yet built; shown disabled so the
 * full taxonomy (and the build order) stays visible.
 */
export type DepartmentStatus = "live" | "planned";

/** A console route a department exposes. `route` matches a UI router path. */
export interface DepartmentTool {
  label: string;
  route: string;
}

export interface Department {
  id: string;
  label: string;
  status: DepartmentStatus;
  summary: string;
  /** Capability modules this department reads from. */
  modules: ModuleKey[];
  /** Roles allowed to see this department. Subset of `ROLES`. */
  roles: Role[];
  /** Console routes; empty for `planned` departments. */
  tools: DepartmentTool[];
}

// Roles that see every business department: full operators + read-only
// observers, plus admins. Finance and support are scoped to their own surfaces.
const BROAD: Role[] = ["admin", "operator", "readonly"];

export const DEPARTMENTS: Department[] = [
  {
    id: "finance",
    label: "Finance",
    status: "live",
    summary: "Double-entry ledger, invoices, and payments.",
    modules: ["finance"],
    roles: [...BROAD, "finance"],
    tools: [
      { label: "Invoices", route: "/invoices" },
      { label: "Ledger", route: "/ledger" },
    ],
  },
  {
    id: "sales",
    label: "Sales & Business Development",
    status: "live",
    summary: "Customers, deal pipeline, and activity history.",
    modules: ["crm"],
    roles: BROAD,
    tools: [
      { label: "Customers", route: "/customers" },
      { label: "Deals", route: "/deals" },
    ],
  },
  {
    id: "customer-experience",
    label: "Customer Experience",
    status: "live",
    summary: "Support tickets and the customer relationship they attach to.",
    modules: ["support", "crm"],
    roles: [...BROAD, "support"],
    tools: [{ label: "Tickets", route: "/tickets" }],
  },
  {
    id: "technology",
    label: "Technology / Engineering",
    status: "live",
    summary: "Delivery projects and the issues that make them up.",
    modules: ["build"],
    roles: BROAD,
    tools: [
      { label: "Projects", route: "/projects" },
      { label: "Issues", route: "/issues" },
    ],
  },
  {
    id: "data-ai",
    label: "Data & AI",
    status: "live",
    summary: "Autonomous agent activity and the decisions it audits.",
    modules: ["agents", "insights"],
    roles: BROAD,
    tools: [{ label: "Agent activity", route: "/agent" }],
  },
  {
    id: "management",
    label: "Management",
    status: "live",
    summary: "Cross-module overview stitched from one database.",
    modules: ["insights"],
    roles: [...BROAD, "finance"],
    tools: [{ label: "Dashboard", route: "/" }],
  },
  {
    id: "product",
    label: "Product",
    status: "planned",
    summary: "Roadmap, feedback, and releases (grouped over Build for now).",
    modules: ["build"],
    roles: BROAD,
    tools: [],
  },
  {
    id: "rnd",
    label: "R&D / Innovation",
    status: "planned",
    summary: "Experiments and ideas ahead of the delivery pipeline.",
    modules: ["build"],
    roles: BROAD,
    tools: [],
  },
  {
    id: "people",
    label: "People",
    status: "planned",
    summary: "Employees, roles, and leave — the next module to build.",
    modules: [],
    roles: BROAD,
    tools: [],
  },
  {
    id: "legal",
    label: "Legal",
    status: "planned",
    summary: "Contracts, entities, and policy compliance.",
    modules: [],
    roles: BROAD,
    tools: [],
  },
  {
    id: "operations",
    label: "Operations",
    status: "planned",
    summary: "Vendors, procurement, and asset tracking.",
    modules: [],
    roles: BROAD,
    tools: [],
  },
];

/** Stable id list — the parity anchor the UI mirror is checked against. */
export const DEPARTMENT_IDS = DEPARTMENTS.map((d) => d.id);

/**
 * Departments visible to a human role. A `system`/agent caller sees everything
 * (pass no role). Unknown roles see nothing rather than leaking the full list.
 */
export function departmentsForRole(role?: string): Department[] {
  if (!role) return DEPARTMENTS;
  if (!ROLES.includes(role as Role)) return [];
  return DEPARTMENTS.filter((d) => d.roles.includes(role as Role));
}

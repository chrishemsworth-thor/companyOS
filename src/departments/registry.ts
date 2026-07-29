import { canReadAll, type CapabilityModule } from "../auth/capabilities";

/**
 * Department registry — the org-chart *lens* over CompanyOS's capability
 * modules.
 *
 * A department is *who consumes* the data, not *what data exists*. Several
 * departments read the same module (Sales and Customer Experience both need the
 * customer record), so departments are deliberately NOT a 1:1 mirror of the
 * `src/modules/*` data domains — mapping them 1:1 would duplicate data and
 * break the one-normalized-database thesis. Instead each department declares
 * which capability modules it surfaces and the console routes it exposes as
 * tools. Who may *see* a department is no longer declared here: it is derived
 * from the capability matrix (`src/auth/capabilities.ts`) by
 * `departmentsForRole`, so navigation and route enforcement cannot disagree.
 *
 * This is the canonical source of truth: `GET /v1/meta/departments` serves it
 * (so agents can discover the taxonomy) and the operator console mirrors it in
 * `ui/src/lib/departments.ts` (kept honest by a parity test). Adding a genuinely
 * new data domain (People → Legal → Operations) later means building the module
 * and flipping that department's `status` from `planned` to `live`.
 */

/**
 * Capability modules a department can surface. `agents` is the DO runtime.
 * Narrowed from `CapabilityModule` so the taxonomy cannot drift from the
 * capability matrix that now decides visibility — naming a module here that
 * nobody can be granted is a type error.
 */
export type ModuleKey = Extract<
  CapabilityModule,
  "finance" | "crm" | "support" | "build" | "insights" | "agents" | "people"
>;

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
  /** Console routes; empty for `planned` departments. */
  tools: DepartmentTool[];
}

export const DEPARTMENTS: Department[] = [
  {
    id: "finance",
    label: "Finance",
    status: "live",
    summary: "Double-entry ledger, invoices, and payments.",
    modules: ["finance"],
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
    tools: [
      { label: "Customers", route: "/customers" },
      { label: "Deals", route: "/deals" },
      { label: "Quotes", route: "/quotes" },
    ],
  },
  {
    id: "customer-experience",
    label: "Customer Experience",
    status: "live",
    summary: "Support tickets and the customer relationship they attach to.",
    modules: ["support", "crm"],
    tools: [{ label: "Tickets", route: "/tickets" }],
  },
  {
    id: "technology",
    label: "Technology / Engineering",
    status: "live",
    summary: "Delivery projects and the issues that make them up.",
    modules: ["build"],
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
    tools: [{ label: "Agent activity", route: "/agent" }],
  },
  {
    id: "management",
    label: "Management",
    status: "live",
    summary: "Cross-module overview stitched from one database.",
    modules: ["insights"],
    tools: [
      { label: "Dashboard", route: "/" },
      { label: "Company Profile", route: "/settings/company" },
      { label: "Quote Branding", route: "/settings/quote-branding" },
    ],
  },
  {
    id: "product",
    label: "Product",
    status: "planned",
    summary: "Roadmap, feedback, and releases (grouped over Build for now).",
    modules: ["build"],
    tools: [],
  },
  {
    id: "rnd",
    label: "R&D / Innovation",
    status: "planned",
    summary: "Experiments and ideas ahead of the delivery pipeline.",
    modules: ["build"],
    tools: [],
  },
  {
    id: "people",
    label: "People",
    status: "live",
    summary: "Employee directory, teams, and reporting lines.",
    modules: ["people"],
    tools: [
      { label: "Employees", route: "/employees" },
      { label: "Teams", route: "/teams" },
    ],
  },
  {
    id: "legal",
    label: "Legal",
    status: "planned",
    summary: "Contracts, entities, and policy compliance.",
    modules: [],
    tools: [],
  },
  {
    id: "operations",
    label: "Operations",
    status: "planned",
    summary: "Vendors, procurement, and asset tracking.",
    modules: [],
    tools: [],
  },
];

/** Stable id list — the parity anchor the UI mirror is checked against. */
export const DEPARTMENT_IDS = DEPARTMENTS.map((d) => d.id);

/** Every module the taxonomy surfaces — what "a business role" means here. */
const ALL_MODULE_KEYS: ModuleKey[] = [...new Set(DEPARTMENTS.flatMap((d) => d.modules))];

/**
 * Departments visible to a human role, **derived from the capability matrix**
 * rather than a second list of roles kept alongside it (PRD-008). A department
 * is visible when the role can read *every* module it surfaces — the strict
 * reading, so the console never offers a department whose pages would 403 in
 * part. Its write actions are gated separately, per capability, by the UI.
 *
 * A `system`/agent caller sees everything (pass no role). An unknown role, or
 * the self-service `employee` tier, sees nothing: both hold no business read
 * capability, so the filter empties rather than leaking the taxonomy.
 *
 * `planned` departments that surface no module yet (Legal, Operations) are
 * shown to roles that can read the whole business — an empty module list would
 * otherwise be vacuously readable and leak the placeholders to every login,
 * self-service included.
 */
export function departmentsForRole(role?: string): Department[] {
  if (!role) return DEPARTMENTS;
  return DEPARTMENTS.filter((d) =>
    canReadAll(role, d.modules.length > 0 ? d.modules : ALL_MODULE_KEYS),
  );
}

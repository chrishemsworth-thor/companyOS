import type { ComponentType } from "react";
import type { ModuleKey } from "../../../src/departments/registry";
import { canReadAll, type Role } from "./roles";
import {
  LayoutDashboard,
  Bot,
  Receipt,
  BookOpen,
  Users,
  TrendingUp,
  LifeBuoy,
  FolderKanban,
  CircleDot,
  Landmark,
  Headset,
  Code2,
  Sparkles,
  Package,
  Lightbulb,
  UserPlus,
  UserRound,
  UsersRound,
  Network,
  Scale,
  Boxes,
  FileText,
  Building2,
  Palette,
  CalendarDays,
} from "lucide-react";

/**
 * Operator-console mirror of the server department registry
 * (`src/departments/registry.ts`). Kept as a static list so the sidebar paints
 * instantly without waiting on a fetch; the API remains the canonical source
 * for agents, and `departments.test.ts` fails if these ids drift from it.
 *
 * The only thing the console adds over the server registry is icons (a view
 * concern the API has no business carrying).
 */

export type DepartmentStatus = "live" | "planned";

type Icon = ComponentType<{ className?: string }>;

export interface DepartmentTool {
  label: string;
  route: string;
  icon: Icon;
}

export interface Department {
  id: string;
  label: string;
  status: DepartmentStatus;
  summary: string;
  /**
   * Capability modules the department surfaces — the same list the server
   * registry carries, and what decides visibility. Kept in step by the parity
   * test in `departments.test.ts`.
   */
  modules: ModuleKey[];
  icon: Icon;
  tools: DepartmentTool[];
}

export const DEPARTMENTS: Department[] = [
  {
    id: "finance",
    label: "Finance",
    status: "live",
    summary: "Double-entry ledger, invoices, and payments.",
    modules: ["finance"],
    icon: Landmark,
    tools: [
      { label: "Invoices", route: "/invoices", icon: Receipt },
      { label: "Ledger", route: "/ledger", icon: BookOpen },
    ],
  },
  {
    id: "sales",
    label: "Sales & Business Development",
    status: "live",
    summary: "Leads, customers, deal pipeline, and activity history.",
    modules: ["crm"],
    icon: TrendingUp,
    tools: [
      { label: "Leads", route: "/leads", icon: UserPlus },
      { label: "Customers", route: "/customers", icon: Users },
      { label: "Deals", route: "/deals", icon: TrendingUp },
      { label: "Quotes", route: "/quotes", icon: FileText },
    ],
  },
  {
    id: "customer-experience",
    label: "Customer Experience",
    status: "live",
    summary: "Support tickets and the customer relationship they attach to.",
    modules: ["support", "crm"],
    icon: Headset,
    tools: [{ label: "Tickets", route: "/tickets", icon: LifeBuoy }],
  },
  {
    id: "technology",
    label: "Technology / Engineering",
    status: "live",
    summary: "Delivery projects and the issues that make them up.",
    modules: ["build"],
    icon: Code2,
    tools: [
      { label: "Projects", route: "/projects", icon: FolderKanban },
      { label: "Issues", route: "/issues", icon: CircleDot },
    ],
  },
  {
    id: "data-ai",
    label: "Data & AI",
    status: "live",
    summary: "Autonomous agent activity and the decisions it audits.",
    modules: ["agents", "insights"],
    icon: Sparkles,
    tools: [{ label: "Agent activity", route: "/agent", icon: Bot }],
  },
  {
    id: "management",
    label: "Management",
    status: "live",
    summary: "Cross-module overview stitched from one database.",
    modules: ["insights"],
    icon: LayoutDashboard,
    tools: [
      { label: "Dashboard", route: "/", icon: LayoutDashboard },
      { label: "Company Profile", route: "/settings/company", icon: Building2 },
      { label: "Quote Branding", route: "/settings/quote-branding", icon: Palette },
    ],
  },
  {
    id: "product",
    label: "Product",
    status: "planned",
    summary: "Roadmap, feedback, and releases (grouped over Build for now).",
    modules: ["build"],
    icon: Package,
    tools: [],
  },
  {
    id: "rnd",
    label: "R&D / Innovation",
    status: "planned",
    summary: "Experiments and ideas ahead of the delivery pipeline.",
    modules: ["build"],
    icon: Lightbulb,
    tools: [],
  },
  {
    id: "people",
    label: "People",
    status: "live",
    summary: "Employee directory, teams, reporting lines, and leave.",
    modules: ["people"],
    icon: UserRound,
    tools: [
      { label: "Employees", route: "/employees", icon: UsersRound },
      { label: "Teams", route: "/teams", icon: Network },
      // The manager-facing half of leave (PRD-006c). "My leave" is under "You"
      // in the sidebar instead — the self-service tier sees no departments, and
      // those are exactly the people filing leave.
      { label: "Leave calendar", route: "/leave/calendar", icon: CalendarDays },
    ],
  },
  {
    id: "legal",
    label: "Legal",
    status: "planned",
    summary: "Contracts, entities, and policy compliance.",
    modules: [],
    icon: Scale,
    tools: [],
  },
  {
    id: "operations",
    label: "Operations",
    status: "planned",
    summary: "Vendors, procurement, and asset tracking.",
    modules: [],
    icon: Boxes,
    tools: [],
  },
];

/** Stable id list — the anchor the parity test checks against the server. */
export const UI_DEPARTMENT_IDS = DEPARTMENTS.map((d) => d.id);

/** Every module the taxonomy surfaces — what "a business role" means here. */
const ALL_MODULE_KEYS: ModuleKey[] = [...new Set(DEPARTMENTS.flatMap((d) => d.modules))];

/**
 * Departments a role may see, derived from the shared capability matrix exactly
 * as the server derives it (`departmentsForRole` in src/departments/registry.ts)
 * — so the sidebar cannot offer a department whose pages would 403. An
 * unauthenticated shell, and the self-service `employee` tier, see none.
 *
 * `planned` departments surfacing no module yet are shown to roles that can read
 * the whole business, since an empty module list is otherwise vacuously
 * readable.
 */
export function departmentsForRole(role: Role | undefined): Department[] {
  if (!role) return [];
  return DEPARTMENTS.filter((d) =>
    canReadAll(role, d.modules.length > 0 ? d.modules : ALL_MODULE_KEYS),
  );
}

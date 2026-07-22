import type { ComponentType } from "react";
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

export type Role = "admin" | "operator" | "finance" | "support" | "readonly";
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
  roles: Role[];
  icon: Icon;
  tools: DepartmentTool[];
}

const BROAD: Role[] = ["admin", "operator", "readonly"];

export const DEPARTMENTS: Department[] = [
  {
    id: "finance",
    label: "Finance",
    status: "live",
    summary: "Double-entry ledger, invoices, and payments.",
    roles: [...BROAD, "finance"],
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
    roles: BROAD,
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
    roles: [...BROAD, "support"],
    icon: Headset,
    tools: [{ label: "Tickets", route: "/tickets", icon: LifeBuoy }],
  },
  {
    id: "technology",
    label: "Technology / Engineering",
    status: "live",
    summary: "Delivery projects and the issues that make them up.",
    roles: BROAD,
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
    roles: BROAD,
    icon: Sparkles,
    tools: [{ label: "Agent activity", route: "/agent", icon: Bot }],
  },
  {
    id: "management",
    label: "Management",
    status: "live",
    summary: "Cross-module overview stitched from one database.",
    roles: [...BROAD, "finance"],
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
    roles: BROAD,
    icon: Package,
    tools: [],
  },
  {
    id: "rnd",
    label: "R&D / Innovation",
    status: "planned",
    summary: "Experiments and ideas ahead of the delivery pipeline.",
    roles: BROAD,
    icon: Lightbulb,
    tools: [],
  },
  {
    id: "people",
    label: "People",
    status: "live",
    summary: "Employee directory, teams, and reporting lines.",
    roles: BROAD,
    icon: UserRound,
    tools: [
      { label: "Employees", route: "/employees", icon: UsersRound },
      { label: "Teams", route: "/teams", icon: Network },
    ],
  },
  {
    id: "legal",
    label: "Legal",
    status: "planned",
    summary: "Contracts, entities, and policy compliance.",
    roles: BROAD,
    icon: Scale,
    tools: [],
  },
  {
    id: "operations",
    label: "Operations",
    status: "planned",
    summary: "Vendors, procurement, and asset tracking.",
    roles: BROAD,
    icon: Boxes,
    tools: [],
  },
];

/** Stable id list — the anchor the parity test checks against the server. */
export const UI_DEPARTMENT_IDS = DEPARTMENTS.map((d) => d.id);

/** Departments a role may see; used to build the sidebar. */
export function departmentsForRole(role: Role | undefined): Department[] {
  if (!role) return [];
  return DEPARTMENTS.filter((d) => d.roles.includes(role));
}

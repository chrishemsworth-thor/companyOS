import { useEffect, useState, type ComponentType } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
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
  Shield,
  Menu,
  X,
  LogOut,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { cn } from "../lib/cn";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
}
interface NavGroup {
  label: string;
  items: NavItem[];
  adminOnly?: boolean;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, end: true },
      { to: "/agent", label: "Agent activity", icon: Bot },
    ],
  },
  {
    label: "Finance",
    items: [
      { to: "/invoices", label: "Invoices", icon: Receipt },
      { to: "/ledger", label: "Ledger", icon: BookOpen },
    ],
  },
  {
    label: "CRM",
    items: [
      { to: "/customers", label: "Customers", icon: Users },
      { to: "/deals", label: "Deals", icon: TrendingUp },
    ],
  },
  { label: "Support", items: [{ to: "/tickets", label: "Tickets", icon: LifeBuoy }] },
  {
    label: "Build",
    items: [
      { to: "/projects", label: "Projects", icon: FolderKanban },
      { to: "/issues", label: "Issues", icon: CircleDot },
    ],
  },
  { label: "Admin", adminOnly: true, items: [{ to: "/users", label: "Users", icon: Shield }] },
];

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <span className="grid size-7 place-items-center rounded-md bg-accent text-sm font-bold text-accent-contrast">
        C
      </span>
      <span className="text-[0.95rem] font-semibold tracking-tight text-fg">CompanyOS</span>
    </div>
  );
}

function SidebarContent({ onClose }: { onClose?: () => void }) {
  const { logout, baseUrl, user } = useAuth();
  const groups = NAV_GROUPS.filter((g) => !g.adminOnly || user?.role === "admin");

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center justify-between px-4">
        <Brand />
        {onClose && (
          <button
            aria-label="Close menu"
            onClick={onClose}
            className="cursor-pointer rounded-md p-1.5 text-subtle transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <X className="size-5" />
          </button>
        )}
      </div>

      <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-3 pb-4">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-2 pb-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-subtle">
              {group.label}
            </div>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={onClose}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm font-medium no-underline transition-colors hover:no-underline",
                      isActive
                        ? "bg-accent-soft text-accent"
                        : "text-muted hover:bg-surface-2 hover:text-fg",
                    )
                  }
                >
                  <item.icon className="size-4 shrink-0" />
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-border p-3">
        {user && (
          <div className="mb-2 min-w-0 px-1.5">
            <div className="truncate text-sm font-medium text-fg" title={user.email}>
              {user.email}
            </div>
            <div className="truncate text-xs text-subtle" title={baseUrl}>
              <span className="capitalize">{user.role}</span> · {baseUrl}
            </div>
          </div>
        )}
        <button
          onClick={logout}
          className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <LogOut className="size-4" />
          Sign out
        </button>
      </div>
    </div>
  );
}

export function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  // Close the drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Escape-to-close + background scroll lock while the drawer is open.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [drawerOpen]);

  return (
    <div className="min-h-screen bg-bg">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-border bg-surface lg:flex">
        <SidebarContent />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur lg:hidden">
        <button
          aria-label="Open menu"
          onClick={() => setDrawerOpen(true)}
          className="-ml-1.5 cursor-pointer rounded-md p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <Menu className="size-5" />
        </button>
        <Brand />
      </header>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-overlay backdrop-blur-sm animate-[overlay-in_150ms_ease-out]"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85%] border-r border-border bg-surface shadow-lg animate-[drawer-in_200ms_ease-out]">
            <SidebarContent onClose={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      {/* Main content */}
      <main className="lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

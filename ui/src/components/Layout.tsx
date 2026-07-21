import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { LayoutGrid, Shield, Menu, X, LogOut } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { cn } from "../lib/cn";
import { departmentsForRole } from "../lib/departments";
import { ThemeToggle } from "./ThemeToggle";

type Icon = ComponentType<{ className?: string }>;

/** A labelled sidebar group (a department, or the Overview/Admin sections). */
function NavSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="px-2 pb-1.5 text-[0.68rem] font-semibold uppercase tracking-wider text-subtle">
        {label}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function NavItemLink({
  to,
  label,
  icon: Icon,
  end,
  onClose,
}: {
  to: string;
  label: string;
  icon: Icon;
  end?: boolean;
  onClose?: () => void;
}) {
  return (
    <NavLink
      to={to}
      end={end}
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
      <Icon className="size-4 shrink-0" />
      {label}
    </NavLink>
  );
}

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
  const { logout, baseUrl, user, tenant } = useAuth();
  // Sidebar is the department lens, filtered to what the current role may see.
  const visible = departmentsForRole(user?.role);
  const live = visible.filter((d) => d.status === "live");
  const planned = visible.filter((d) => d.status === "planned");

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
        <NavSection label="Overview">
          <NavItemLink to="/departments" label="Departments" icon={LayoutGrid} onClose={onClose} />
        </NavSection>

        {/* One group per live department; its tools are the module surfaces it owns. */}
        {live.map((dept) => (
          <NavSection key={dept.id} label={dept.label}>
            {dept.tools.map((tool) => (
              <NavItemLink
                key={tool.route}
                to={tool.route}
                label={tool.label}
                icon={tool.icon}
                end={tool.route === "/"}
                onClose={onClose}
              />
            ))}
          </NavSection>
        ))}

        {/* Planned departments: part of the org model, not yet built — shown
            disabled so the taxonomy (and roadmap) stays visible. */}
        {planned.length > 0 && (
          <NavSection label="Planned">
            {planned.map((dept) => (
              <div
                key={dept.id}
                title={dept.summary}
                className="flex cursor-default items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-subtle"
              >
                <span className="flex items-center gap-2.5">
                  <dept.icon className="size-4 shrink-0" />
                  {dept.label}
                </span>
                <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[0.6rem] font-semibold uppercase tracking-wide text-subtle">
                  Soon
                </span>
              </div>
            ))}
          </NavSection>
        )}

        {user?.role === "admin" && (
          <NavSection label="Admin">
            <NavItemLink to="/users" label="Users" icon={Shield} onClose={onClose} />
          </NavSection>
        )}
      </nav>

      <div className="shrink-0 border-t border-border p-3">
        {tenant && (
          <div className="mb-2 min-w-0 px-1.5" title={tenant.name}>
            <div className="text-[0.68rem] font-semibold uppercase tracking-wider text-subtle">
              Company
            </div>
            <div className="truncate text-sm font-semibold text-fg">{tenant.name}</div>
          </div>
        )}
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
        <ThemeToggle />
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

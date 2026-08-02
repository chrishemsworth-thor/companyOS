import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { LayoutGrid, Shield, X, LogOut, UserCircle, CheckSquare, CalendarDays } from "lucide-react";
import { useDrag } from "@use-gesture/react";
import { useAuth } from "../auth/AuthContext";
import { cn } from "../lib/cn";
import { departmentsForRole } from "../lib/departments";
import { ThemeToggle } from "./ThemeToggle";
import { TopBar } from "./TopBar";

/** Falls back to this until the panel has actually been measured (matches `w-72`). */
const DEFAULT_DRAWER_WIDTH = 288;
/** px/ms; a flick past this speed decides open/close by direction alone,
 * regardless of how far the drag travelled. */
const FLICK_VELOCITY = 0.5;

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
  const { logout, user, tenant, can } = useAuth();
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
        <NavSection label="You">
          <NavItemLink to="/me" label="My profile" icon={UserCircle} onClose={onClose} />
          {/* Approvals lives under "You", not "Overview".
              It started in Overview, which was wrong once PRD-008 landed: that
              section is hidden from the self-service tier, and those are exactly
              the people who need this screen most — it is where an employee
              tracks the leave request or expense claim they filed. It is also
              not a department surface (a manager's queue spans leave, claims and
              quotes), and keeping it out of the department registry is what
              keeps `lib/departments.test.ts` in parity with the server. Gated on
              `self`, like the route it points at. */}
          <NavItemLink to="/approvals" label="Approvals" icon={CheckSquare} onClose={onClose} />
          {/* My leave sits under "You" for the same reason Approvals does: it is
              on the `self` axis, and the self-service tier — the people actually
              filing leave — sees no department groups at all. The team calendar
              is the manager-facing half and lives in the People department. */}
          <NavItemLink to="/leave" label="My leave" icon={CalendarDays} onClose={onClose} />
        </NavSection>

        {/* Hidden from the self-service tier, which sees no departments at all. */}
        {live.length + planned.length > 0 && (
          <NavSection label="Overview">
            <NavItemLink to="/departments" label="Departments" icon={LayoutGrid} onClose={onClose} />
          </NavSection>
        )}

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

        {can("admin:read") && (
          <NavSection label="Admin">
            <NavItemLink to="/users" label="Users" icon={Shield} onClose={onClose} />
          </NavSection>
        )}
      </nav>

      <div className="safe-bottom-3 shrink-0 border-t border-border p-3">
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
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={logout}
            className="flex flex-1 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          >
            <LogOut className="size-4" />
            Sign out
          </button>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

export function Layout() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();

  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const panelWidthRef = useRef(DEFAULT_DRAWER_WIDTH);

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

  // The drawer stays mounted at all times (needed so it can be dragged open
  // from the closed state) but is fully translated off-screen and `inert`
  // while closed, so it can't be tabbed/hit-tested — set via the DOM
  // property directly since @types/react doesn't expose `inert` as a prop.
  useEffect(() => {
    if (wrapperRef.current) wrapperRef.current.inert = !drawerOpen;
  }, [drawerOpen]);

  /** Live-updates the panel/backdrop from a drag offset, bypassing React
   * state so every pointermove doesn't trigger a re-render. */
  function trackDrag(offsetX: number, width: number) {
    if (panelRef.current) panelRef.current.style.transform = `translateX(${offsetX}px)`;
    if (backdropRef.current) {
      backdropRef.current.style.opacity = String(Math.min(1, Math.max(0, (offsetX + width) / width)));
    }
  }

  /** Ends a drag: hands the panel back to its CSS transition (which already
   * respects prefers-reduced-motion, unlike a hand-rolled rAF tween) and
   * commits the resulting open/closed state — a fast-enough flick decides by
   * direction alone, even if the drag didn't travel far. */
  function settleDrag(offsetX: number, width: number, velocityX: number, directionX: number) {
    if (panelRef.current) {
      panelRef.current.style.transitionProperty = "";
      panelRef.current.style.transform = "";
    }
    if (backdropRef.current) backdropRef.current.style.opacity = "";
    setDrawerOpen(velocityX > FLICK_VELOCITY ? directionX > 0 : offsetX > -width / 2);
  }

  function onDragFrame({
    first,
    last,
    offset: [ox],
    velocity: [vx],
    direction: [dx],
  }: {
    first: boolean;
    last: boolean;
    offset: [number, number];
    velocity: [number, number];
    direction: [number, number];
  }) {
    const width = panelRef.current?.offsetWidth || panelWidthRef.current;
    panelWidthRef.current = width;
    if (first && panelRef.current) panelRef.current.style.transitionProperty = "none";
    if (last) {
      settleDrag(ox, width, vx, dx);
    } else {
      trackDrag(ox, width);
    }
  }

  // Drag-to-close, starting from the panel's fully-open position.
  const bindPanelDrag = useDrag(onDragFrame, {
    axis: "x",
    from: () => [0, 0],
    bounds: () => ({ left: -panelWidthRef.current, right: 0 }),
    rubberband: true,
    filterTaps: true,
    preventDefault: true,
  });

  // Edge-swipe-to-open, starting from the panel's fully-closed position.
  const bindEdgeDrag = useDrag(onDragFrame, {
    axis: "x",
    from: () => [-panelWidthRef.current, 0],
    bounds: () => ({ left: -panelWidthRef.current, right: 0 }),
    rubberband: true,
    filterTaps: true,
    preventDefault: true,
  });

  return (
    <div className="min-h-screen bg-bg">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 flex-col border-r border-border bg-surface lg:flex">
        <SidebarContent />
      </aside>

      {/* Top bar, all breakpoints — it carries the notification bell, which
          PRD-007 requires on every page. */}
      <TopBar onOpenMenu={() => setDrawerOpen(true)} brand={<Brand />} />

      {/* Edge-swipe-to-open hit strip. Lives outside the drawer wrapper so it
          stays reachable while that wrapper is `inert` (drawer closed); once
          open, the backdrop/panel paint over it and take over drag duty. */}
      <div
        {...bindEdgeDrag()}
        aria-hidden="true"
        className="fixed inset-y-0 left-0 z-40 w-5 touch-none lg:hidden"
      />

      {/* Mobile drawer — always mounted (see the `inert` effect above) so it
          can be edge-swiped open and drag-tracked closed, not just tapped. */}
      <div ref={wrapperRef} aria-hidden={!drawerOpen} className="fixed inset-0 z-40 lg:hidden">
        <div
          ref={backdropRef}
          className={cn(
            "absolute inset-0 bg-overlay backdrop-blur-sm transition-opacity duration-150 ease-out",
            drawerOpen ? "opacity-100" : "opacity-0",
          )}
          onClick={() => setDrawerOpen(false)}
        />
        <aside
          ref={panelRef}
          {...bindPanelDrag()}
          className={cn(
            "absolute inset-y-0 left-0 w-72 max-w-[85%] touch-pan-y border-r border-border bg-surface shadow-lg transition-transform duration-200 ease-out",
            drawerOpen ? "translate-x-0" : "-translate-x-full",
          )}
        >
          <SidebarContent onClose={() => setDrawerOpen(false)} />
        </aside>
      </div>

      {/* Main content */}
      <main className="lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-10 lg:py-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

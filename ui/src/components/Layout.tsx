import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/agent", label: "Agent activity" },
  { to: "/invoices", label: "Invoices" },
  { to: "/ledger", label: "Ledger" },
  { to: "/customers", label: "Customers" },
  { to: "/deals", label: "Deals" },
  { to: "/tickets", label: "Tickets" },
  { to: "/projects", label: "Projects" },
  { to: "/issues", label: "Issues" },
];

export function Layout() {
  const { logout, baseUrl, user } = useAuth();
  const navItems = user?.role === "admin" ? [...NAV_ITEMS, { to: "/users", label: "Users" }] : NAV_ITEMS;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">CompanyOS</div>
        <nav>
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={"end" in item ? item.end : undefined}
              className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          {user && (
            <div className="base-url" title={`${user.email} · ${user.role}`}>
              {user.email} · {user.role}
            </div>
          )}
          <div className="base-url" title={baseUrl}>
            {baseUrl}
          </div>
          <button className="link-button" onClick={logout}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const NAV_ITEMS = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/invoices", label: "Invoices" },
  { to: "/ledger", label: "Ledger" },
  { to: "/customers", label: "Customers" },
  { to: "/deals", label: "Deals" },
  { to: "/tickets", label: "Tickets" },
  { to: "/projects", label: "Projects" },
  { to: "/issues", label: "Issues" },
];

export function Layout() {
  const { logout, baseUrl } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">CompanyOS</div>
        <nav>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => "nav-link" + (isActive ? " active" : "")}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="base-url" title={baseUrl}>
            {baseUrl}
          </div>
          <button className="link-button" onClick={logout}>
            Disconnect
          </button>
        </div>
      </aside>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}

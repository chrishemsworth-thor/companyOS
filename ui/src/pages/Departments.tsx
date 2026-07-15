import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/Badge";
import { departmentsForRole, type Department } from "../lib/departments";

/**
 * The org lens: one card per department the current role may see. Live
 * departments link straight to the module surfaces they own; planned ones are
 * shown greyed so the whole company model — and what's coming next — is visible
 * in one place. The taxonomy is served canonically at GET /v1/meta/departments.
 */
export function Departments() {
  const { user } = useAuth();
  const departments = departmentsForRole(user?.role);
  const liveCount = departments.filter((d) => d.status === "live").length;

  return (
    <div>
      <PageHeader title="Departments">
        <span className="text-sm text-subtle">
          {liveCount} live · {departments.length - liveCount} planned
        </span>
      </PageHeader>

      <p className="mb-5 max-w-2xl text-sm text-muted">
        Departments are a lens over the shared modules, not separate silos —
        several read the same data (Sales and Customer Experience both use the
        customer record). Planned departments are part of the model but not yet
        built.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {departments.map((dept) => (
          <DepartmentCard key={dept.id} dept={dept} />
        ))}
      </div>
    </div>
  );
}

function DepartmentCard({ dept }: { dept: Department }) {
  const planned = dept.status === "planned";
  const Icon = dept.icon;
  return (
    <div
      className={
        "flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm" +
        (planned ? " opacity-70" : "")
      }
    >
      <div className="flex items-start justify-between gap-2">
        <span className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-md bg-surface-2 text-muted">
            <Icon className="size-5" />
          </span>
          <span className="font-semibold text-fg">{dept.label}</span>
        </span>
        <Badge tone={planned ? "neutral" : "good"}>{planned ? "Planned" : "Live"}</Badge>
      </div>

      <p className="text-sm text-muted">{dept.summary}</p>

      {dept.tools.length > 0 ? (
        <div className="mt-auto flex flex-wrap gap-2">
          {dept.tools.map((tool) => (
            <Link
              key={tool.route}
              to={tool.route}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-muted no-underline transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-fg hover:no-underline"
            >
              <tool.icon className="size-3.5" />
              {tool.label}
            </Link>
          ))}
        </div>
      ) : (
        <div className="mt-auto text-xs text-subtle">Not built yet</div>
      )}
    </div>
  );
}

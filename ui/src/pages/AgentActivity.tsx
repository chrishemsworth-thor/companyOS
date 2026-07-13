import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { AgentEventFeed, AGENT_EVENT_TYPES } from "../components/AgentEventFeed";
import { PageHeader } from "../components/PageHeader";

const FILTERS: { label: string; types: string[] }[] = [
  { label: "All agent activity", types: [...AGENT_EVENT_TYPES] },
  { label: "Decisions", types: ["collections.decision"] },
  { label: "Risk flags", types: ["customer.risk_flagged"] },
  { label: "Invoice events", types: ["invoice.overdue", "invoice.sent"] },
];

/**
 * Tenant-wide window into what the collections agent has been doing:
 * every decision, reminder, and escalation, newest first.
 */
export function AgentActivity() {
  const [filterIdx, setFilterIdx] = useState(0);
  const filter = FILTERS[filterIdx];

  return (
    <div>
      <PageHeader title="Agent activity">
        <div className="relative inline-flex">
          <select
            className="h-10 cursor-pointer appearance-none rounded-md border border-border bg-surface pl-3 pr-9 text-sm text-fg transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-ring"
            value={filterIdx}
            onChange={(e) => setFilterIdx(Number(e.target.value))}
          >
            {FILTERS.map((f, i) => (
              <option key={f.label} value={i}>
                {f.label}
              </option>
            ))}
          </select>
          <ChevronDown
            className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle"
            aria-hidden
          />
        </div>
      </PageHeader>
      <AgentEventFeed key={filter.label} types={filter.types} />
    </div>
  );
}

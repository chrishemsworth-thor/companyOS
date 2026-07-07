import { useState } from "react";
import { AgentEventFeed, AGENT_EVENT_TYPES } from "../components/AgentEventFeed";

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
      <div className="page-header">
        <h1>Agent activity</h1>
        <select
          className="filter-select"
          value={filterIdx}
          onChange={(e) => setFilterIdx(Number(e.target.value))}
        >
          {FILTERS.map((f, i) => (
            <option key={f.label} value={i}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <AgentEventFeed key={filter.label} types={filter.types} />
    </div>
  );
}

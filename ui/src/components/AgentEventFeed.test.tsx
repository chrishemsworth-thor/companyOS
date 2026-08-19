import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../auth/AuthContext";
import { AgentEventFeed, AGENT_EVENT_TYPES } from "./AgentEventFeed";

/**
 * PRD-002's console requirement: *"Console Agent Activity feed shows fallback
 * and override badges."*
 *
 * The fallback badge is the one that earns a tenant admin's trust — it says "no
 * model decided this, the template did" — and the override badge is the visible
 * half of the guardrail layer. Both are asserted here, plus the guardrail event
 * getting its own row, because a guardrail that fires invisibly is
 * indistinguishable from one that does not fire.
 */

const fetchMock = vi.fn();

const DECISION = {
  event_id: "evt_1",
  event_type: "collections.decision",
  source_module: "finance",
  occurred_at: "2026-08-19T04:00:00.000Z",
  trace_id: "trc_1",
  payload: {
    customer_id: "cust_1",
    risk_score: 61,
    action: "remind",
    channel: "email",
    message: "Gentle reminder about invoice inv_1.",
    source: "fallback",
    trigger: "event",
    invoice_id: "inv_1",
    provider: null,
    model: null,
    prompt_version: "collections-2026-08-19",
    input_tokens: null,
    output_tokens: null,
    latency_ms: 3,
    cost_micros: null,
    fallback_reason: "no_provider",
    guardrail_overridden: true,
    overrides: ["escalation_gate"],
    deferred_until: null,
  },
};

const OVERRIDE = {
  event_id: "evt_2",
  event_type: "guardrail.override",
  source_module: "finance",
  occurred_at: "2026-08-19T04:00:00.000Z",
  trace_id: "trc_1",
  payload: {
    agent: "collections",
    subject_type: "customer",
    subject_id: "cust_1",
    channel: "email",
    guardrail: "contact_window",
    outcome: "deferred",
    from_action: null,
    to_action: null,
    subject_ref: "inv_1",
    detail: "outside the contact window (non_working_day)",
    defer_until: "2026-08-24T01:00:00.000Z",
  },
};

/** A pre-S10 decision: no v2 fields at all. It must still render. */
const LEGACY_DECISION = {
  event_id: "evt_0",
  event_type: "collections.decision",
  source_module: "finance",
  occurred_at: "2026-07-01T04:00:00.000Z",
  trace_id: "trc_0",
  payload: {
    customer_id: "cust_1",
    risk_score: 40,
    action: "remind",
    channel: "email",
    message: "Older reminder.",
    source: "llm",
    trigger: "event",
  },
};

function stubEvents(items: unknown[]) {
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ items, next_cursor: null }), { status: 200 }),
  );
}

beforeEach(() => {
  sessionStorage.setItem("companyos_api_key", "key_test");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function renderFeed() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter>
          <AgentEventFeed />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("the agent activity feed", () => {
  it("badges a decision the fallback made, and the guardrail that changed it", async () => {
    stubEvents([DECISION]);
    renderFeed();

    await waitFor(() => expect(screen.getByText("fallback")).toBeTruthy());
    // The override badge names the rule in plain language, not by its enum.
    expect(screen.getByText(/guardrail: escalation too early/)).toBeTruthy();
  });

  it("shows how the decision was reached, on demand", async () => {
    stubEvents([DECISION]);
    renderFeed();

    await waitFor(() => expect(screen.getByText("message")).toBeTruthy());
    expect(screen.getByText(/prompt collections-2026-08-19/)).toBeTruthy();
    expect(screen.getByText(/fallback: no_provider/)).toBeTruthy();
  });

  it("gives a guardrail firing its own row, with what it did and when it retries", async () => {
    stubEvents([OVERRIDE]);
    renderFeed();

    await waitFor(() => expect(screen.getByText(/guardrail · deferred/)).toBeTruthy());
    expect(screen.getByText(/outside business hours/)).toBeTruthy();
    expect(screen.getByText(/outside the contact window/)).toBeTruthy();
    expect(screen.getByText(/retrying/)).toBeTruthy();
  });

  it("still renders a decision written before the v2 fields existed", async () => {
    // v1 events in events_log are history, not a bug: the badges simply do not
    // appear for them.
    stubEvents([LEGACY_DECISION]);
    renderFeed();

    await waitFor(() => expect(screen.getByText("llm")).toBeTruthy());
    expect(screen.queryByText(/guardrail:/)).toBeNull();
  });

  it("subscribes to the guardrail event, so overrides are visible at all", () => {
    expect([...AGENT_EVENT_TYPES]).toContain("guardrail.override");
  });
});

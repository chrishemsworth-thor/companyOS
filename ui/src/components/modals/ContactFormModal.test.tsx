import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../auth/AuthContext";
import { ContactFormModal } from "./ContactFormModal";
import type { Contact } from "../../api/types";

/**
 * PRD-003 console requirement: "role selection on contact create/edit".
 *
 * The load-bearing behaviour is that roles are the ONLY primary control. The
 * pre-PRD-003 modal had a standalone "Primary contact" checkbox; keeping both
 * would give one fact two controls that can disagree, so this asserts the old
 * one is gone.
 */

const fetchMock = vi.fn();
let lastPost: { url: string; body: Record<string, unknown> } | null = null;

const EXISTING: Contact = {
  contact_id: "contact_1",
  customer_id: "cust_1",
  name: "Ravi",
  title: "Finance Manager",
  department: null,
  email: "ravi@example.com",
  phone: null,
  is_primary: false,
  roles: ["billing", "technical"],
  created_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  sessionStorage.setItem("companyos_api_key", "key_test");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  lastPost = null;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" || init?.method === "PATCH") {
      lastPost = { url: String(url), body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ...EXISTING, contact_id: "contact_new" }), {
        status: init.method === "POST" ? 201 : 200,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

function renderModal(existing?: Contact) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ContactFormModal customerId="cust_1" existing={existing} onClose={vi.fn()} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("ContactFormModal role selection", () => {
  it("offers every role in the vocabulary", () => {
    renderModal();
    for (const label of ["Primary", "Billing", "Technical", "Signatory", "Other"]) {
      expect(screen.getByLabelText(label)).toBeDefined();
    }
  });

  it("has no standalone primary checkbox — the role IS the control", () => {
    renderModal();
    expect(screen.queryByLabelText("Primary contact")).toBeNull();
  });

  it("sends the selected roles on create", async () => {
    renderModal();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Aina" } });
    fireEvent.click(screen.getByLabelText("Billing"));
    fireEvent.click(screen.getByLabelText("Signatory"));
    fireEvent.click(screen.getByText("Add contact"));

    await waitFor(() => expect(lastPost).not.toBeNull());
    expect(lastPost!.body).toMatchObject({ name: "Aina", roles: ["billing", "signatory"] });
  });

  it("sends an empty role list when nothing is picked, so the API applies its default", async () => {
    // The API turns "no roles stated" into primary-if-first, other-otherwise.
    // The console must not guess that rule itself.
    renderModal();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unspecified" } });
    fireEvent.click(screen.getByText("Add contact"));

    await waitFor(() => expect(lastPost).not.toBeNull());
    expect(lastPost!.body.roles).toEqual([]);
  });

  it("pre-checks the existing roles when editing", () => {
    renderModal(EXISTING);
    expect((screen.getByLabelText("Billing") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Technical") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Primary") as HTMLInputElement).checked).toBe(false);
  });

  it("warns before a hand-over that will clear the current primary", () => {
    renderModal(EXISTING);
    expect(screen.queryByText(/clears the customer's current primary/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Primary"));
    expect(screen.getByText(/clears the customer's current primary/)).toBeDefined();
  });

  it("does not warn when the contact is already the primary", () => {
    renderModal({ ...EXISTING, is_primary: true, roles: ["primary", "billing"] });
    expect(screen.queryByText(/clears the customer's current primary/)).toBeNull();
  });

  it("un-checking a role removes it from the payload", async () => {
    renderModal(EXISTING);
    fireEvent.click(screen.getByLabelText("Technical"));
    fireEvent.click(screen.getByText("Save changes"));

    await waitFor(() => expect(lastPost).not.toBeNull());
    expect(lastPost!.body.roles).toEqual(["billing"]);
  });
});

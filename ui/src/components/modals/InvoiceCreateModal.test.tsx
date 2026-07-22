import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "../../auth/AuthContext";
import { InvoiceCreateModal } from "./InvoiceCreateModal";

const fetchMock = vi.fn();

beforeEach(() => {
  sessionStorage.setItem("companyos_api_key", "key_test");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/v1/settings/company-profile")) {
      return new Response(
        JSON.stringify({ company_profile: { legal_name: "Acme HQ", base_currency: "USD" } }),
        { status: 200 },
      );
    }
    if (String(url).includes("/v1/customers")) {
      return new Response(
        JSON.stringify({
          customers: [{ customer_id: "cust_1", name: "Acme", email: null, phone: null }],
          next_cursor: null,
        }),
        { status: 200 },
      );
    }
    if (String(url).endsWith("/v1/invoices") && init?.method === "POST") {
      return new Response(JSON.stringify({ invoice_id: "inv_new", status: "draft" }), {
        status: 201,
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

function renderModal(props: { onClose: () => void; onCreated?: (inv: unknown) => void }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <InvoiceCreateModal onClose={props.onClose} onCreated={props.onCreated} />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("InvoiceCreateModal", () => {
  it("submits the parsed invoice payload with an idempotency key", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    renderModal({ onClose, onCreated });

    await waitFor(() => expect(screen.getByText("Acme (cust_1)")).toBeDefined());
    fireEvent.change(screen.getByRole("combobox", { name: "Customer" }), {
      target: { value: "cust_1" },
    });
    // The currency select defaults to the company's base currency.
    await waitFor(() =>
      expect((screen.getByRole("combobox", { name: "Currency" }) as HTMLSelectElement).value).toBe(
        "USD",
      ),
    );

    const dateInput = document.querySelector('input[type="date"]')!;
    fireEvent.change(dateInput, { target: { value: "2026-08-01" } });
    fireEvent.change(screen.getByPlaceholderText("Description"), {
      target: { value: "Consulting" },
    });
    fireEvent.change(screen.getByPlaceholderText("Unit price"), { target: { value: "1200.50" } });

    fireEvent.click(screen.getByText("Create invoice"));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());

    const postCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    ) as [string, RequestInit];
    expect(JSON.parse(postCall[1].body as string)).toEqual({
      customer_id: "cust_1",
      currency: "USD",
      due_date: "2026-08-01",
      lines: [{ description: "Consulting", quantity: 1, unit_cents: 120_050 }],
    });
    expect((postCall[1].headers as Record<string, string>)["Idempotency-Key"]).toBeTruthy();
    expect(onClose).toHaveBeenCalled();
  });

  it("blocks submit and shows a validation error for an invalid unit price", async () => {
    renderModal({ onClose: vi.fn() });
    await waitFor(() => expect(screen.getByText("Acme (cust_1)")).toBeDefined());
    fireEvent.change(screen.getByRole("combobox", { name: "Customer" }), {
      target: { value: "cust_1" },
    });
    fireEvent.change(document.querySelector('input[type="date"]')!, {
      target: { value: "2026-08-01" },
    });
    fireEvent.change(screen.getByPlaceholderText("Description"), { target: { value: "X" } });
    fireEvent.change(screen.getByPlaceholderText("Unit price"), { target: { value: "abc" } });

    fireEvent.click(screen.getByText("Create invoice"));
    await waitFor(() =>
      expect(
        screen.getByText(/Each line needs a description, a positive quantity/),
      ).toBeDefined(),
    );
    expect(
      fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "POST"),
    ).toBe(false);
  });
});

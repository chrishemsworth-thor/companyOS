import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, ApiError } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function okResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

describe("ApiClient", () => {
  const client = new ApiClient("https://api.test", "key_123");

  it("post sends JSON with auth and optional Idempotency-Key", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await client.post("/v1/invoices", { a: 1 }, { idempotencyKey: "idem_1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/invoices");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer key_123");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toBe("idem_1");
  });

  it("post omits Idempotency-Key when not provided", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await client.post("/v1/tickets", { subject: "hi" });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers as Record<string, string>).not.toHaveProperty("Idempotency-Key");
  });

  it("patch sends a PATCH with the JSON body", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await client.patch("/v1/customers/c1", { name: "New" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/customers/c1");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ name: "New" }));
  });

  it("parses {error, code} bodies into ApiError", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "customer not found", code: "not_found" }), {
        status: 404,
      }),
    );
    const err = (await client
      .patch("/v1/customers/missing", { name: "x" })
      .catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.code).toBe("not_found");
    expect(err.message).toBe("customer not found");
  });
});

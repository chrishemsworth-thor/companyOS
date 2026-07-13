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
  const client = new ApiClient("https://api.test", { getCsrf: () => "csrf_123" });

  it("sends credentials and attaches CSRF + Idempotency-Key on POST", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await client.post("/v1/invoices", { a: 1 }, { idempotencyKey: "idem_1" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/invoices");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-CSRF-Token"]).toBe("csrf_123");
    expect(headers["Idempotency-Key"]).toBe("idem_1");
    // No bearer token — auth is the session cookie.
    expect(headers).not.toHaveProperty("Authorization");
  });

  it("does not attach a CSRF token on GET", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await client.get("/v1/customers");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe("include");
    expect(init.headers as Record<string, string>).not.toHaveProperty("X-CSRF-Token");
  });

  it("patch sends a PATCH with the JSON body and CSRF", async () => {
    fetchMock.mockResolvedValue(okResponse({ ok: true }));
    await client.patch("/v1/customers/c1", { name: "New" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/v1/customers/c1");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ name: "New" }));
    expect((init.headers as Record<string, string>)["X-CSRF-Token"]).toBe("csrf_123");
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

  it("invokes onUnauthorized when the server returns 401", async () => {
    const onUnauthorized = vi.fn();
    const c = new ApiClient("https://api.test", { onUnauthorized });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 401 }));
    await c.get("/v1/customers").catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

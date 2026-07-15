import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

/**
 * Multi-company: many companies coexist on one platform, provisioned through
 * the internal /admin API, each fully isolated. One user still belongs to
 * exactly one company, and email is unique *per company* — so the same email
 * can be an admin at two different companies (two distinct accounts), and login
 * disambiguates by workspace slug.
 */

const ORIGIN = "http://localhost:5173";
// Matches the dev placeholder in wrangler.jsonc "vars".
const PLATFORM_SECRET = "dev-insecure-platform-admin-secret-change-me";

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface Provisioned {
  tenant: { tenant_id: string; name: string; slug: string };
  api_key: string;
  admin: { user_id: string; email: string; role: string };
}

async function provision(
  body: Record<string, unknown>,
  auth: string | null = `Bearer ${PLATFORM_SECRET}`,
): Promise<Response> {
  return fetchWorker("/admin/tenants", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function login(workspace: string, email: string, password: string) {
  const res = await fetchWorker("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify({ workspace, email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    tenant?: { name: string };
    user?: { email: string; role: string };
  };
  return { status: res.status, body };
}

describe("platform provisioning is gated by the admin secret", () => {
  it("rejects a request with no Authorization header (401)", async () => {
    const res = await provision(
      { name: "NoAuth Co", slug: "noauth", admin_email: "a@noauth.test", admin_password: "password123" },
      null,
    );
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token (401)", async () => {
    const res = await provision(
      { name: "BadAuth Co", slug: "badauth", admin_email: "a@badauth.test", admin_password: "password123" },
      "Bearer not-the-secret",
    );
    expect(res.status).toBe(401);
  });
});

describe("creating and isolating companies", () => {
  it("provisions two companies that share an admin email, each loginable by its own workspace", async () => {
    const acmeRes = await provision({
      name: "Acme Inc",
      slug: "acme",
      admin_email: "founder@shared.test",
      admin_password: "acme-password",
    });
    expect(acmeRes.status).toBe(201);
    const acme = (await acmeRes.json()) as Provisioned;
    expect(acme.tenant.slug).toBe("acme");
    expect(acme.api_key).toMatch(/^cos_/);
    expect(acme.admin.role).toBe("admin");

    // Same email, different company — must succeed (email is unique per company).
    const globexRes = await provision({
      name: "Globex Corp",
      slug: "globex",
      admin_email: "founder@shared.test",
      admin_password: "globex-password",
    });
    expect(globexRes.status).toBe(201);
    const globex = (await globexRes.json()) as Provisioned;
    expect(globex.tenant.tenant_id).not.toBe(acme.tenant.tenant_id);

    // Each admin logs in with its own workspace + password.
    const acmeLogin = await login("acme", "founder@shared.test", "acme-password");
    expect(acmeLogin.status).toBe(200);
    expect(acmeLogin.body.tenant?.name).toBe("Acme Inc");

    const globexLogin = await login("globex", "founder@shared.test", "globex-password");
    expect(globexLogin.status).toBe(200);
    expect(globexLogin.body.tenant?.name).toBe("Globex Corp");

    // Cross-company credentials must not work: Acme's password in the Globex
    // workspace is rejected.
    const crossed = await login("globex", "founder@shared.test", "acme-password");
    expect(crossed.status).toBe(401);
  });

  it("rejects login against an unknown workspace with 401 (no company enumeration)", async () => {
    await provision({
      name: "Initech",
      slug: "initech",
      admin_email: "admin@initech.test",
      admin_password: "initech-password",
    });
    const res = await login("does-not-exist", "admin@initech.test", "initech-password");
    expect(res.status).toBe(401);
  });

  it("rejects a duplicate workspace slug (409)", async () => {
    const first = await provision({
      name: "Dup One",
      slug: "dup-co",
      admin_email: "a@dup1.test",
      admin_password: "password123",
    });
    expect(first.status).toBe(201);
    const second = await provision({
      name: "Dup Two",
      slug: "dup-co",
      admin_email: "a@dup2.test",
      admin_password: "password123",
    });
    expect(second.status).toBe(409);
  });

  it("keeps each company's data isolated across API-key callers", async () => {
    const aRes = await provision({
      name: "Isolation A",
      slug: "iso-a",
      admin_email: "admin@iso-a.test",
      admin_password: "password123",
    });
    const bRes = await provision({
      name: "Isolation B",
      slug: "iso-b",
      admin_email: "admin@iso-b.test",
      admin_password: "password123",
    });
    const a = (await aRes.json()) as Provisioned;
    const b = (await bRes.json()) as Provisioned;

    // Create a customer in company A using A's API key.
    const created = await fetchWorker("/v1/customers", {
      method: "POST",
      headers: { Authorization: `Bearer ${a.api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "A-only Customer" }),
    });
    expect(created.status).toBe(201);

    // Company B, using its own key, must not see A's customer.
    const bList = await fetchWorker("/v1/customers", {
      headers: { Authorization: `Bearer ${b.api_key}` },
    });
    expect(bList.status).toBe(200);
    const bBody = (await bList.json()) as { customers: { name: string }[] };
    expect(bBody.customers.some((cust) => cust.name === "A-only Customer")).toBe(false);

    // Company A sees exactly its own customer.
    const aList = await fetchWorker("/v1/customers", {
      headers: { Authorization: `Bearer ${a.api_key}` },
    });
    const aBody = (await aList.json()) as { customers: { name: string }[] };
    expect(aBody.customers.some((cust) => cust.name === "A-only Customer")).toBe(true);
  });
});

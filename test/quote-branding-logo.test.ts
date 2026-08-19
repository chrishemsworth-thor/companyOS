import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

/**
 * PRD-004 P0 — logo and branding assets.
 *
 * The criterion that carries this phase is the third one: a logo must render on
 * a page an unauthenticated customer opens, *"without exposing the tenant's
 * other files"*. That is SESSION-PLAN conflict C3, and S2 already resolved it
 * with per-purpose file policy — `quote_logo` is the only purpose the
 * credential-less `/files/:id` route will serve. This file proves it holds.
 */

const API_KEY = "test_api_key_qbrand";
const TENANT_ID = "biz_qbrand";
const OTHER_API_KEY = "test_api_key_qbrand_other";
const OTHER_TENANT_ID = "biz_qbrand_other";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const otherAuth = { Authorization: `Bearer ${OTHER_API_KEY}`, "Content-Type": "application/json" };

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** A one-pixel PNG, which is a real PNG as far as the content-type gate cares. */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

/**
 * Status of a request whose body is irrelevant — but which must still be
 * drained. A streamed R2 body left unread holds the bucket open and the
 * isolated-storage teardown between tests fails on it. Same helper, and the
 * same reason, as test/files.test.ts.
 */
async function statusOf(path: string, init?: RequestInit): Promise<number> {
  const res = await fetchWorker(path, init);
  await res.arrayBuffer();
  return res.status;
}

async function uploadFile(
  bytes: Uint8Array,
  purpose: string,
  contentType: string,
  headers = auth,
): Promise<Response> {
  const form = new FormData();
  form.append("file", new File([bytes], "logo.png", { type: contentType }));
  form.append("purpose", purpose);
  return fetchWorker("/v1/files", {
    method: "POST",
    headers: { Authorization: headers.Authorization },
    body: form,
  });
}

async function uploadLogo(headers = auth): Promise<string> {
  const res = await uploadFile(PNG_BYTES, "quote_logo", "image/png", headers);
  expect(res.status).toBe(201);
  return ((await res.json()) as { file_id: string }).file_id;
}

let customerId: string;

beforeAll(async () => {
  for (const [tenant, key, name] of [
    [TENANT_ID, API_KEY, "Branding SME"],
    [OTHER_TENANT_ID, OTHER_API_KEY, "Rival SME"],
  ] as const) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
    )
      .bind(tenant, name, await sha256Hex(key))
      .run();
  }
  await fetchWorker("/v1/settings/company-profile", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ legal_name: "Batik Works Sdn Bhd" }),
  });
  const res = await fetchWorker("/v1/customers", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Brand Buyer" }),
  });
  customerId = ((await res.json()) as { customer_id: string }).customer_id;
});

async function makeQuote(): Promise<string> {
  const res = await fetchWorker("/v1/quotes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: customerId,
      issue_date: "2026-07-16",
      lines: [{ item_name: "Brand identity", quantity: 1, unit_cents: 450_000 }],
    }),
  });
  return ((await res.json()) as { quote_id: string }).quote_id;
}

async function setBranding(body: Record<string, unknown>): Promise<Response> {
  return fetchWorker("/v1/settings/quote-branding", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify(body),
  });
}

async function documentHtml(quoteId: string): Promise<string> {
  const res = await fetchWorker(`/v1/quotes/${quoteId}/document`, { headers: auth });
  expect(res.status).toBe(200);
  return res.text();
}

describe("the logo on the document", () => {
  it("renders an uploaded logo, and the bytes are servable without a credential", async () => {
    const fileId = await uploadLogo();
    expect((await setBranding({ logo_file_id: fileId })).status).toBe(200);

    const html = await documentHtml(await makeQuote());
    expect(html).toContain(`<img class="logo" src="/files/${fileId}"`);
    expect(html).toContain('alt="Batik Works Sdn Bhd"');

    // The public route serves it with no Authorization header at all — this is
    // what makes the logo visible on the customer's quote page.
    const public_ = await fetchWorker(`/files/${fileId}`);
    expect(public_.status).toBe(200);
    expect(public_.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await public_.arrayBuffer())).toEqual(PNG_BYTES);
  });

  it("renders cleanly with the company name only when there is no logo", async () => {
    await setBranding({});
    const html = await documentHtml(await makeQuote());
    expect(html).toContain('<div class="logo-text">Batik Works Sdn Bhd</div>');
    expect(html).not.toContain('<img class="logo"');
  });

  it("prefers an uploaded logo over an external URL", async () => {
    const fileId = await uploadLogo();
    await setBranding({ logo_file_id: fileId, logo_url: "https://cdn.example.com/old.png" });
    const html = await documentHtml(await makeQuote());
    expect(html).toContain(`src="/files/${fileId}"`);
    expect(html).not.toContain("cdn.example.com");
  });

  it("still honours an external logo URL when no file is set", async () => {
    await setBranding({ logo_url: "https://cdn.example.com/legacy.png" });
    const html = await documentHtml(await makeQuote());
    expect(html).toContain('src="https://cdn.example.com/legacy.png"');
  });
});

describe("the public read is scoped to the logo purpose (C3)", () => {
  it("serves a quote_logo unauthenticated but 404s every other purpose", async () => {
    const logoId = await uploadLogo();

    const receipt = await uploadFile(PNG_BYTES, "claim_receipt", "image/png");
    expect(receipt.status).toBe(201);
    const receiptId = ((await receipt.json()) as { file_id: string }).file_id;

    const medical = await uploadFile(PNG_BYTES, "leave_attachment", "image/png");
    const medicalId = ((await medical.json()) as { file_id: string }).file_id;

    expect(await statusOf(`/files/${logoId}`)).toBe(200);

    // Same tenant, same route, same shape of id — and nothing comes back. The
    // public surface is a property of the PURPOSE, never of the caller.
    for (const id of [receiptId, medicalId]) {
      const res = await fetchWorker(`/files/${id}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain(id);
    }

    // And the tenant's own authenticated route still reaches them.
    expect(await statusOf(`/v1/files/${receiptId}`, { headers: auth })).toBe(200);
  });

  it("refuses a logo id belonging to another tenant, at settings time", async () => {
    const rivalLogo = await uploadLogo(otherAuth);
    const res = await setBranding({ logo_file_id: rivalLogo });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("invalid_logo");
    expect(body.error).toContain("does not name a file in this workspace");
  });

  it("refuses a file uploaded for a different purpose, and says why", async () => {
    const receipt = await uploadFile(PNG_BYTES, "claim_receipt", "image/png");
    const receiptId = ((await receipt.json()) as { file_id: string }).file_id;
    const res = await setBranding({ logo_file_id: receiptId });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("purpose 'claim_receipt'");
  });
});

describe("the logo policy limits (PRD-004 constraints)", () => {
  it("accepts PNG, JPEG and WebP and rejects a PDF", async () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      expect((await uploadFile(PNG_BYTES, "quote_logo", type)).status).toBe(201);
    }
    const pdf = await uploadFile(PNG_BYTES, "quote_logo", "application/pdf");
    expect(pdf.status).toBe(415);
    expect(((await pdf.json()) as { error: string }).error).toContain("quote_logo");
  });

  it("caps a logo at 2 MB, below the 10 MB default other purposes get", async () => {
    const tooBig = new Uint8Array(2 * 1024 * 1024 + 1024);
    tooBig.set(PNG_BYTES);
    const res = await uploadFile(tooBig, "quote_logo", "image/png");
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toContain("2 MB");

    // The same bytes are fine for a purpose that keeps the default ceiling.
    expect((await uploadFile(tooBig, "claim_receipt", "image/png")).status).toBe(201);
  });
});

describe("accent colour and footer text", () => {
  it("renders the configured colours, font and footer on the document", async () => {
    await setBranding({
      primary_color: "#7b2d26",
      accent_color: "#2f4858",
      font_family: "Georgia, serif",
      footer_text: "Maybank 5140 2233 1100 · SSM 202401000123 · SST W10-1234-56789",
    });
    const html = await documentHtml(await makeQuote());
    expect(html).toContain("--primary: #7b2d26;");
    expect(html).toContain("--accent: #2f4858;");
    expect(html).toContain("font-family: Georgia, serif;");
    expect(html).toContain('<footer class="doc-footer">');
    expect(html).toContain("Maybank 5140 2233 1100");
  });

  it("omits the footer entirely when it is not set", async () => {
    await setBranding({ footer_text: null });
    const html = await documentHtml(await makeQuote());
    // The rule stays in the stylesheet (it is one shared sheet); the ELEMENT is
    // what must be absent.
    expect(html).not.toContain('<footer class="doc-footer">');
  });

  it("escapes footer text rather than letting it inject markup", async () => {
    await setBranding({ footer_text: '</footer><script>alert("xss")</script>' });
    const html = await documentHtml(await makeQuote());
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

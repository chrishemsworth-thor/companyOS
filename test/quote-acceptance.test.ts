import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { AGREEMENT_VERSION } from "../src/modules/quotes/agreement";

/**
 * PRD-004 Phase C — click-to-sign acceptance and its audit record.
 *
 * Two criteria carry the whole feature, and they are the first two tests here:
 *
 *   - the stored artifact's SHA-256 equals the hash in the acceptance record;
 *   - the archived artifact renders identically after the tenant changes their
 *     branding settings.
 *
 * If either fails, a CompanyOS quote has no more evidentiary value than the
 * emailed PDF PRD-004 set out to replace.
 */

const API_KEY = "test_api_key_qacc";
const TENANT_ID = "biz_qacc";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

function inlineEnv(): typeof env {
  const bare: Partial<typeof env> = { ...env };
  delete bare.EVENTS;
  return bare as typeof env;
}

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), inlineEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Drain a body we do not inspect: an unread R2 stream breaks storage teardown. */
async function statusOf(path: string, init?: RequestInit): Promise<number> {
  const res = await fetchWorker(path, init);
  await res.arrayBuffer();
  return res.status;
}

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function pngDataUrl(): string {
  let binary = "";
  for (const b of PNG_BYTES) binary += String.fromCharCode(b);
  return `data:image/png;base64,${btoa(binary)}`;
}

async function digestOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let customerId: string;

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Signing SME", await sha256Hex(API_KEY))
    .run();
  await fetchWorker("/v1/settings/company-profile", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ legal_name: "Kopi Systems Sdn Bhd" }),
  });
  const res = await fetchWorker("/v1/customers", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Signing Buyer" }),
  });
  customerId = ((await res.json()) as { customer_id: string }).customer_id;
});

interface Prepared {
  quoteId: string;
  token: string;
}

async function prepare(extra: Record<string, unknown> = {}): Promise<Prepared> {
  const created = await fetchWorker("/v1/quotes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: customerId,
      issue_date: "2026-07-16",
      lines: [{ item_name: "Platform licence", quantity: 12, unit_cents: 75_000 }],
      ...extra,
    }),
  });
  const { quote_id } = (await created.json()) as { quote_id: string };
  await fetchWorker(`/v1/quotes/${quote_id}/send`, { method: "POST", headers: auth });
  const link = await fetchWorker(`/v1/quotes/${quote_id}/link`, { method: "POST", headers: auth });
  const { token } = (await link.json()) as { token: string };
  return { quoteId: quote_id, token };
}

interface AcceptanceResp {
  acceptance_id: string;
  decision: string;
  signatory_name: string;
  signatory_email: string;
  contact_id: string | null;
  contact_match: string | null;
  agreement_version: string;
  agreement_text: string;
  document_sha256: string | null;
  artifact_file_id: string | null;
  signature_file_id: string | null;
  decline_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
}

async function accept(
  token: string,
  body: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetchWorker(`/q/${token}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      signatory_name: "Nurul Aziz",
      signatory_email: "nurul@signingbuyer.example",
      agreed: true,
      ...body,
    }),
  });
}

describe("the acceptance record proves what was signed", () => {
  it("stores a SHA-256 equal to the archived artifact's own hash", async () => {
    const { quoteId, token } = await prepare();
    const res = await accept(token);
    expect(res.status).toBe(201);
    const record = (await res.json()) as AcceptanceResp;

    expect(record.document_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.artifact_file_id).toBeTruthy();

    // 1. The files primitive's own digest of the bytes it stored.
    const file = await env.DB.prepare(
      "SELECT sha256, content_type, purpose FROM files WHERE tenant_id = ? AND file_id = ?",
    )
      .bind(TENANT_ID, record.artifact_file_id)
      .first<{ sha256: string; content_type: string; purpose: string }>();
    expect(file!.purpose).toBe("quote_artifact");
    expect(file!.content_type).toBe("text/html");
    expect(file!.sha256).toBe(record.document_sha256);

    // 2. And a digest computed here, from the bytes actually served back. This
    //    is the criterion end to end: what a reader can download hashes to what
    //    the record claims was agreed.
    const served = await fetchWorker(`/v1/quotes/${quoteId}/artifact`, { headers: auth });
    expect(served.status).toBe(200);
    const html = await served.text();
    expect(await digestOf(html)).toBe(record.document_sha256);
    expect(served.headers.get("ETag")).toBe(`"${record.document_sha256}"`);
  });

  it("renders identically after the tenant changes their branding", async () => {
    const logo = new FormData();
    logo.append("file", new File([PNG_BYTES], "old-logo.png", { type: "image/png" }));
    logo.append("purpose", "quote_logo");
    const uploaded = await fetchWorker("/v1/files", {
      method: "POST",
      headers: { Authorization: auth.Authorization },
      body: logo,
    });
    const oldLogoId = ((await uploaded.json()) as { file_id: string }).file_id;

    await fetchWorker("/v1/settings/quote-branding", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        logo_file_id: oldLogoId,
        primary_color: "#0b7285",
        accent_color: "#495057",
        font_family: "Palatino, serif",
        footer_text: "Old bank details: Maybank 1111",
      }),
    });

    const { quoteId, token } = await prepare();
    const record = (await (await accept(token)).json()) as AcceptanceResp;
    const before = await (await fetchWorker(`/q/${token}/artifact`)).text();

    // Everything the tenant can change about their branding, changed — and the
    // old logo file deleted outright, which is the case a `/files/{id}`
    // reference would not have survived.
    expect(await statusOf(`/v1/files/${oldLogoId}`, { method: "DELETE", headers: auth })).toBe(204);
    await fetchWorker("/v1/settings/quote-branding", {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({
        primary_color: "#c92a2a",
        accent_color: "#e8590c",
        font_family: "Courier New, monospace",
        footer_text: "New bank details: CIMB 9999",
      }),
    });

    const after = await (await fetchWorker(`/q/${token}/artifact`)).text();

    expect(after).toBe(before);
    expect(await digestOf(after)).toBe(record.document_sha256);
    // None of the new branding leaked in...
    expect(after).not.toContain("#c92a2a");
    expect(after).not.toContain("CIMB 9999");
    expect(after).not.toContain("Courier New");
    // ...and the branding that was in force at signing is still there.
    expect(after).toContain("#0b7285");
    expect(after).toContain("Maybank 1111");
    // The logo is inlined, not referenced — which is why deleting it changed nothing.
    expect(after).toContain("data:image/png;base64,");
    expect(after).not.toContain(`/files/${oldLogoId}`);

    // The live document, by contrast, has moved on. The artifact being frozen
    // is not the renderer being broken.
    const live = await (await fetchWorker(`/v1/quotes/${quoteId}/document`, { headers: auth })).text();
    expect(live).toContain("#c92a2a");
    expect(live).toContain("CIMB 9999");
  });
});

describe("the audit record", () => {
  it("captures name, email, IP, user agent, timestamp and the agreement text", async () => {
    const { quoteId, token } = await prepare();
    const res = await accept(
      token,
      {},
      { "CF-Connecting-IP": "203.0.113.42", "User-Agent": "Mozilla/5.0 (SigningPhone)" },
    );
    const record = (await res.json()) as AcceptanceResp;

    expect(record.decision).toBe("accepted");
    expect(record.signatory_name).toBe("Nurul Aziz");
    expect(record.signatory_email).toBe("nurul@signingbuyer.example");
    expect(record.ip_address).toBe("203.0.113.42");
    expect(record.user_agent).toBe("Mozilla/5.0 (SigningPhone)");
    expect(record.agreement_version).toBe(AGREEMENT_VERSION);
    // Stored verbatim, not as a pointer: a record that re-renders under new
    // wording is not a record.
    expect(record.agreement_text).toContain("authorised to accept this quotation");

    const listed = await fetchWorker(`/v1/quotes/${quoteId}/acceptances`, { headers: auth });
    const body = (await listed.json()) as {
      acceptances: AcceptanceResp[];
      accepted_acceptance_id: string;
    };
    expect(body.acceptances).toHaveLength(1);
    expect(body.accepted_acceptance_id).toBe(record.acceptance_id);

    // And the artifact itself carries the audit panel, so it reads as evidence
    // on its own without this system.
    const html = await (await fetchWorker(`/q/${token}/artifact`)).text();
    expect(html).toContain("Electronic acceptance record");
    expect(html).toContain("203.0.113.42");
    expect(html).toContain("Mozilla/5.0 (SigningPhone)");
    expect(html).toContain(AGREEMENT_VERSION);
  });

  it("emits quote.accepted carrying the hash and the acceptance id", async () => {
    const { quoteId, token } = await prepare();
    const record = (await (await accept(token)).json()) as AcceptanceResp;

    const row = await env.DB.prepare(
      "SELECT payload FROM events_log WHERE event_type = 'quote.accepted' AND payload LIKE ?",
    )
      .bind(`%${quoteId}%`)
      .first<{ payload: string }>();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.payload)).toMatchObject({
      quote_id: quoteId,
      customer_id: customerId,
      acceptance_id: record.acceptance_id,
      document_sha256: record.document_sha256,
      signatory_email: "nurul@signingbuyer.example",
    });
  });

  it("stores a drawn signature as its own file and inlines it in the artifact", async () => {
    const { token } = await prepare();
    const record = (await (await accept(token, { signature_data_url: pngDataUrl() })).json()) as AcceptanceResp;

    expect(record.signature_file_id).toBeTruthy();
    const file = await env.DB.prepare("SELECT purpose FROM files WHERE tenant_id = ? AND file_id = ?")
      .bind(TENANT_ID, record.signature_file_id)
      .first<{ purpose: string }>();
    expect(file!.purpose).toBe("signature");

    const html = await (await fetchWorker(`/q/${token}/artifact`)).text();
    expect(html).toContain('class="sig-image"');
    // Inlined, not referenced — the artifact must not depend on a live file.
    expect(html).not.toContain(`/files/${record.signature_file_id}`);
  });

  it("keeps a signature out of the public file route", async () => {
    const { token } = await prepare();
    const record = (await (await accept(token, { signature_data_url: pngDataUrl() })).json()) as AcceptanceResp;
    expect(await statusOf(`/files/${record.signature_file_id}`)).toBe(404);
    expect(await statusOf(`/files/${record.artifact_file_id}`)).toBe(404);
  });
});

describe("acceptance is refused when it should be", () => {
  it("rejects acceptance without the agreement box ticked, and records nothing", async () => {
    const { quoteId, token } = await prepare();
    for (const agreed of [false, "true", 1, null, undefined]) {
      const res = await accept(token, { agreed });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toContain("agreement must be accepted");
    }

    const after = await env.DB.prepare("SELECT status FROM quotes WHERE tenant_id = ? AND quote_id = ?")
      .bind(TENANT_ID, quoteId)
      .first<{ status: string }>();
    expect(after!.status).toBe("sent");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM quote_acceptances WHERE tenant_id = ? AND quote_id = ?",
    )
      .bind(TENANT_ID, quoteId)
      .first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("requires a name and an email", async () => {
    const { token } = await prepare();
    expect((await accept(token, { signatory_name: "   " })).status).toBe(422);
    expect((await accept(token, { signatory_email: "" })).status).toBe(422);
  });

  it("409s a second acceptance", async () => {
    const { token } = await prepare();
    expect((await accept(token)).status).toBe(201);
    const twice = await accept(token);
    expect(twice.status).toBe(409);
    expect(((await twice.json()) as { error: string }).error).toContain("already been accepted");
  });

  it("refuses acceptance on an expired quote, and offers no Accept control", async () => {
    const { quoteId, token } = await prepare({ expiry_date: "2026-08-31" });
    await env.DB.prepare("UPDATE quotes SET status = 'expired' WHERE tenant_id = ? AND quote_id = ?")
      .bind(TENANT_ID, quoteId)
      .run();

    const res = await accept(token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("expired");

    const page = await (await fetchWorker(`/q/${token}`)).text();
    expect(page).not.toContain("Accept quotation");
    expect(page).toContain("has expired");
  });

  it("refuses acceptance through a revoked link even while the quote is open", async () => {
    const { quoteId, token } = await prepare();
    await fetchWorker(`/v1/quotes/${quoteId}/link`, { method: "DELETE", headers: auth });
    const res = await accept(token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("no longer active");
  });

  it("404s a signing attempt on an unknown token, with no detail", async () => {
    const res = await accept("f".repeat(64));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("this link is not valid");
  });
});

describe("declining", () => {
  it("records the decline with its reason and emits quote.rejected", async () => {
    const { quoteId, token } = await prepare();
    const res = await fetchWorker(`/q/${token}/decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signatory_name: "Nurul Aziz",
        signatory_email: "nurul@signingbuyer.example",
        reason: "Budget moved to next quarter",
      }),
    });
    expect(res.status).toBe(201);
    const record = (await res.json()) as AcceptanceResp;
    expect(record.decision).toBe("declined");
    expect(record.decline_reason).toBe("Budget moved to next quarter");
    // Nothing was agreed, so there is nothing to freeze.
    expect(record.artifact_file_id).toBeNull();
    expect(record.document_sha256).toBeNull();

    const quote = await env.DB.prepare("SELECT status FROM quotes WHERE tenant_id = ? AND quote_id = ?")
      .bind(TENANT_ID, quoteId)
      .first<{ status: string }>();
    expect(quote!.status).toBe("rejected");

    const row = await env.DB.prepare(
      "SELECT payload FROM events_log WHERE event_type = 'quote.rejected' AND payload LIKE ?",
    )
      .bind(`%${quoteId}%`)
      .first<{ payload: string }>();
    expect(JSON.parse(row!.payload)).toMatchObject({
      quote_id: quoteId,
      reason: "Budget moved to next quarter",
    });
  });

  it("allows a decline with no reason at all", async () => {
    const { token } = await prepare();
    const res = await fetchWorker(`/q/${token}/decline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signatory_name: "A B", signatory_email: "ab@example.com" }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as AcceptanceResp).decline_reason).toBeNull();
  });
});

describe("the signatory contact (PRD-003, via S8)", () => {
  async function customerWithSignatory(): Promise<string> {
    const res = await fetchWorker("/v1/customers", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "Contactful Bhd" }),
    });
    const { customer_id } = (await res.json()) as { customer_id: string };
    await fetchWorker(`/v1/customers/${customer_id}/contacts`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "Rania Bakar",
        email: "rania@contactful.example",
        roles: ["signatory"],
      }),
    });
    return customer_id;
  }

  it("pre-fills the form from the signatory contact and records the match", async () => {
    const withContact = await customerWithSignatory();
    const created = await fetchWorker("/v1/quotes", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: withContact,
        issue_date: "2026-07-16",
        lines: [{ item_name: "Retainer", quantity: 1, unit_cents: 300_000 }],
      }),
    });
    const { quote_id } = (await created.json()) as { quote_id: string };
    await fetchWorker(`/v1/quotes/${quote_id}/send`, { method: "POST", headers: auth });
    const { token } = (await (
      await fetchWorker(`/v1/quotes/${quote_id}/link`, { method: "POST", headers: auth })
    ).json()) as { token: string };

    const page = await (await fetchWorker(`/q/${token}`)).text();
    expect(page).toContain('value="Rania Bakar"');
    expect(page).toContain('value="rania@contactful.example"');

    const record = (await (
      await accept(token, {
        signatory_name: "Rania Bakar",
        signatory_email: "rania@contactful.example",
      })
    ).json()) as AcceptanceResp;
    expect(record.contact_id).toBeTruthy();
    expect(record.contact_match).toBe("role");
  });

  it("records no attribution when somebody unrecognised signs", async () => {
    const withContact = await customerWithSignatory();
    const created = await fetchWorker("/v1/quotes", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: withContact,
        issue_date: "2026-07-16",
        lines: [{ item_name: "Retainer", quantity: 1, unit_cents: 300_000 }],
      }),
    });
    const { quote_id } = (await created.json()) as { quote_id: string };
    await fetchWorker(`/v1/quotes/${quote_id}/send`, { method: "POST", headers: auth });
    const { token } = (await (
      await fetchWorker(`/v1/quotes/${quote_id}/link`, { method: "POST", headers: auth })
    ).json()) as { token: string };

    const record = (await (
      await accept(token, { signatory_name: "Someone Else", signatory_email: "who@elsewhere.example" })
    ).json()) as AcceptanceResp;
    // "We have never heard of this person" is exactly the fact an audit reader
    // needs to see, so it is not papered over with the expected contact.
    expect(record.contact_id).toBeNull();
    expect(record.contact_match).toBeNull();
  });

  it("leaves the form blank for a customer with no contacts", async () => {
    const { token } = await prepare();
    const page = await (await fetchWorker(`/q/${token}`)).text();
    expect(page).toContain('id="sig-name"');
    expect(page).toContain('value=""');
  });
});

describe("conversion carries the acceptance", () => {
  it("links the invoice to the acceptance record and keeps the artifact retrievable", async () => {
    const { quoteId, token } = await prepare();
    const record = (await (await accept(token)).json()) as AcceptanceResp;

    const converted = await fetchWorker(`/v1/quotes/${quoteId}/convert`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({}),
    });
    expect(converted.status).toBe(201);
    const { invoice_id } = (await converted.json()) as { invoice_id: string };

    const invoice = (await (
      await fetchWorker(`/v1/invoices/${invoice_id}`, { headers: auth })
    ).json()) as { quote_id: string; quote_acceptance_id: string };
    expect(invoice.quote_id).toBe(quoteId);
    expect(invoice.quote_acceptance_id).toBe(record.acceptance_id);

    // And the evidence still resolves after conversion, from both surfaces.
    const viaConsole = await fetchWorker(`/v1/quotes/${quoteId}/artifact`, { headers: auth });
    expect(viaConsole.status).toBe(200);
    expect(await digestOf(await viaConsole.text())).toBe(record.document_sha256);
    expect((await fetchWorker(`/q/${token}/artifact`)).status).toBe(200);
  });

  it("404s the artifact for a quote nobody has signed", async () => {
    const { quoteId } = await prepare();
    const res = await fetchWorker(`/v1/quotes/${quoteId}/artifact`, { headers: auth });
    expect(res.status).toBe(404);
  });
});

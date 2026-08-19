import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { MISS_LIMIT } from "../src/gateway/routes/public-quotes";

/**
 * PRD-004 Phase B — the public, token-addressed quote link.
 *
 * The properties under test are all evidentiary or defensive: the token is
 * high-entropy and stored hashed, a stale link explains itself instead of
 * 404ing, a guessed one leaks nothing, and `quote.viewed.v1` fires exactly once
 * however many times the customer reloads.
 */

const API_KEY = "test_api_key_qlink";
const TENANT_ID = "biz_qlink";
const OTHER_API_KEY = "test_api_key_qlink_other";
const OTHER_TENANT_ID = "biz_qlink_other";
const auth = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };
const otherAuth = { Authorization: `Bearer ${OTHER_API_KEY}`, "Content-Type": "application/json" };

/**
 * Requests run against an environment with **no EVENTS binding**, so
 * `ensureEventBus()` substitutes the inline free-plan bus and every emitted
 * event lands in `events_log` synchronously.
 *
 * With the real queue binding, delivery happens outside the test's
 * isolated-storage frame and nothing is observable — which is why the approvals
 * and leave suites assert events the same way. Here it matters more than
 * usual: `quote.viewed` firing exactly once is an acceptance criterion, and a
 * test that cannot see the event cannot check it.
 */
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

interface LinkResp {
  link_id: string;
  quote_id: string;
  token: string;
  url: string;
  expires_at: string | null;
  revoked_at: string | null;
}

let customerId: string;

beforeAll(async () => {
  for (const [tenant, key, name] of [
    [TENANT_ID, API_KEY, "Public Link SME"],
    [OTHER_TENANT_ID, OTHER_API_KEY, "Other SME"],
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
    body: JSON.stringify({ legal_name: "Ampersand Digital Sdn Bhd" }),
  });
  const res = await fetchWorker("/v1/customers", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Viewer Co" }),
  });
  customerId = ((await res.json()) as { customer_id: string }).customer_id;
});

/** A quote already moved to `sent`, which is where a link becomes mintable. */
async function sentQuote(extra: Record<string, unknown> = {}): Promise<string> {
  const created = await fetchWorker("/v1/quotes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: customerId,
      issue_date: "2026-07-16",
      lines: [{ item_name: "Website build", quantity: 1, unit_cents: 900_000 }],
      ...extra,
    }),
  });
  const { quote_id } = (await created.json()) as { quote_id: string };
  await fetchWorker(`/v1/quotes/${quote_id}/send`, { method: "POST", headers: auth });
  return quote_id;
}

async function mintLink(quoteId: string): Promise<LinkResp> {
  const res = await fetchWorker(`/v1/quotes/${quoteId}/link`, { method: "POST", headers: auth });
  expect(res.status).toBe(201);
  return (await res.json()) as LinkResp;
}

async function viewedEvents(quoteId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM events_log WHERE event_type = 'quote.viewed' AND payload LIKE ?",
  )
    .bind(`%${quoteId}%`)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("minting and revoking", () => {
  it("returns the raw token exactly once and stores only its hash", async () => {
    const quoteId = await sentQuote();
    const link = await mintLink(quoteId);

    expect(link.token).toMatch(/^[0-9a-f]{64}$/);
    expect(link.url).toBe(`https://gateway.test/q/${link.token}`);

    const stored = await env.DB.prepare(
      "SELECT token_hash FROM quote_links WHERE tenant_id = ? AND link_id = ?",
    )
      .bind(TENANT_ID, link.link_id)
      .first<{ token_hash: string }>();
    expect(stored!.token_hash).toBe(await sha256Hex(link.token));
    expect(stored!.token_hash).not.toBe(link.token);

    // The metadata endpoint can never hand the token back.
    const meta = await fetchWorker(`/v1/quotes/${quoteId}/link`, { headers: auth });
    expect(meta.status).toBe(200);
    expect(await meta.text()).not.toContain(link.token);
  });

  it("aligns the link expiry to the quote's own expiry date", async () => {
    const quoteId = await sentQuote({ expiry_date: "2026-08-31" });
    const link = await mintLink(quoteId);
    expect(link.expires_at).toBe("2026-08-31T23:59:59.999Z");
  });

  it("refuses to mint a link for a draft or a quote awaiting sign-off", async () => {
    const created = await fetchWorker("/v1/quotes", {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        customer_id: customerId,
        issue_date: "2026-07-16",
        lines: [{ item_name: "Draft work", quantity: 1, unit_cents: 1_000 }],
      }),
    });
    const { quote_id } = (await created.json()) as { quote_id: string };

    const onDraft = await fetchWorker(`/v1/quotes/${quote_id}/link`, { method: "POST", headers: auth });
    expect(onDraft.status).toBe(409);

    await env.DB.prepare("UPDATE quotes SET status = 'pending_approval' WHERE tenant_id = ? AND quote_id = ?")
      .bind(TENANT_ID, quote_id)
      .run();
    const onPending = await fetchWorker(`/v1/quotes/${quote_id}/link`, { method: "POST", headers: auth });
    expect(onPending.status).toBe(409);
  });

  it("minting again revokes the previous link, so only one token ever works", async () => {
    const quoteId = await sentQuote();
    const first = await mintLink(quoteId);
    const second = await mintLink(quoteId);
    expect(second.token).not.toBe(first.token);

    const oldPage = await fetchWorker(`/q/${first.token}`);
    expect(await oldPage.text()).toContain("no longer active");
    const newPage = await fetchWorker(`/q/${second.token}`);
    expect(newPage.status).toBe(200);
    expect(await newPage.text()).toContain("awaiting your response");
  });

  it("revokes on request, and 404s a revoke when there is no live link", async () => {
    const quoteId = await sentQuote();
    const link = await mintLink(quoteId);
    expect((await fetchWorker(`/v1/quotes/${quoteId}/link`, { method: "DELETE", headers: auth })).status).toBe(204);
    expect((await fetchWorker(`/v1/quotes/${quoteId}/link`, { method: "DELETE", headers: auth })).status).toBe(404);
    expect((await fetchWorker(`/v1/quotes/${quoteId}/link`, { headers: auth })).status).toBe(404);

    const page = await fetchWorker(`/q/${link.token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("no longer active");
  });

  it("does not let one tenant mint a link on another tenant's quote", async () => {
    const quoteId = await sentQuote();
    const res = await fetchWorker(`/v1/quotes/${quoteId}/link`, { method: "POST", headers: otherAuth });
    expect(res.status).toBe(404);
  });
});

describe("the public page", () => {
  it("renders the branded document with no console chrome", async () => {
    const quoteId = await sentQuote();
    const link = await mintLink(quoteId);

    const res = await fetchWorker(`/q/${link.token}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toContain("noindex");

    const html = await res.text();
    expect(html).toContain("Ampersand Digital Sdn Bhd");
    expect(html).toContain("Website build");
    expect(html).toContain("QUOTATION");
    // No console chrome: nothing that only makes sense to a logged-in operator.
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain("/v1/");
    expect(html.toLowerCase()).not.toContain("<nav");
  });

  it("emits quote.viewed once however many times it is opened", async () => {
    const quoteId = await sentQuote();
    const link = await mintLink(quoteId);

    await fetchWorker(`/q/${link.token}`);
    await fetchWorker(`/q/${link.token}`);
    await fetchWorker(`/q/${link.token}`);

    expect(await viewedEvents(quoteId)).toBe(1);

    const quote = await env.DB.prepare(
      "SELECT first_viewed_at, last_viewed_at, view_count FROM quotes WHERE tenant_id = ? AND quote_id = ?",
    )
      .bind(TENANT_ID, quoteId)
      .first<{ first_viewed_at: string; last_viewed_at: string; view_count: number }>();
    expect(quote!.view_count).toBe(3);
    expect(quote!.first_viewed_at).not.toBeNull();
    expect(quote!.last_viewed_at >= quote!.first_viewed_at).toBe(true);
  });

  it("records the viewer's IP and user agent on the event", async () => {
    const quoteId = await sentQuote();
    const link = await mintLink(quoteId);
    await fetchWorker(`/q/${link.token}`, {
      headers: { "CF-Connecting-IP": "203.0.113.7", "User-Agent": "Mozilla/5.0 (TestBrowser)" },
    });

    const row = await env.DB.prepare(
      "SELECT payload FROM events_log WHERE event_type = 'quote.viewed' AND payload LIKE ?",
    )
      .bind(`%${quoteId}%`)
      .first<{ payload: string }>();
    const payload = JSON.parse(row!.payload) as Record<string, string>;
    expect(payload.ip_address).toBe("203.0.113.7");
    expect(payload.user_agent).toBe("Mozilla/5.0 (TestBrowser)");
    expect(payload.customer_id).toBe(customerId);
  });

  it("explains an expired link rather than 404ing, and still shows the document", async () => {
    const quoteId = await sentQuote({ expiry_date: "2026-08-31" });
    const link = await mintLink(quoteId);
    await env.DB.prepare("UPDATE quote_links SET expires_at = ? WHERE tenant_id = ? AND link_id = ?")
      .bind("2020-01-01T00:00:00.000Z", TENANT_ID, link.link_id)
      .run();

    const res = await fetchWorker(`/q/${link.token}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("expired");
    expect(html).toContain("updated quotation");
    // The document is still there: "you can no longer accept it" is only useful
    // alongside what "it" was.
    expect(html).toContain("Website build");
  });

  it("shows the quote's own outcome ahead of the link's condition", async () => {
    const quoteId = await sentQuote();
    const link = await mintLink(quoteId);
    await env.DB.prepare("UPDATE quotes SET status = 'accepted' WHERE tenant_id = ? AND quote_id = ?")
      .bind(TENANT_ID, quoteId)
      .run();
    await env.DB.prepare("UPDATE quote_links SET expires_at = ? WHERE tenant_id = ? AND link_id = ?")
      .bind("2020-01-01T00:00:00.000Z", TENANT_ID, link.link_id)
      .run();

    const html = await (await fetchWorker(`/q/${link.token}`)).text();
    expect(html).toContain("has been accepted");
    expect(html).not.toContain("has expired");
  });
});

describe("a guessed token leaks nothing", () => {
  it("404s an unknown, malformed and well-formed-but-wrong token identically", async () => {
    const quoteId = await sentQuote();
    await mintLink(quoteId);

    const wellFormed = await fetchWorker(`/q/${"a".repeat(64)}`);
    const malformed = await fetchWorker("/q/not-a-token");
    const empty = await fetchWorker(`/q/${"0".repeat(64)}`);

    for (const res of [wellFormed, malformed, empty]) {
      expect(res.status).toBe(404);
    }
    const bodies = await Promise.all([wellFormed.text(), malformed.text(), empty.text()]);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain("not valid");
    // Nothing about quotes, tenants or ids.
    expect(bodies[0]).not.toContain("quote_");
    expect(bodies[0]).not.toContain("biz_");
  });

  it("throttles token guessing without counting a customer's own re-reads", async () => {
    const quoteId = await sentQuote();
    const link = await mintLink(quoteId);

    // A real customer reading their quote repeatedly is never throttled by the
    // miss limit — only genuine misses count against it.
    for (let i = 0; i < 5; i++) {
      expect((await fetchWorker(`/q/${link.token}`, { headers: { "CF-Connecting-IP": "198.51.100.4" } })).status).toBe(200);
    }

    let sawRateLimit = false;
    for (let i = 0; i <= MISS_LIMIT; i++) {
      const res = await fetchWorker(`/q/${i.toString(16).padStart(64, "0")}`, {
        headers: { "CF-Connecting-IP": "198.51.100.4" },
      });
      if (res.status === 429) {
        expect(((await res.json()) as { code: string }).code).toBe("rate_limited");
        sawRateLimit = true;
        break;
      }
    }
    expect(sawRateLimit).toBe(true);

    // And the customer on that same IP is still served their own quote.
    expect(
      (await fetchWorker(`/q/${link.token}`, { headers: { "CF-Connecting-IP": "198.51.100.4" } })).status,
    ).toBe(200);
  });
});

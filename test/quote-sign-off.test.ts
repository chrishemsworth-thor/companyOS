import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";
import { createUser } from "../src/auth/users";
import { decide } from "../src/modules/approvals/service";
import { canTransitionQuote } from "../src/modules/quotes/types";
import { ensureEventBus } from "../src/queue/direct";
import type { Env } from "../src/env";

/**
 * PRD-004 P1 — internal sign-off before a quote goes out.
 *
 * The user story is *"quotes above a threshold need my approval before sending,
 * so that junior staff cannot commit the company to bad pricing"* — so the
 * tests that matter are the negative ones: that a quote over the line cannot
 * reach the customer by any route while a decision is outstanding.
 *
 * Uses the S3 approvals primitive with `subject_type = 'quote'`, which already
 * existed in the enum and already resolved `role_based` (admin or finance).
 * S9 adds no approvals mechanism of its own — standing rule 2.
 */

const API_KEY = "test_api_key_qsign";
const TENANT_ID = "biz_qsign";
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

/** The approvals service, on the inline bus, so its events reach events_log. */
function serviceEnv(): Env {
  const bare: Partial<Env> = { ...(env as unknown as Env) };
  delete bare.EVENTS;
  return ensureEventBus(bare as Env);
}

const THRESHOLD_CENTS = 1_000_000; // RM 10,000

let customerId: string;
let adminUserId: string;

beforeAll(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
  )
    .bind(TENANT_ID, "Sign-off SME", await sha256Hex(API_KEY))
    .run();
  adminUserId = (
    await createUser(env.DB, {
      tenant_id: TENANT_ID,
      email: "boss@signoff.test",
      password: "boss-password",
      display_name: "The Boss",
      role: "admin",
    })
  ).user_id;
  const res = await fetchWorker("/v1/customers", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name: "Big Ticket Bhd" }),
  });
  customerId = ((await res.json()) as { customer_id: string }).customer_id;
});

async function setThreshold(cents: number | null): Promise<void> {
  const res = await fetchWorker("/v1/settings/quote-branding", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify({ sign_off_threshold_cents: cents }),
  });
  expect(res.status).toBe(200);
}

interface QuoteResp {
  quote_id: string;
  status: string;
  grand_total_cents: number;
  sign_off_approval_id: string | null;
  sign_off_comment: string | null;
  sent_at: string | null;
}

/** A quote whose grand total lands exactly where the test wants it. */
async function quoteWorth(unitCents: number): Promise<QuoteResp> {
  const res = await fetchWorker("/v1/quotes", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      customer_id: customerId,
      issue_date: "2026-07-16",
      // Tax off, so grand_total_cents is exactly what the test asked for.
      tax_rate_bps: 0,
      lines: [{ item_name: "Enterprise rollout", quantity: 1, unit_cents: unitCents }],
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as QuoteResp;
}

async function send(quoteId: string): Promise<Response> {
  return fetchWorker(`/v1/quotes/${quoteId}/send`, { method: "POST", headers: auth });
}

async function pendingApprovalFor(quoteId: string) {
  return env.DB.prepare(
    "SELECT approval_id, approver_user_id, state FROM approvals WHERE tenant_id = ? AND subject_type = 'quote' AND subject_id = ?",
  )
    .bind(TENANT_ID, quoteId)
    .first<{ approval_id: string; approver_user_id: string; state: string }>();
}

describe("the threshold gate", () => {
  it("sends straight out below the threshold, raising no approval", async () => {
    await setThreshold(THRESHOLD_CENTS);
    const quote = await quoteWorth(THRESHOLD_CENTS - 1);
    const res = await send(quote.quote_id);
    expect(res.status).toBe(200);

    const sent = (await res.json()) as QuoteResp;
    expect(sent.status).toBe("sent");
    expect(sent.sent_at).not.toBeNull();
    expect(sent.sign_off_approval_id).toBeNull();
    expect(await pendingApprovalFor(quote.quote_id)).toBeNull();
  });

  it("parks a quote AT the threshold, not just above it", async () => {
    await setThreshold(THRESHOLD_CENTS);
    // "Approve anything from RM 10,000" means RM 10,000, not RM 10,000.01.
    const quote = await quoteWorth(THRESHOLD_CENTS);
    const res = await send(quote.quote_id);
    expect(res.status).toBe(200);

    const parked = (await res.json()) as QuoteResp;
    expect(parked.status).toBe("pending_approval");
    expect(parked.sent_at).toBeNull();
    expect(parked.sign_off_approval_id).toBeTruthy();

    const approval = await pendingApprovalFor(quote.quote_id);
    expect(approval!.state).toBe("pending");
    // The role-based strategy that already existed for `quote`: admin or finance.
    expect(approval!.approver_user_id).toBe(adminUserId);
    expect(approval!.approval_id).toBe(parked.sign_off_approval_id);
  });

  it("notifies the approver through approval.requested, not a quote event", async () => {
    await setThreshold(THRESHOLD_CENTS);
    const quote = await quoteWorth(THRESHOLD_CENTS * 3);
    await send(quote.quote_id);

    const requested = await env.DB.prepare(
      "SELECT payload FROM events_log WHERE event_type = 'approval.requested' AND payload LIKE ?",
    )
      .bind(`%${quote.quote_id}%`)
      .first<{ payload: string }>();
    expect(JSON.parse(requested!.payload)).toMatchObject({
      subject_type: "quote",
      subject_id: quote.quote_id,
      approver_user_id: adminUserId,
    });

    // Nothing has happened to the quote from the customer's point of view.
    const sentEvent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events_log WHERE event_type = 'quote.sent' AND payload LIKE ?",
    )
      .bind(`%${quote.quote_id}%`)
      .first<{ n: number }>();
    expect(sentEvent!.n).toBe(0);

    // And the approver has a notification, written by the S4 consumer — S9
    // adds no notification mechanism of its own (standing rule 2), and needed
    // no NOTIFICATION_MAP entry either: `approval.requested` already covers it,
    // and `quote` was already in the consumer's subject-label map.
    const notification = await env.DB.prepare(
      "SELECT user_id, type, title FROM notifications WHERE tenant_id = ? AND subject_id = ?",
    )
      .bind(TENANT_ID, quote.quote_id)
      .first<{ user_id: string; type: string; title: string }>();
    expect(notification!.user_id).toBe(adminUserId);
    expect(notification!.type).toBe("approval.requested");
    // Lower-case by design: the map reads as a noun inside a sentence.
    expect(notification!.title).toBe("Approval needed: quote");
  });

  it("no threshold set means no gate, at any value", async () => {
    await setThreshold(null);
    const quote = await quoteWorth(50_000_000);
    const res = await send(quote.quote_id);
    expect(((await res.json()) as QuoteResp).status).toBe("sent");
  });
});

describe("a quote awaiting sign-off cannot reach the customer", () => {
  async function parked(): Promise<QuoteResp> {
    await setThreshold(THRESHOLD_CENTS);
    const quote = await quoteWorth(THRESHOLD_CENTS * 2);
    const res = await send(quote.quote_id);
    return (await res.json()) as QuoteResp;
  }

  it("409s a second send instead of stacking up approvals", async () => {
    const quote = await parked();
    const again = await send(quote.quote_id);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("pending_approval");

    const { results } = await env.DB.prepare(
      "SELECT approval_id FROM approvals WHERE tenant_id = ? AND subject_type = 'quote' AND subject_id = ?",
    )
      .bind(TENANT_ID, quote.quote_id)
      .all<{ approval_id: string }>();
    expect(results).toHaveLength(1);
  });

  it("refuses a public link, so there is no way for a customer to see it", async () => {
    const quote = await parked();
    const res = await fetchWorker(`/v1/quotes/${quote.quote_id}/link`, {
      method: "POST",
      headers: auth,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("has been sent");
  });

  it("cannot be edited while a decision is outstanding", async () => {
    const quote = await parked();
    const res = await fetchWorker(`/v1/quotes/${quote.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ lines: [{ item_name: "Discounted", quantity: 1, unit_cents: 100 }] }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("locked");
  });
});

describe("the decision", () => {
  it("sends the quote when approval is granted, in the same transaction", async () => {
    await setThreshold(THRESHOLD_CENTS);
    const quote = await quoteWorth(THRESHOLD_CENTS * 2);
    const parked = (await (await send(quote.quote_id)).json()) as QuoteResp;

    await decide(serviceEnv(), TENANT_ID, parked.sign_off_approval_id!, {
      actor_user_id: adminUserId,
      actor_role: "admin",
      decision: "approved",
    });

    const after = (await (
      await fetchWorker(`/v1/quotes/${quote.quote_id}`, { headers: auth })
    ).json()) as QuoteResp;
    expect(after.status).toBe("sent");
    expect(after.sent_at).not.toBeNull();
    expect(after.sign_off_comment).toBeNull();

    // The same `quote.sent` an ordinary send emits — a consumer should not have
    // to know whether a sign-off was involved.
    const sentEvent = await env.DB.prepare(
      "SELECT payload FROM events_log WHERE event_type = 'quote.sent' AND payload LIKE ?",
    )
      .bind(`%${quote.quote_id}%`)
      .first<{ payload: string }>();
    expect(JSON.parse(sentEvent!.payload)).toMatchObject({ quote_id: quote.quote_id });

    // And the customer-facing path is open: a link mints and the page renders.
    const link = await fetchWorker(`/v1/quotes/${quote.quote_id}/link`, {
      method: "POST",
      headers: auth,
    });
    expect(link.status).toBe(201);
    const { token } = (await link.json()) as { token: string };
    const page = await fetchWorker(`/q/${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Accept quotation");
  });

  it("returns a rejected quote to draft with the comment attached", async () => {
    await setThreshold(THRESHOLD_CENTS);
    const quote = await quoteWorth(THRESHOLD_CENTS * 2);
    const parked = (await (await send(quote.quote_id)).json()) as QuoteResp;

    await decide(serviceEnv(), TENANT_ID, parked.sign_off_approval_id!, {
      actor_user_id: adminUserId,
      actor_role: "admin",
      decision: "rejected",
      comment: "Margin is under 8% — rework the licence line",
    });

    const after = (await (
      await fetchWorker(`/v1/quotes/${quote.quote_id}`, { headers: auth })
    ).json()) as QuoteResp;
    expect(after.status).toBe("draft");
    expect(after.sent_at).toBeNull();
    expect(after.sign_off_comment).toBe("Margin is under 8% — rework the licence line");

    // Back in the author's hands: editable again, and re-sendable, which raises
    // a NEW approval rather than reopening the rejected one (SESSION-PLAN C8).
    const edit = await fetchWorker(`/v1/quotes/${quote.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({
        tax_rate_bps: 0,
        lines: [{ item_name: "Reworked rollout", quantity: 1, unit_cents: THRESHOLD_CENTS * 2 }],
      }),
    });
    expect(edit.status).toBe(200);

    const resent = (await (await send(quote.quote_id)).json()) as QuoteResp;
    expect(resent.status).toBe("pending_approval");
    expect(resent.sign_off_approval_id).not.toBe(parked.sign_off_approval_id);
    expect(resent.sign_off_comment).toBeNull();
  });

  it("leaves an editable draft when the tenant has nobody who can sign off", async () => {
    const LONELY_KEY = "test_api_key_qsign_lonely";
    const LONELY_TENANT = "biz_qsign_lonely";
    const lonelyAuth = {
      Authorization: `Bearer ${LONELY_KEY}`,
      "Content-Type": "application/json",
    };
    await env.DB.prepare(
      "INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)",
    )
      .bind(LONELY_TENANT, "No Approver SME", await sha256Hex(LONELY_KEY))
      .run();

    const customer = (await (
      await fetchWorker("/v1/customers", {
        method: "POST",
        headers: lonelyAuth,
        body: JSON.stringify({ name: "Nobody Home" }),
      })
    ).json()) as { customer_id: string };

    await fetchWorker("/v1/settings/quote-branding", {
      method: "PUT",
      headers: lonelyAuth,
      body: JSON.stringify({ sign_off_threshold_cents: 1 }),
    });

    const quote = (await (
      await fetchWorker("/v1/quotes", {
        method: "POST",
        headers: lonelyAuth,
        body: JSON.stringify({
          customer_id: customer.customer_id,
          issue_date: "2026-07-16",
          tax_rate_bps: 0,
          lines: [{ item_name: "Anything", quantity: 1, unit_cents: 500_000 }],
        }),
      })
    ).json()) as QuoteResp;

    const res = await fetchWorker(`/v1/quotes/${quote.quote_id}/send`, {
      method: "POST",
      headers: lonelyAuth,
    });
    // 422 with the primitive's own message, not a 500: this is a tenant
    // configuration problem, and it says so.
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe("no_approver");

    // And critically, the quote is untouched — an editable draft rather than
    // one wedged in `pending_approval` with no one able to release it.
    const after = (await (
      await fetchWorker(`/v1/quotes/${quote.quote_id}`, { headers: lonelyAuth })
    ).json()) as QuoteResp;
    expect(after.status).toBe("draft");
    expect(after.sign_off_approval_id).toBeNull();
  });
});

describe("an approved quote never goes back", () => {
  /**
   * The product rule, stated after the phase shipped: an approved quote does not
   * return to `draft`. Changing it means restarting the quote — a new version,
   * which goes through the approval flow again from scratch.
   *
   * Worth pinning as its own round-trip test rather than trusting the pieces:
   * three separate mechanisms have to hold together for it to be true (the
   * transition table, the editability rule, and `createQuoteVersion` not
   * carrying the old sign-off forward), and each is independently plausible to
   * break.
   */
  it("locks after approval, and a new version must be approved again", async () => {
    await setThreshold(THRESHOLD_CENTS);
    const v1 = await quoteWorth(THRESHOLD_CENTS * 2);
    const parked = (await (await send(v1.quote_id)).json()) as QuoteResp;

    await decide(serviceEnv(), TENANT_ID, parked.sign_off_approval_id!, {
      actor_user_id: adminUserId,
      actor_role: "admin",
      decision: "approved",
    });

    // Approved and sent. There is no route back: not by editing...
    const edit = await fetchWorker(`/v1/quotes/${v1.quote_id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ notes: "quietly changing the deal" }),
    });
    expect(edit.status).toBe(409);
    expect(((await edit.json()) as { code: string }).code).toBe("locked");

    // ...and not by re-sending, which is the only other way a quote moves
    // through the sign-off gate.
    expect((await send(v1.quote_id)).status).toBe(409);

    // The sanctioned route is a new version, which starts clean: no inherited
    // approval, so the gate applies to it on its own merits.
    const v2 = (await (
      await fetchWorker(`/v1/quotes/${v1.quote_id}/version`, { method: "POST", headers: auth })
    ).json()) as QuoteResp;
    expect(v2.status).toBe("draft");
    expect(v2.sign_off_approval_id).toBeNull();
    expect(v2.sign_off_comment).toBeNull();

    const resent = (await (await send(v2.quote_id)).json()) as QuoteResp;
    expect(resent.status).toBe("pending_approval");
    // A NEW approval, not the one that already said yes to the old price.
    expect(resent.sign_off_approval_id).not.toBe(parked.sign_off_approval_id);

    // And v1 is untouched by any of it — somebody may have been shown it.
    const after = (await (
      await fetchWorker(`/v1/quotes/${v1.quote_id}`, { headers: auth })
    ).json()) as QuoteResp;
    expect(after.status).toBe("sent");
  });

  it("has no transition from sent, accepted or converted back to draft", async () => {
    // The table is the source of truth since 0028 dropped the status CHECK, so
    // it is worth asserting directly rather than only through the routes.
    for (const from of ["sent", "accepted", "converted", "rejected", "expired"] as const) {
      expect(canTransitionQuote(from, "draft")).toBe(false);
      expect(canTransitionQuote(from, "pending_approval")).toBe(false);
    }
    // The one legal way into `draft` is a rejected sign-off — PRD-004's
    // "returns to draft with the comment attached".
    expect(canTransitionQuote("pending_approval", "draft")).toBe(true);
  });
});

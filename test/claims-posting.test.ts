import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  accountId,
  balanceOf,
  bearer,
  capturingEnv,
  category,
  clearWorkerEvents,
  workerEvents,
  countJournalEntries,
  EMP,
  entriesForClaim,
  fetchWorker,
  login,
  PROJECT_ID,
  seedClaimsFixture,
  sessionHeaders,
  uploadReceipt,
  user,
  type Session,
} from "./claims-fixture";
import { validatePayload } from "../src/schemas/events/registry";
import { decide } from "../src/modules/approvals/service";
import { SUBJECT_DECISION_EFFECTS } from "../src/modules/approvals/decision-effects";
import type { ClaimDetail } from "../src/modules/claims/types";

/**
 * PRD-006 § "Claims: approval and GL posting" — "the differentiating
 * requirement", and all six of its acceptance criteria:
 *
 *   1. approved RM250 meals claim -> balanced entry to the meals expense account
 *      and reimbursements payable          -> "the approval posting"
 *   2. claim tagged to project P -> the expense line carries project_id = P and
 *      appears in P's profitability        -> "dimensions reach the ledger"
 *   3. reimbursement clears the payable and the claim is `paid`
 *                                          -> "reimbursement"
 *   4. a rejected claim has no ledger entry -> "rejection"
 *   5. an approved claim, when edited, is a 409 -> "an approved claim is immutable"
 *   6. the posting and the decision are ATOMIC  -> "atomicity"
 *
 * Plus SESSION-PLAN **C2**: two legs only, and no SST account invented.
 */

let filer: Session;
let managerSession: Session;
let financeSession: Session;

beforeAll(async () => {
  await seedClaimsFixture();
  filer = await login("filer");
  managerSession = await login("manager");
  financeSession = await login("finance");
});

interface SubmittedClaim {
  claim_id: string;
  approval_id: string;
  detail: ClaimDetail;
}

/** Draft + submit, as the filer. Returns the claim and its pending approval id. */
async function submitted(
  lines: Record<string, unknown>[],
  header: Record<string, unknown> = {},
): Promise<SubmittedClaim> {
  const created = await fetchWorker("/v1/claims", {
    method: "POST",
    headers: sessionHeaders(filer),
    body: JSON.stringify({ claim_date: "2026-07-20", ...header, lines }),
  });
  if (created.status !== 201) {
    throw new Error(`draft failed (${created.status}): ${await created.text()}`);
  }
  const draft = (await created.json()) as ClaimDetail;

  const res = await fetchWorker(`/v1/claims/${draft.claim.claim_id}/submit`, {
    method: "POST",
    headers: sessionHeaders(filer),
  });
  if (res.status !== 200) {
    throw new Error(`submit failed (${res.status}): ${await res.text()}`);
  }
  const detail = (await res.json()) as ClaimDetail;
  return { claim_id: detail.claim.claim_id, approval_id: detail.claim.approval_id!, detail };
}

/** A single-line meals claim, submitted. RM250 by default — PRD-006's example. */
async function submittedMealsClaim(
  amountCents = 25_000,
  header: Record<string, unknown> = {},
): Promise<SubmittedClaim> {
  const receipt = await uploadReceipt(filer);
  return submitted(
    [{ category_id: category.meals, amount_cents: amountCents, receipt_file_id: receipt }],
    header,
  );
}

/** Approve through the primitive's own route, as the resolved approver. */
async function approve(approvalId: string, session: Session = managerSession): Promise<Response> {
  return fetchWorker(`/v1/approvals/${approvalId}/approve`, {
    method: "POST",
    headers: sessionHeaders(session),
    body: JSON.stringify({}),
  });
}

async function reject(approvalId: string, comment: string): Promise<Response> {
  return fetchWorker(`/v1/approvals/${approvalId}/reject`, {
    method: "POST",
    headers: sessionHeaders(managerSession),
    body: JSON.stringify({ comment }),
  });
}

async function claimDetail(claimId: string): Promise<ClaimDetail> {
  const res = await fetchWorker(`/v1/claims/${claimId}`, { headers: bearer });
  return (await res.json()) as ClaimDetail;
}

describe("the approval posting", () => {
  it("posts a balanced entry to the meals expense account and reimbursements payable", async () => {
    // PRD-006's first posting criterion, verbatim: an approved RM250 meals claim.
    const claim = await submittedMealsClaim(25_000);
    clearWorkerEvents();
    const res = await approve(claim.approval_id);
    expect(res.status).toBe(200);

    // Emitted by the real HTTP route, not just by a direct `decide()` call — the
    // effect hook lives in the service, so the console's Approve button gets the
    // posting and the events exactly as a programmatic caller does.
    expect(workerEvents.map((e) => e.event_type)).toEqual([
      "approval.approved",
      "claim.approved",
    ]);

    const entries = await entriesForClaim(claim.claim_id);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;

    expect(entry.lines).toHaveLength(2);
    const byAccount = Object.fromEntries(entry.lines.map((l) => [l.account_code, l.amount_cents]));
    expect(byAccount["5200"]).toBe(25_000); // Dr Meals & Entertainment
    expect(byAccount["2100"]).toBe(-25_000); // Cr Employee Reimbursements Payable
    // Balanced, which is the ledger's own invariant and the one that makes this a
    // real posting rather than a note.
    expect(entry.lines.reduce((sum, l) => sum + l.amount_cents, 0)).toBe(0);

    expect(entry.currency).toBe("MYR");
    expect(entry.entry_date).toBe("2026-07-20");
    expect(entry.source_id).toBe(claim.claim_id);
    // `manual` rather than a new `claim` source type: extending the CHECK on
    // `journal_entries.source_type` needs a table rebuild the append-only triggers
    // on `journal_lines` make unavailable. `source_id` carries the typed prefix
    // instead. See migrations/0024_expense_claims.sql.
    expect(entry.source_type).toBe("manual");
    expect(entry.memo).toContain(claim.claim_id);

    const detail = await claimDetail(claim.claim_id);
    expect(detail.claim.status).toBe("approved");
    expect(detail.claim.entry_id).toBe(entry.entry_id);
  });

  it("posts one expense line per claim line and one payable line for the total", async () => {
    const receipts = await Promise.all([
      uploadReceipt(filer, "a.jpg"),
      uploadReceipt(filer, "b.jpg"),
      uploadReceipt(filer, "c.jpg"),
    ]);
    const claim = await submitted([
      { category_id: category.meals, amount_cents: 3_450, receipt_file_id: receipts[0]! },
      { category_id: category.travel, amount_cents: 12_000, receipt_file_id: receipts[1]! },
      { category_id: category.accommodation, amount_cents: 28_900, receipt_file_id: receipts[2]! },
    ]);
    expect((await approve(claim.approval_id)).status).toBe(200);

    const entry = (await entriesForClaim(claim.claim_id))[0]!;
    expect(entry.lines).toHaveLength(4);
    const byAccount = Object.fromEntries(entry.lines.map((l) => [l.account_code, l.amount_cents]));
    expect(byAccount["5200"]).toBe(3_450);
    expect(byAccount["5100"]).toBe(12_000);
    expect(byAccount["5300"]).toBe(28_900);
    // Each category to its own account, and one credit for what the employee is owed.
    expect(byAccount["2100"]).toBe(-(3_450 + 12_000 + 28_900));
    expect(entry.lines.reduce((sum, l) => sum + l.amount_cents, 0)).toBe(0);
  });

  it("posts two legs only, and invents no SST account (C2)", async () => {
    // The claim carries tax; the entry does not have a third leg for it. PRD-001's
    // tax work (S12) adds `Dr SST Input` and reduces the expense debit to net.
    // Until then the gross debit is the correct entry for a tenant that is not
    // SST-registered, since unrecoverable input tax IS part of the expense.
    const receipt = await uploadReceipt(filer);
    const claim = await submitted([
      {
        category_id: category.meals,
        amount_cents: 10_600,
        tax_cents: 600,
        receipt_file_id: receipt,
      },
    ]);
    expect((await approve(claim.approval_id)).status).toBe(200);

    const entry = (await entriesForClaim(claim.claim_id))[0]!;
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines.map((l) => l.amount_cents).sort((a, b) => a - b)).toEqual([-10_600, 10_600]);

    // The tax is recorded on the claim so S12 has the number it needs.
    const detail = await claimDetail(claim.claim_id);
    expect(detail.claim.tax_cents).toBe(600);
    expect(detail.lines[0]!.tax_cents).toBe(600);

    // And no SST account exists anywhere in this tenant's chart.
    const { results } = await env.DB.prepare(
      `SELECT code, name FROM accounts
        WHERE tenant_id = ? AND (name LIKE '%SST%' OR name LIKE '%Tax%' OR code IN ('2200','5900'))`,
    )
      .bind("biz_claims")
      .all<{ code: string; name: string }>();
    expect(results).toEqual([]);
  });

  it("refuses to decide as somebody who is not the approver", async () => {
    const claim = await submittedMealsClaim();
    const before = await countJournalEntries();

    const res = await approve(claim.approval_id, await login("colleague"));
    expect(res.status).toBe(403);
    expect(await countJournalEntries()).toBe(before);
    expect((await claimDetail(claim.claim_id)).claim.status).toBe("submitted");
  });
});

describe("dimensions reach the ledger", () => {
  it("stamps employee, project and department on the expense line", async () => {
    const claim = await submittedMealsClaim(25_000, {
      project_id: PROJECT_ID,
      department_code: "operations",
    });
    expect((await approve(claim.approval_id)).status).toBe(200);

    const entry = (await entriesForClaim(claim.claim_id))[0]!;
    const expense = entry.lines.find((l) => l.account_code === "5200")!;
    expect(expense.employee_id).toBe(EMP.filer);
    expect(expense.project_id).toBe(PROJECT_ID);
    expect(expense.department_code).toBe("operations");

    const payable = entry.lines.find((l) => l.account_code === "2100")!;
    // The payable leg carries the employee — "who are we out of pocket to" — but
    // not the project: it is a balance-sheet account and never reaches a margin.
    expect(payable.employee_id).toBe(EMP.filer);
    expect(payable.project_id).toBeNull();
  });

  it("falls back to the employee's own department when nothing else says", async () => {
    const claim = await submittedMealsClaim(5_000);
    expect((await approve(claim.approval_id)).status).toBe(200);

    const entry = (await entriesForClaim(claim.claim_id))[0]!;
    const expense = entry.lines.find((l) => l.account_code === "5200")!;
    // The filer's employee record says `operations`. An expense claim is the one
    // case where the correct department is never actually unknown.
    expect(expense.department_code).toBe("operations");
  });

  it("appears in the project's profitability (PRD-001a)", async () => {
    const before = await fetchWorker("/v1/insights/profitability?group_by=project", {
      headers: bearer,
    });
    const beforeRows = (await before.json()) as {
      rows: { key: string | null; cost_cents: number }[];
    };
    const beforeCost = beforeRows.rows.find((r) => r.key === PROJECT_ID)?.cost_cents ?? 0;

    const claim = await submittedMealsClaim(25_000, { project_id: PROJECT_ID });
    expect((await approve(claim.approval_id)).status).toBe(200);

    const after = await fetchWorker("/v1/insights/profitability?group_by=project", {
      headers: bearer,
    });
    const afterRows = (await after.json()) as {
      rows: { key: string | null; cost_cents: number }[];
    };
    const row = afterRows.rows.find((r) => r.key === PROJECT_ID)!;
    // claim -> GL -> project margin, with no re-keying. This is the whole demo.
    expect(row.cost_cents).toBe(beforeCost + 25_000);
  });

  it("splits a two-project claim across both project buckets", async () => {
    const receipts = await Promise.all([uploadReceipt(filer, "a.jpg"), uploadReceipt(filer, "b.jpg")]);
    const claim = await submitted(
      [
        {
          category_id: category.travel,
          amount_cents: 8_000,
          receipt_file_id: receipts[0]!,
          project_id: PROJECT_ID,
        },
        { category_id: category.meals, amount_cents: 2_000, receipt_file_id: receipts[1]! },
      ],
      { project_id: null },
    );
    expect((await approve(claim.approval_id)).status).toBe(200);

    const entry = (await entriesForClaim(claim.claim_id))[0]!;
    expect(entry.lines.find((l) => l.account_code === "5100")!.project_id).toBe(PROJECT_ID);
    // Untagged spend lands in the rollup's explicit "Unallocated" bucket rather
    // than being silently attributed — PRD-001a's rule.
    expect(entry.lines.find((l) => l.account_code === "5200")!.project_id).toBeNull();
  });
});

describe("rejection", () => {
  it("writes no ledger entry and returns the claim with the comment", async () => {
    const claim = await submittedMealsClaim();
    const before = await countJournalEntries();

    const res = await reject(claim.approval_id, "Receipt is illegible — please re-upload");
    expect(res.status).toBe(200);

    // PRD-006's fourth posting criterion.
    expect(await entriesForClaim(claim.claim_id)).toEqual([]);
    expect(await countJournalEntries()).toBe(before);

    const detail = await claimDetail(claim.claim_id);
    expect(detail.claim.status).toBe("rejected");
    expect(detail.claim.entry_id).toBeNull();
    expect(detail.claim.rejection_comment).toBe("Receipt is illegible — please re-upload");
    expect(detail.claim.rejected_at).toBeTruthy();
  });

  it("lets the employee edit and resubmit, creating a NEW approval row (C8)", async () => {
    const claim = await submittedMealsClaim();
    await reject(claim.approval_id, "Wrong month");

    // A rejected claim is a resting, EDITABLE state — that is what "returns the
    // claim to the employee" means.
    const edited = await fetchWorker(`/v1/claims/${claim.claim_id}`, {
      method: "PATCH",
      headers: sessionHeaders(filer),
      body: JSON.stringify({ claim_date: "2026-06-30" }),
    });
    expect(edited.status).toBe(200);

    const resubmitted = await fetchWorker(`/v1/claims/${claim.claim_id}/submit`, {
      method: "POST",
      headers: sessionHeaders(filer),
    });
    expect(resubmitted.status).toBe(200);
    const detail = (await resubmitted.json()) as ClaimDetail;
    expect(detail.claim.status).toBe("submitted");
    // The comment is cleared on resubmission — it described the previous attempt.
    expect(detail.claim.rejection_comment).toBeNull();

    const { results } = await env.DB.prepare(
      `SELECT approval_id, state FROM approvals
        WHERE tenant_id = ? AND subject_id = ? ORDER BY approval_id`,
    )
      .bind("biz_claims", claim.claim_id)
      .all<{ approval_id: string; state: string }>();
    // Two independent rows: the rejected one stands, and there is no `supersedes`
    // column anywhere (SESSION-PLAN C8).
    expect(results).toHaveLength(2);
    expect(results[0]!.state).toBe("rejected");
    expect(results[0]!.approval_id).toBe(claim.approval_id);
    expect(results[1]!.state).toBe("pending");
    expect(detail.claim.approval_id).toBe(results[1]!.approval_id);

    // And the second time around it posts normally.
    expect((await approve(results[1]!.approval_id)).status).toBe(200);
    expect((await entriesForClaim(claim.claim_id))).toHaveLength(1);
  });
});

describe("an approved claim is immutable", () => {
  it("409s a header patch and a line replacement", async () => {
    const claim = await submittedMealsClaim();
    expect((await approve(claim.approval_id)).status).toBe(200);

    const patched = await fetchWorker(`/v1/claims/${claim.claim_id}`, {
      method: "PATCH",
      headers: sessionHeaders(filer),
      body: JSON.stringify({ description: "actually it was RM500" }),
    });
    expect(patched.status).toBe(409);
    expect(((await patched.json()) as { error: string }).error).toContain("ledger");

    const receipt = await uploadReceipt(filer);
    const relined = await fetchWorker(`/v1/claims/${claim.claim_id}/lines`, {
      method: "PUT",
      headers: sessionHeaders(filer),
      body: JSON.stringify({
        lines: [{ category_id: category.meals, amount_cents: 50_000, receipt_file_id: receipt }],
      }),
    });
    expect(relined.status).toBe(409);

    // The ledger is untouched by either attempt.
    const entry = (await entriesForClaim(claim.claim_id))[0]!;
    expect(entry.lines.find((l) => l.account_code === "5200")!.amount_cents).toBe(25_000);
  });

  it("409s a paid claim too, and refuses to withdraw or cancel either", async () => {
    const claim = await submittedMealsClaim();
    await approve(claim.approval_id);
    await fetchWorker(`/v1/claims/${claim.claim_id}/reimburse`, {
      method: "POST",
      headers: sessionHeaders(financeSession),
      body: JSON.stringify({}),
    });

    for (const path of ["withdraw", "cancel"]) {
      const res = await fetchWorker(`/v1/claims/${claim.claim_id}/${path}`, {
        method: "POST",
        headers: sessionHeaders(filer),
      });
      expect(res.status).toBe(409);
    }
    const patched = await fetchWorker(`/v1/claims/${claim.claim_id}`, {
      method: "PATCH",
      headers: sessionHeaders(filer),
      body: JSON.stringify({ description: "nope" }),
    });
    expect(patched.status).toBe(409);
  });
});

describe("reimbursement", () => {
  it("clears the payable and marks the claim paid", async () => {
    const payableBefore = await balanceOf("2100");
    const cashBefore = await balanceOf("1000");

    const claim = await submittedMealsClaim(25_000);
    await approve(claim.approval_id);
    // Approval alone leaves the company owing the employee.
    expect(await balanceOf("2100")).toBe(payableBefore - 25_000);

    const res = await fetchWorker(`/v1/claims/${claim.claim_id}/reimburse`, {
      method: "POST",
      headers: sessionHeaders(financeSession),
      body: JSON.stringify({ payment_reference: "MBB-20260731-004" }),
    });
    expect(res.status).toBe(200);

    // PRD-006's third posting criterion: payable cleared, claim `paid`.
    expect(await balanceOf("2100")).toBe(payableBefore);
    expect(await balanceOf("1000")).toBe(cashBefore - 25_000);

    const detail = (await res.json()) as ClaimDetail;
    expect(detail.claim.status).toBe("paid");
    expect(detail.claim.payment_reference).toBe("MBB-20260731-004");
    expect(detail.claim.paid_at).toBeTruthy();

    const entries = await entriesForClaim(claim.claim_id);
    expect(entries).toHaveLength(2);
    const payment = entries.find((e) => e.entry_id === detail.claim.paid_entry_id)!;
    const byAccount = Object.fromEntries(payment.lines.map((l) => [l.account_code, l.amount_cents]));
    expect(byAccount["2100"]).toBe(25_000); // Dr payable
    expect(byAccount["1000"]).toBe(-25_000); // Cr cash
    expect(payment.lines.every((l) => l.employee_id === EMP.filer)).toBe(true);
  });

  it("counts an approved unpaid claim in the cash-flow outlook, and stops once paid", async () => {
    const summaryBefore = (await (
      await fetchWorker("/v1/insights/summary", { headers: bearer })
    ).json()) as { unpaid_claims: { count: number; by_currency: { cents: number }[] } };
    const countBefore = summaryBefore.unpaid_claims.count;

    const claim = await submittedMealsClaim(25_000);
    await approve(claim.approval_id);

    const during = (await (
      await fetchWorker("/v1/insights/summary", { headers: bearer })
    ).json()) as { unpaid_claims: { count: number; by_currency: { currency: string; cents: number }[] } };
    expect(during.unpaid_claims.count).toBe(countBefore + 1);
    expect(during.unpaid_claims.by_currency.find((b) => b.currency === "MYR")!.cents).toBeGreaterThanOrEqual(
      25_000,
    );

    await fetchWorker(`/v1/claims/${claim.claim_id}/reimburse`, {
      method: "POST",
      headers: sessionHeaders(financeSession),
      body: JSON.stringify({}),
    });

    const after = (await (
      await fetchWorker("/v1/insights/summary", { headers: bearer })
    ).json()) as { unpaid_claims: { count: number } };
    // The cash has left; it is no longer an outlook item.
    expect(after.unpaid_claims.count).toBe(countBefore);
  });

  it("refuses to reimburse a claim that is not approved", async () => {
    const claim = await submittedMealsClaim();
    const res = await fetchWorker(`/v1/claims/${claim.claim_id}/reimburse`, {
      method: "POST",
      headers: sessionHeaders(financeSession),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect(await entriesForClaim(claim.claim_id)).toEqual([]);
  });

  it("refuses to reimburse twice, so the cash cannot leave twice", async () => {
    const claim = await submittedMealsClaim();
    await approve(claim.approval_id);
    const cashAfterFirst = async () => balanceOf("1000");

    const first = await fetchWorker(`/v1/claims/${claim.claim_id}/reimburse`, {
      method: "POST",
      headers: sessionHeaders(financeSession),
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(200);
    const cash = await cashAfterFirst();

    const second = await fetchWorker(`/v1/claims/${claim.claim_id}/reimburse`, {
      method: "POST",
      headers: sessionHeaders(financeSession),
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(409);
    expect(await cashAfterFirst()).toBe(cash);
    expect(await entriesForClaim(claim.claim_id)).toHaveLength(2);
  });

  it("is finance-only — an employee cannot pay their own claim", async () => {
    const claim = await submittedMealsClaim();
    await approve(claim.approval_id);

    const res = await fetchWorker(`/v1/claims/${claim.claim_id}/reimburse`, {
      method: "POST",
      headers: sessionHeaders(filer),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect((await res.json()) as { required: string }).toMatchObject({ required: "finance:write" });
    expect((await claimDetail(claim.claim_id)).claim.status).toBe("approved");
  });
});

describe("atomicity", () => {
  it("is wired through the approvals primitive rather than an event consumer", () => {
    // The structural half of the criterion. If `expense_claim` ever loses its
    // decision effect, the posting silently moves out of the decision's
    // transaction and every other test here would still pass.
    expect(SUBJECT_DECISION_EFFECTS.expense_claim).toBeTypeOf("function");
  });

  it("no approved claim without its entry: a failed posting writes NOTHING", async () => {
    const claim = await submittedMealsClaim(25_000);
    const entriesBefore = await countJournalEntries();

    // Break the posting the realistic way: finance tidies the chart while the
    // claim sits pending, archiving the account the meals category posts to.
    await env.DB.prepare(
      `UPDATE accounts SET archived_at = ?
        WHERE tenant_id = ? AND account_id =
          (SELECT expense_account_id FROM claim_categories WHERE tenant_id = ? AND code = 'meals')`,
    )
      .bind(new Date().toISOString(), "biz_claims", "biz_claims")
      .run();

    const res = await approve(claim.approval_id);
    // The approver is told what to fix, naming the account.
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("archived");
    expect(body.error).toContain("5200");

    // Nothing moved. Not the approval...
    const approval = await env.DB.prepare(
      "SELECT state, decided_by, decided_at FROM approvals WHERE tenant_id = ? AND approval_id = ?",
    )
      .bind("biz_claims", claim.approval_id)
      .first<{ state: string; decided_by: string | null; decided_at: string | null }>();
    expect(approval!.state).toBe("pending");
    expect(approval!.decided_by).toBeNull();
    expect(approval!.decided_at).toBeNull();

    // ...not the claim...
    const detail = await claimDetail(claim.claim_id);
    expect(detail.claim.status).toBe("submitted");
    expect(detail.claim.entry_id).toBeNull();

    // ...and not the ledger.
    expect(await countJournalEntries()).toBe(entriesBefore);
    expect(await entriesForClaim(claim.claim_id)).toEqual([]);

    // Still decidable once the account is back — the failure left nothing to
    // clean up and did not wedge the approver's inbox.
    await env.DB.prepare(
      `UPDATE accounts SET archived_at = NULL WHERE tenant_id = ? AND code = '5200'`,
    )
      .bind("biz_claims")
      .run();
    expect((await approve(claim.approval_id)).status).toBe(200);
    expect(await entriesForClaim(claim.claim_id)).toHaveLength(1);
  });

  it("no entry without the approved claim: one approve, one entry, and a retry posts nothing", async () => {
    const claim = await submittedMealsClaim(25_000);

    expect((await approve(claim.approval_id)).status).toBe(200);
    const entries = await entriesForClaim(claim.claim_id);
    expect(entries).toHaveLength(1);

    // Both halves of the transaction landed.
    const approval = await env.DB.prepare(
      "SELECT state FROM approvals WHERE tenant_id = ? AND approval_id = ?",
    )
      .bind("biz_claims", claim.approval_id)
      .first<{ state: string }>();
    expect(approval!.state).toBe("approved");
    expect((await claimDetail(claim.claim_id)).claim.status).toBe("approved");

    // A retry — an impatient approver, a client that resends — is a 409 and posts
    // nothing. Without the terminal-decision guard this would double the expense.
    const again = await approve(claim.approval_id);
    expect(again.status).toBe(409);
    expect(await entriesForClaim(claim.claim_id)).toHaveLength(1);
  });

  it("emits approval.approved and claim.approved, both registry-valid and in that order", async () => {
    const claim = await submittedMealsClaim(25_000);
    const cap = capturingEnv();

    await decide(cap.env, "biz_claims", claim.approval_id, {
      actor_user_id: user.manager,
      actor_role: "employee",
      decision: "approved",
      comment: null,
    });

    const types = cap.sent.map((e) => e.event_type);
    // The approval event first: on the free plan dispatch is inline and
    // synchronous, so the requester's notification is written before any consumer
    // of the subject event can act on the same decision.
    expect(types).toEqual(["approval.approved", "claim.approved"]);

    for (const event of cap.sent) {
      expect(validatePayload(event.event_type, event.payload)).toEqual({ ok: true });
    }
    const claimEvent = cap.sent.find((e) => e.event_type === "claim.approved")!;
    expect(claimEvent.source_module).toBe("people");
    const entry = (await entriesForClaim(claim.claim_id))[0]!;
    expect(claimEvent.payload).toMatchObject({
      claim_id: claim.claim_id,
      employee_id: EMP.filer,
      approval_id: claim.approval_id,
      decided_by: user.manager,
      total_cents: 25_000,
      currency: "MYR",
      // The entry id on the payload resolves, because it was written by the same
      // batch that recorded the decision.
      entry_id: entry.entry_id,
    });
  });

  it("emits a registry-valid claim.rejected with no entry id", async () => {
    const claim = await submittedMealsClaim();
    const cap = capturingEnv();

    await decide(cap.env, "biz_claims", claim.approval_id, {
      actor_user_id: user.manager,
      actor_role: "employee",
      decision: "rejected",
      comment: "Not a business expense",
    });

    const rejected = cap.sent.find((e) => e.event_type === "claim.rejected")!;
    expect(validatePayload("claim.rejected", rejected.payload)).toEqual({ ok: true });
    expect(rejected.payload).toMatchObject({ comment: "Not a business expense" });
    expect(rejected.payload.entry_id).toBeUndefined();
  });

  it("emits a registry-valid claim.paid", async () => {
    const claim = await submittedMealsClaim(25_000);
    await approve(claim.approval_id);

    const cap = capturingEnv();
    const { reimburseClaim } = await import("../src/modules/claims/service");
    await reimburseClaim(cap.env, "biz_claims", claim.claim_id, {
      payment_reference: "CHQ-0001",
    });

    const paid = cap.sent.find((e) => e.event_type === "claim.paid")!;
    expect(paid.source_module).toBe("people");
    expect(validatePayload("claim.paid", paid.payload)).toEqual({ ok: true });
    expect(paid.payload).toMatchObject({
      claim_id: claim.claim_id,
      total_cents: 25_000,
      payment_reference: "CHQ-0001",
    });
  });

  it("leaves other subject types untouched by the effect table", async () => {
    // A quote approval has no effect registered, so `decide` behaves exactly as it
    // did before S5: one statement, one event. Proving that here means the S5
    // change to the primitive cannot have quietly altered S3's own behaviour.
    const financeUser = user.finance;
    const cap = capturingEnv();
    const { requestApproval } = await import("../src/modules/approvals/service");
    const approval = await requestApproval(cap.env, "biz_claims", {
      subject_type: "quote",
      subject_id: "qte_no_effect",
      requested_by: user.filer,
    });
    expect(approval.approver_user_id).toBe(financeUser);

    const before = await countJournalEntries();
    const cap2 = capturingEnv();
    await decide(cap2.env, "biz_claims", approval.approval_id, {
      actor_user_id: financeUser,
      actor_role: "finance",
      decision: "approved",
      comment: null,
    });
    expect(cap2.sent.map((e) => e.event_type)).toEqual(["approval.approved"]);
    expect(await countJournalEntries()).toBe(before);
  });
});

describe("the payable is a real liability", () => {
  it("shows unpaid approved claims as a credit balance on 2100", async () => {
    const payableBefore = await balanceOf("2100");
    const first = await submittedMealsClaim(10_000);
    const second = await submittedMealsClaim(5_000);
    await approve(first.approval_id);
    await approve(second.approval_id);

    // A credit balance on a liability account: the company owes RM150.
    expect(await balanceOf("2100")).toBe(payableBefore - 15_000);

    const account = await accountId("2100");
    const res = await fetchWorker(`/v1/ledger/accounts/${account}/balance`, { headers: bearer });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { balance_cents: number }).balance_cents).toBe(
      payableBefore - 15_000,
    );
  });

  it("keeps another tenant's claims out of the balance", async () => {
    const claim = await submittedMealsClaim(25_000);
    await approve(claim.approval_id);
    // The other tenant has its own 2100 and has posted nothing to it.
    expect(await balanceOf("2100", "biz_claims_other")).toBe(0);
  });
});

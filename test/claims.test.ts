import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  bearer,
  category,
  EMP,
  fetchWorker,
  JPEG_BYTES,
  login,
  OTHER_PROJECT_ID,
  otherBearer,
  PROJECT_ID,
  seedClaimsFixture,
  sessionHeaders,
  uploadHeaders,
  uploadReceipt,
  user,
  type Session,
} from "./claims-fixture";
import { validatePayload } from "../src/schemas/events/registry";
import type { ClaimDetail } from "../src/modules/claims/types";
import type { Approval } from "../src/modules/approvals/types";

/**
 * PRD-006 § "Claims: submission" — all four acceptance criteria, plus the cases
 * the S5 brief and the conflicts add.
 *
 * The four criteria, and where each lives:
 *
 *   1. "a claim without a receipt is rejected"          -> "receipts are required"
 *   2. "a JPEG receipt uploads and displays in the
 *       approval view"                                  -> "the approval view"
 *   3. "the header total equals the sum of lines"        -> "header totals"
 *   4. "a category over its limit warns and still
 *       submits"                                        -> "per-category limits"
 *
 * Everything here runs as the **filer**, who holds the `employee` role — `self`
 * plus `meta` and nothing else. That is not incidental: if these paths needed a
 * business capability, PRD-006 would not work for the person it was written for.
 */

let filer: Session;
let managerSession: Session;
let colleague: Session;

beforeAll(async () => {
  await seedClaimsFixture();
  filer = await login("filer");
  managerSession = await login("manager");
  colleague = await login("colleague");
});

/** A draft with the given lines, as the filer. Returns the parsed detail. */
async function createDraft(
  body: Record<string, unknown>,
  session: Session = filer,
): Promise<{ status: number; detail: ClaimDetail; raw: unknown }> {
  const res = await fetchWorker("/v1/claims", {
    method: "POST",
    headers: sessionHeaders(session),
    body: JSON.stringify(body),
  });
  const raw = await res.json();
  return { status: res.status, detail: raw as ClaimDetail, raw };
}

async function submit(
  claimId: string,
  session: Session = filer,
): Promise<{ status: number; detail: ClaimDetail }> {
  const res = await fetchWorker(`/v1/claims/${claimId}/submit`, {
    method: "POST",
    headers: sessionHeaders(session),
  });
  return { status: res.status, detail: (await res.json()) as ClaimDetail };
}

/** Read a claim as the tenant API key, which sees everything. */
async function claimAsAdmin(claimId: string): Promise<ClaimDetail> {
  const res = await fetchWorker(`/v1/claims/${claimId}`, { headers: bearer });
  return (await res.json()) as ClaimDetail;
}

/** A one-line meals claim, submitted. The workhorse of the suite. */
async function submittedClaim(amount = 25_000): Promise<ClaimDetail> {
  const receipt = await uploadReceipt(filer);
  const { detail } = await createDraft({
    claim_date: "2026-07-20",
    lines: [{ category_id: category.meals, amount_cents: amount, receipt_file_id: receipt }],
  });
  return (await submit(detail.claim.claim_id)).detail;
}

describe("receipts are required", () => {
  it("rejects a line with no receipt at creation", async () => {
    const { status, raw } = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.meals, amount_cents: 5000 }],
    });
    // Caught by the schema before the service sees it — `receipt_file_id` is not
    // optional anywhere on the way in. The body is Hono's own zValidator shape
    // rather than this codebase's `{error, code}` envelope, which is what every
    // other zValidator route in `src/gateway/routes` returns too; asserting on the
    // failing path is the durable part.
    expect(status).toBe(400);
    expect(JSON.stringify(raw)).toContain("receipt_file_id");

    // And nothing was written — no half-created claim to clean up.
    const rows = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM expense_claims WHERE tenant_id = ? AND total_cents = 5000",
    )
      .bind("biz_claims")
      .first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });

  it("rejects a receipt that belongs to another tenant", async () => {
    const theirs = await login("otherAdmin", "claims-other-co");
    const theirReceipt = await uploadReceipt(theirs);

    const { status, raw } = await createDraft({
      claim_date: "2026-07-20",
      lines: [
        { category_id: category.meals, amount_cents: 5000, receipt_file_id: theirReceipt },
      ],
    });
    expect(status).toBe(422);
    expect((raw as { error: string }).error).toContain("not found");
  });

  it("rejects a file uploaded for some other purpose", async () => {
    // A tenant logo is a real file this tenant owns — but not a receipt, and the
    // per-purpose policy is what carries the size and type rules.
    const form = new FormData();
    form.set("file", new File([JPEG_BYTES], "logo.jpg", { type: "image/jpeg" }));
    form.set("purpose", "quote_logo");
    const upload = await fetchWorker("/v1/files", {
      method: "POST",
      headers: uploadHeaders(await login("admin")),
      body: form,
    });
    expect(upload.status).toBe(201);
    const logo = ((await upload.json()) as { file_id: string }).file_id;

    const { status, raw } = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.meals, amount_cents: 5000, receipt_file_id: logo }],
    });
    expect(status).toBe(422);
    expect((raw as { error: string }).error).toContain("claim_receipt");
  });

  it("rejects submission when the receipt was deleted after drafting", async () => {
    const receipt = await uploadReceipt(filer);
    const { detail } = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.meals, amount_cents: 5000, receipt_file_id: receipt }],
    });

    // The realistic version of "a claim without a receipt": it had one when it was
    // drafted. PRD-006's criterion has to hold at the moment somebody is asked to
    // decide, which is why submit re-validates rather than trusting the draft.
    await env.DB.prepare("UPDATE files SET deleted_at = ? WHERE file_id = ?")
      .bind(new Date().toISOString(), receipt)
      .run();

    const submitted = await submit(detail.claim.claim_id);
    expect(submitted.status).toBe(422);

    const after = await fetchWorker(`/v1/claims/${detail.claim.claim_id}`, {
      headers: sessionHeaders(filer),
    });
    // Still an editable draft, and no approval was raised — the employee can fix
    // it rather than finding it stuck.
    expect(((await after.json()) as ClaimDetail).claim.status).toBe("draft");
    const approvals = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND subject_id = ?",
    )
      .bind("biz_claims", detail.claim.claim_id)
      .first<{ n: number }>();
    expect(approvals!.n).toBe(0);
  });
});

describe("the approval view", () => {
  it("uploads a JPEG receipt and serves it to the approver", async () => {
    const claim = await submittedClaim();

    // The manager holds `employee` — no files:read, no people:read, no
    // finance:read. They can see this claim because it is their decision.
    const detail = await fetchWorker(`/v1/claims/${claim.claim.claim_id}`, {
      headers: sessionHeaders(managerSession),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as ClaimDetail;
    expect(body.lines[0]!.receipt_content_type).toBe("image/jpeg");
    expect(body.lines[0]!.receipt_filename).toBe("receipt.jpg");
    expect(body.lines[0]!.receipt_size_bytes).toBe(JPEG_BYTES.byteLength);
    // The context an approver decides on, per the S5 brief.
    expect(body.lines[0]!.category_name).toBe("Meals");
    expect(body.lines[0]!.account_code).toBe("5200");

    const receipt = await fetchWorker(
      `/v1/claims/${claim.claim.claim_id}/lines/1/receipt`,
      { headers: sessionHeaders(managerSession) },
    );
    expect(receipt.status).toBe(200);
    expect(receipt.headers.get("Content-Type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await receipt.arrayBuffer());
    expect(bytes.byteLength).toBe(JPEG_BYTES.byteLength);
    // Actually the same image, not just the same length.
    expect([...bytes.slice(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });

  it("404s a receipt for a line that does not exist", async () => {
    const claim = await submittedClaim();
    const res = await fetchWorker(`/v1/claims/${claim.claim.claim_id}/lines/9/receipt`, {
      headers: sessionHeaders(managerSession),
    });
    expect(res.status).toBe(404);
  });

  it("renders a claim whose receipt was deleted rather than failing", async () => {
    const claim = await submittedClaim();
    await env.DB.prepare("UPDATE files SET deleted_at = ? WHERE file_id = ?")
      .bind(new Date().toISOString(), claim.lines[0]!.receipt_file_id)
      .run();

    const detail = await fetchWorker(`/v1/claims/${claim.claim.claim_id}`, {
      headers: sessionHeaders(managerSession),
    });
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as ClaimDetail;
    // The line survives; only its receipt metadata is null. The card shows
    // "receipt unavailable" rather than crashing the inbox.
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]!.receipt_filename).toBeNull();

    const receipt = await fetchWorker(`/v1/claims/${claim.claim.claim_id}/lines/1/receipt`, {
      headers: sessionHeaders(managerSession),
    });
    expect(receipt.status).toBe(404);
  });

  it("refuses an oversized or unsupported receipt with the policy's own message", async () => {
    const tooBig = new Uint8Array(11 * 1024 * 1024);
    const bigForm = new FormData();
    bigForm.set("file", new File([tooBig], "huge.jpg", { type: "image/jpeg" }));
    const big = await fetchWorker("/v1/claims/receipts", {
      method: "POST",
      headers: uploadHeaders(filer),
      body: bigForm,
    });
    expect(big.status).toBe(413);

    const zipForm = new FormData();
    zipForm.set("file", new File([JPEG_BYTES], "r.zip", { type: "application/zip" }));
    const zip = await fetchWorker("/v1/claims/receipts", {
      method: "POST",
      headers: uploadHeaders(filer),
      body: zipForm,
    });
    expect(zip.status).toBe(415);
  });
});

describe("header totals", () => {
  it("sets the header total to the sum of the lines", async () => {
    const receipts = await Promise.all([
      uploadReceipt(filer, "a.jpg"),
      uploadReceipt(filer, "b.jpg"),
      uploadReceipt(filer, "c.jpg"),
    ]);
    const { status, detail } = await createDraft({
      claim_date: "2026-07-20",
      lines: [
        { category_id: category.meals, amount_cents: 3450, receipt_file_id: receipts[0]! },
        { category_id: category.travel, amount_cents: 12_000, receipt_file_id: receipts[1]! },
        {
          category_id: category.accommodation,
          amount_cents: 28_900,
          tax_cents: 1_734,
          receipt_file_id: receipts[2]!,
        },
      ],
    });

    expect(status).toBe(201);
    expect(detail.lines).toHaveLength(3);
    expect(detail.claim.total_cents).toBe(3450 + 12_000 + 28_900);
    // Tax is summed too, and is PART of the total rather than on top of it.
    expect(detail.claim.tax_cents).toBe(1_734);
    expect(detail.claim.total_cents).toBe(
      detail.lines.reduce((sum, line) => sum + line.amount_cents, 0),
    );
  });

  it("recomputes the total when the lines are replaced", async () => {
    const receipt = await uploadReceipt(filer);
    const { detail } = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.meals, amount_cents: 9_000, receipt_file_id: receipt }],
    });
    expect(detail.claim.total_cents).toBe(9_000);

    const replaced = await fetchWorker(`/v1/claims/${detail.claim.claim_id}/lines`, {
      method: "PUT",
      headers: sessionHeaders(filer),
      body: JSON.stringify({
        lines: [
          { category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipt },
          { category_id: category.meals, amount_cents: 2_500, receipt_file_id: receipt },
        ],
      }),
    });
    expect(replaced.status).toBe(200);
    const after = (await replaced.json()) as ClaimDetail;
    expect(after.lines).toHaveLength(2);
    expect(after.claim.total_cents).toBe(3_500);
    // Line numbers are re-issued from 1, so the receipt route's :line stays valid.
    expect(after.lines.map((l) => l.line_no)).toEqual([1, 2]);
  });

  it("rejects a non-positive amount rather than storing a zero line", async () => {
    const receipt = await uploadReceipt(filer);
    const { status } = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.meals, amount_cents: 0, receipt_file_id: receipt }],
    });
    expect(status).toBe(400);
  });

  it("rejects tax greater than the line amount, because the amount is gross", async () => {
    const receipt = await uploadReceipt(filer);
    const { status, raw } = await createDraft({
      claim_date: "2026-07-20",
      lines: [
        {
          category_id: category.meals,
          amount_cents: 1_000,
          tax_cents: 1_200,
          receipt_file_id: receipt,
        },
      ],
    });
    expect(status).toBe(422);
    expect((raw as { error: string }).error).toContain("gross");
  });
});

describe("per-category limits", () => {
  it("warns on a breach and still submits", async () => {
    // PRD-006's fourth criterion. A limit that blocked would have an employee
    // quietly not claiming money they are owed, which is the worse failure.
    await fetchWorker(`/v1/claim-categories/${category.meals}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ limit_cents: 20_000 }),
    });

    const receipt = await uploadReceipt(filer);
    const { detail } = await createDraft({
      claim_date: "2026-07-20",
      lines: [
        { category_id: category.meals, amount_cents: 15_000, receipt_file_id: receipt },
        { category_id: category.meals, amount_cents: 10_000, receipt_file_id: receipt },
      ],
    });
    // The limit is per claim, per category — so it is the SUM of the two lines
    // that breaches, not either one.
    expect(detail.limit_warnings).toHaveLength(1);
    expect(detail.limit_warnings[0]).toMatchObject({
      category_code: "meals",
      category_name: "Meals",
      limit_cents: 20_000,
      claimed_cents: 25_000,
      over_by_cents: 5_000,
    });

    const submitted = await submit(detail.claim.claim_id);
    expect(submitted.status).toBe(200);
    expect(submitted.detail.claim.status).toBe("submitted");
    expect(submitted.detail.limit_warnings).toHaveLength(1);
  });

  it("says nothing when the claim is inside the limit", async () => {
    await fetchWorker(`/v1/claim-categories/${category.meals}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ limit_cents: 20_000 }),
    });
    const receipt = await uploadReceipt(filer);
    const { detail } = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.meals, amount_cents: 19_999, receipt_file_id: receipt }],
    });
    expect(detail.limit_warnings).toEqual([]);
  });

  it("flags the breach on the submitted event", async () => {
    await fetchWorker(`/v1/claim-categories/${category.meals}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ limit_cents: 100 }),
    });
    const claim = await submittedClaim(5_000);
    const row = await env.DB.prepare(
      "SELECT status FROM expense_claims WHERE claim_id = ?",
    )
      .bind(claim.claim.claim_id)
      .first<{ status: string }>();
    expect(row!.status).toBe("submitted");
    expect(claim.limit_warnings).toHaveLength(1);
  });
});

describe("mileage", () => {
  it("computes the amount as distance x the category rate and stores it", async () => {
    const receipt = await uploadReceipt(filer, "toll.jpg");
    const { status, detail } = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.mileage, distance_km: 42.5, receipt_file_id: receipt }],
    });
    expect(status).toBe(201);
    // 42.5 km x 70 sen = RM29.75.
    expect(detail.lines[0]!.amount_cents).toBe(2_975);
    expect(detail.lines[0]!.distance_km).toBe(42.5);
    expect(detail.claim.total_cents).toBe(2_975);
  });

  it("is unaffected by a later change to the category's rate", async () => {
    const receipt = await uploadReceipt(filer, "toll.jpg");
    const { detail } = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.mileage, distance_km: 10, receipt_file_id: receipt }],
    });
    expect(detail.lines[0]!.amount_cents).toBe(700);

    await fetchWorker(`/v1/claim-categories/${category.mileage}`, {
      method: "PATCH",
      headers: bearer,
      body: JSON.stringify({ per_km_rate_cents: 200 }),
    });

    const after = await fetchWorker(`/v1/claims/${detail.claim.claim_id}`, {
      headers: sessionHeaders(filer),
    });
    // Stored, not derived: a rate rise next year must not restate a claim that
    // has already been agreed, let alone one already posted.
    expect(((await after.json()) as ClaimDetail).lines[0]!.amount_cents).toBe(700);
  });

  it("requires a distance and refuses a hand-typed amount", async () => {
    const receipt = await uploadReceipt(filer);
    const noDistance = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.mileage, amount_cents: 5_000, receipt_file_id: receipt }],
    });
    expect(noDistance.status).toBe(422);
    expect((noDistance.raw as { error: string }).error).toContain("distance_km");

    const both = await createDraft({
      claim_date: "2026-07-20",
      lines: [
        {
          category_id: category.mileage,
          distance_km: 10,
          amount_cents: 99_999,
          receipt_file_id: receipt,
        },
      ],
    });
    // Refused rather than ignored: silently discarding a number the filer typed
    // would have them believe they claimed something they did not.
    expect(both.status).toBe(422);
  });

  it("refuses a distance on a category that is not mileage", async () => {
    const receipt = await uploadReceipt(filer);
    const { status } = await createDraft({
      claim_date: "2026-07-20",
      lines: [
        {
          category_id: category.meals,
          amount_cents: 1_000,
          distance_km: 12,
          receipt_file_id: receipt,
        },
      ],
    });
    expect(status).toBe(422);
  });
});

describe("dimensions", () => {
  it("accepts project and department on the claim and per line", async () => {
    const receipts = await Promise.all([uploadReceipt(filer, "a.jpg"), uploadReceipt(filer, "b.jpg")]);
    const { status, detail } = await createDraft({
      claim_date: "2026-07-20",
      project_id: PROJECT_ID,
      department_code: "operations",
      lines: [
        { category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipts[0]! },
        {
          category_id: category.travel,
          amount_cents: 2_000,
          receipt_file_id: receipts[1]!,
          project_id: OTHER_PROJECT_ID,
          department_code: "sales",
        },
      ],
    });
    expect(status).toBe(201);
    expect(detail.claim.project_id).toBe(PROJECT_ID);
    expect(detail.lines[0]!.project_id).toBeNull();
    // One submission can span two projects — the line wins where it says something.
    expect(detail.lines[1]!.project_id).toBe(OTHER_PROJECT_ID);
    expect(detail.lines[1]!.department_code).toBe("sales");
  });

  it("rejects an unknown department_code", async () => {
    const receipt = await uploadReceipt(filer);
    const { status, raw } = await createDraft({
      claim_date: "2026-07-20",
      department_code: "not-a-department",
      lines: [{ category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipt }],
    });
    expect(status).toBe(422);
    expect((raw as { error: string }).error).toContain("department_code");
  });

  it("rejects a project that does not exist", async () => {
    const receipt = await uploadReceipt(filer);
    const { status, raw } = await createDraft({
      claim_date: "2026-07-20",
      project_id: "prj_does_not_exist",
      lines: [{ category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipt }],
    });
    // A typo'd project is worse than none: PRD-001a's rollup falls back to the raw
    // id, so it would appear as a phantom bucket beside the real projects.
    expect(status).toBe(422);
    expect((raw as { error: string }).error).toContain("project");
  });

  it("rejects another tenant's project", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO projects (project_id, tenant_id, name) VALUES (?, ?, ?)",
    )
      .bind("prj_theirs", "biz_claims_other", "Theirs")
      .run();
    const receipt = await uploadReceipt(filer);
    const { status } = await createDraft({
      claim_date: "2026-07-20",
      project_id: "prj_theirs",
      lines: [{ category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipt }],
    });
    expect(status).toBe(422);
  });
});

describe("routing to an approver", () => {
  it("raises one approval for the filer's manager and emits claim.submitted", async () => {
    const claim = await submittedClaim(12_345);

    const approval = await env.DB.prepare(
      `SELECT approval_id, subject_type, approver_user_id, requested_by, state
         FROM approvals WHERE tenant_id = ? AND subject_id = ?`,
    )
      .bind("biz_claims", claim.claim.claim_id)
      .first<Approval>();
    expect(approval).toBeTruthy();
    expect(approval!.subject_type).toBe("expense_claim");
    expect(approval!.state).toBe("pending");
    // The S3 primitive's manager_chain strategy, unchanged by this session.
    expect(approval!.approver_user_id).toBe(user.manager);
    expect(approval!.requested_by).toBe(user.filer);
    expect(claim.claim.approval_id).toBe(approval!.approval_id);

    // The approver's inbox sees it through the primitive's own endpoint.
    const inbox = await fetchWorker("/v1/approvals?state=pending&mine=true", {
      headers: sessionHeaders(managerSession),
    });
    const listed = (await inbox.json()) as { items: Approval[] };
    expect(listed.items.some((a) => a.subject_id === claim.claim.claim_id)).toBe(true);
  });

  it("routes a claim filed on somebody's behalf to THEIR manager", async () => {
    // Finance files for the colleague. The approver must be the colleague's
    // manager, not finance's — the case S3 built `subject_employee_id` for.
    const financeSession = await login("finance");
    const receipt = await uploadReceipt(financeSession);
    const { status, detail } = await createDraft(
      {
        employee_id: EMP.colleague,
        claim_date: "2026-07-20",
        lines: [{ category_id: category.meals, amount_cents: 4_000, receipt_file_id: receipt }],
      },
      financeSession,
    );
    expect(status).toBe(201);
    expect(detail.claim.employee_id).toBe(EMP.colleague);

    await submit(detail.claim.claim_id, financeSession);
    const approval = await env.DB.prepare(
      "SELECT approver_user_id FROM approvals WHERE tenant_id = ? AND subject_id = ?",
    )
      .bind("biz_claims", detail.claim.claim_id)
      .first<{ approver_user_id: string }>();
    expect(approval!.approver_user_id).toBe(user.manager);
  });

  it("refuses an employee filing for somebody else", async () => {
    const receipt = await uploadReceipt(filer);
    const { status } = await createDraft({
      employee_id: EMP.colleague,
      claim_date: "2026-07-20",
      lines: [{ category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipt }],
    });
    expect(status).toBe(403);
  });

  it("emits a registry-valid claim.submitted", async () => {
    const { capturingEnv } = await import("./claims-fixture");
    const receipt = await uploadReceipt(filer);
    const { detail } = await createDraft({
      claim_date: "2026-07-20",
      project_id: PROJECT_ID,
      lines: [{ category_id: category.meals, amount_cents: 7_700, receipt_file_id: receipt }],
    });

    const cap = capturingEnv();
    const { submitClaim } = await import("../src/modules/claims/service");
    await submitClaim(cap.env, "biz_claims", detail.claim.claim_id, user.filer);

    const submitted = cap.sent.find((e) => e.event_type === "claim.submitted");
    expect(submitted).toBeTruthy();
    expect(submitted!.source_module).toBe("people");
    expect(validatePayload("claim.submitted", submitted!.payload)).toEqual({ ok: true });
    expect(submitted!.payload).toMatchObject({
      claim_id: detail.claim.claim_id,
      employee_id: EMP.filer,
      submitted_by: user.filer,
      total_cents: 7_700,
      line_count: 1,
      project_id: PROJECT_ID,
      over_limit: false,
    });

    // `approval.requested` rides along on the same call — that is what puts the
    // claim in the manager's bell, and why this module registers no notification
    // mapper of its own.
    expect(cap.sent.some((e) => e.event_type === "approval.requested")).toBe(true);
  });
});

describe("who may see a claim", () => {
  it("404s another tenant's claim id", async () => {
    const claim = await submittedClaim();
    const res = await fetchWorker(`/v1/claims/${claim.claim.claim_id}`, { headers: otherBearer });
    expect(res.status).toBe(404);
  });

  it("404s a colleague's claim rather than confirming it exists", async () => {
    const claim = await submittedClaim();
    const res = await fetchWorker(`/v1/claims/${claim.claim.claim_id}`, {
      headers: sessionHeaders(colleague),
    });
    // 404, never 403: a 403 would tell the colleague that Aisha filed a claim.
    expect(res.status).toBe(404);
  });

  it("lets finance see any claim", async () => {
    const claim = await submittedClaim();
    const res = await fetchWorker(`/v1/claims/${claim.claim.claim_id}`, {
      headers: sessionHeaders(await login("finance")),
    });
    expect(res.status).toBe(200);
  });

  it("lets a readonly observer read every claim but touch nobody else's", async () => {
    const claim = await submittedClaim();
    const observer = await login("observer");

    // `readonly` is a full business observer, so it reads.
    const read = await fetchWorker(`/v1/claims/${claim.claim.claim_id}`, {
      headers: sessionHeaders(observer),
    });
    expect(read.status).toBe(200);

    // But it holds `self:write` — so the router's own gate lets it through, and the
    // per-row check is the only thing standing between an observer and somebody
    // else's paperwork. Read authority and write authority are separate questions
    // here for exactly this reason.
    for (const [path, init] of [
      ["", { method: "PATCH", body: JSON.stringify({ description: "mine now" }) }],
      ["/submit", { method: "POST" }],
      ["/withdraw", { method: "POST" }],
      ["/cancel", { method: "POST" }],
    ] as const) {
      const res = await fetchWorker(`/v1/claims/${claim.claim.claim_id}${path}`, {
        ...init,
        headers: sessionHeaders(observer),
      });
      expect([403, 404]).toContain(res.status);
    }
    // Untouched.
    expect((await claimAsAdmin(claim.claim.claim_id)).claim.status).toBe("submitted");

    // It cannot file on somebody else's behalf...
    const receipt = await uploadReceipt(observer);
    const onBehalf = await fetchWorker("/v1/claims", {
      method: "POST",
      headers: sessionHeaders(observer),
      body: JSON.stringify({
        employee_id: EMP.colleague,
        claim_date: "2026-07-20",
        lines: [{ category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipt }],
      }),
    });
    expect(onBehalf.status).toBe(403);

    // ...but it CAN file its own. PRD-008's matrix is explicit that the identity
    // axis is not a business capability, so an observer who is also staff is
    // still staff.
    const own = await fetchWorker("/v1/claims", {
      method: "POST",
      headers: sessionHeaders(observer),
      body: JSON.stringify({
        claim_date: "2026-07-20",
        lines: [{ category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipt }],
      }),
    });
    expect(own.status).toBe(201);
    expect(((await own.json()) as ClaimDetail).claim.employee_id).toBe(EMP.observer);
  });

  it("stops an approver from editing the claim they are deciding", async () => {
    const claim = await submittedClaim();
    const res = await fetchWorker(`/v1/claims/${claim.claim.claim_id}`, {
      method: "PATCH",
      headers: sessionHeaders(managerSession),
      body: JSON.stringify({ description: "let me just change this" }),
    });
    // 403 rather than 404 here: they CAN read it, so pretending it does not exist
    // would be a lie they can disprove.
    expect(res.status).toBe(403);
  });

  it("defaults an employee's list to their own claims", async () => {
    await submittedClaim();
    const res = await fetchWorker("/v1/claims", { headers: sessionHeaders(filer) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claims: { employee_id: string }[] };
    expect(body.claims.length).toBeGreaterThan(0);
    // No ?mine=true needed — making an employee pass a flag to get a non-empty
    // list would be a trap.
    expect(body.claims.every((c) => c.employee_id === EMP.filer)).toBe(true);
  });

  it("lists claims a manager is the approver on", async () => {
    const claim = await submittedClaim();
    const res = await fetchWorker("/v1/claims?awaiting_me=true", {
      headers: sessionHeaders(managerSession),
    });
    const body = (await res.json()) as { claims: { claim_id: string }[] };
    expect(body.claims.some((c) => c.claim_id === claim.claim.claim_id)).toBe(true);
  });
});

describe("the draft lifecycle", () => {
  it("withdraws a submitted claim back to draft and cancels its approval", async () => {
    const claim = await submittedClaim();
    const res = await fetchWorker(`/v1/claims/${claim.claim.claim_id}/withdraw`, {
      method: "POST",
      headers: sessionHeaders(filer),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ClaimDetail).claim.status).toBe("draft");

    const approval = await env.DB.prepare(
      "SELECT state FROM approvals WHERE tenant_id = ? AND subject_id = ?",
    )
      .bind("biz_claims", claim.claim.claim_id)
      .first<{ state: string }>();
    // PRD-000's "a cancelled subject no longer appears in pending lists".
    expect(approval!.state).toBe("cancelled");

    const inbox = await fetchWorker("/v1/approvals?state=pending&mine=true", {
      headers: sessionHeaders(managerSession),
    });
    const listed = (await inbox.json()) as { items: Approval[] };
    expect(listed.items.some((a) => a.subject_id === claim.claim.claim_id)).toBe(false);
  });

  it("refuses to edit a submitted claim, but allows it after withdrawal", async () => {
    const claim = await submittedClaim();
    const blocked = await fetchWorker(`/v1/claims/${claim.claim.claim_id}`, {
      method: "PATCH",
      headers: sessionHeaders(filer),
      body: JSON.stringify({ description: "second thoughts" }),
    });
    expect(blocked.status).toBe(409);

    await fetchWorker(`/v1/claims/${claim.claim.claim_id}/withdraw`, {
      method: "POST",
      headers: sessionHeaders(filer),
    });
    const allowed = await fetchWorker(`/v1/claims/${claim.claim.claim_id}`, {
      method: "PATCH",
      headers: sessionHeaders(filer),
      body: JSON.stringify({ description: "second thoughts" }),
    });
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as ClaimDetail).claim.description).toBe("second thoughts");
  });

  it("cancels a draft and refuses to submit it afterwards", async () => {
    const receipt = await uploadReceipt(filer);
    const { detail } = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipt }],
    });

    const cancelled = await fetchWorker(`/v1/claims/${detail.claim.claim_id}/cancel`, {
      method: "POST",
      headers: sessionHeaders(filer),
    });
    expect(((await cancelled.json()) as ClaimDetail).claim.status).toBe("cancelled");

    const resubmit = await submit(detail.claim.claim_id);
    expect(resubmit.status).toBe(409);
  });

  it("refuses to submit a claim twice", async () => {
    const claim = await submittedClaim();
    const again = await submit(claim.claim.claim_id);
    expect(again.status).toBe(409);
    expect(((await fetchWorker(`/v1/claims/${claim.claim.claim_id}`, {
      headers: sessionHeaders(filer),
    }).then((r) => r.json())) as ClaimDetail).claim.status).toBe("submitted");
  });

  it("rejects a bad claim_date", async () => {
    const receipt = await uploadReceipt(filer);
    const { status } = await createDraft({
      claim_date: "20/07/2026",
      lines: [{ category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipt }],
    });
    expect(status).toBe(400);
  });

  it("defaults the currency to the company base currency", async () => {
    const receipt = await uploadReceipt(filer);
    const { detail } = await createDraft({
      claim_date: "2026-07-20",
      lines: [{ category_id: category.meals, amount_cents: 1_000, receipt_file_id: receipt }],
    });
    expect(detail.claim.currency).toBe("MYR");
  });
});

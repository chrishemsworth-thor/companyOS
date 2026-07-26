# PRD-006 — People: Leave Management & Expense Claims

**Status:** Not started · **Priority:** P0 for module viability
**Depends on:** PRD-000 (approvals, files, notifications), PRD-001 (ledger dimensions)

---

## Problem Statement

The People module holds an employee directory, teams, and reporting lines. No Malaysian
SME will adopt an HR module that does not handle leave — leave is the process they
currently run on WhatsApp and a shared spreadsheet, and it is the reason they buy
Kakitangan, Swingvy, or Talenox. Without it, People is a staff list.

Claims are the more strategically valuable half. Every competing Malaysian HR product
handles claims as a workflow that ends in an approval and a CSV export to whoever does
the accounting. CompanyOS owns the general ledger, so an approved claim can post
directly to the GL, appear as a payable, flow into the cash-flow position, and be tagged
to a project for profitability. **No standalone HR product can do that, because they do
not own the books.** That is the demo.

Payroll remains deliberately out of scope — the EPF/SOCSO/EIS/PCB compliance treadmill
was already assessed as an undefensible moat, and plenty of SMEs run leave and claims
separately from an outsourced payroll bureau.

## Goals

1. An employee can request leave and see their balance without asking HR.
2. A manager can approve from a notification, on a phone, in under 30 seconds.
3. An approved expense claim posts to the general ledger automatically and appears in
   the cash position — the capability competitors structurally cannot match.
4. Leave balances are correct at all times, including mid-year joins and carry-forward.
5. Malaysian statutory minimums and state public holidays are handled correctly enough
   that an office manager trusts the numbers.

## Non-Goals

- **Payroll, EPF/SOCSO/EIS/PCB calculation, and statutory submissions.** Explicitly out
  of scope; the compliance burden is high and the moat is weak.
- **Time and attendance / clock-in.** Separate initiative, different buyer.
- **Performance reviews, OKRs, engagement surveys.** Not adjacent to the wedge.
- **Recruitment / ATS.** No.
- **Employee mobile app.** Console must be mobile-responsive; a native app is not this PRD.
- **Multi-country leave rules.** Malaysia only. Do not build a rules engine for a market
  we are not in.

## User Stories

**Leave**
- As an employee, I want to see my remaining annual leave so that I can plan without asking HR.
- As an employee, I want to request leave and know it reached my manager so that I stop
  chasing on WhatsApp.
- As a manager, I want to see who else in my team is off on those dates before I approve
  so that I do not leave the team uncovered.
- As an HR admin, I want to set different entitlements by employment type and tenure so
  that policy matches the employment contracts.
- As an employee, I want public holidays for my state excluded from my leave days so that
  I am not charged for a day I would not have worked.

**Claims**
- As an employee, I want to photograph a receipt and submit a claim so that I do not keep
  a shoebox of paper.
- As a manager, I want to see the receipt image next to the amount so that I can approve
  with confidence.
- As a finance operator, I want approved claims to appear as payables in the ledger so
  that I do not re-key them into accounting.
- As an agency owner, I want claims tagged to a client project so that project
  profitability includes reimbursed costs.

## Requirements

### P0 — Leave: policy and entitlement

- `leave_types` per tenant: name, code, paid/unpaid, requires-attachment (for medical
  certificates), max consecutive days, allows-half-day, carry-forward rules.
  Seed Malaysian defaults — annual, sick, hospitalisation, maternity, paternity,
  unpaid, compassionate — **all editable, none hardcoded.**
- `leave_policies`: entitlement in days by employment type and tenure band, with an
  accrual method (`annual_upfront` | `monthly_accrual` | `on_anniversary`).
- Employee assignment to a policy; pro-rating for mid-year joiners and leavers.
- `leave_balances` derived from entitlement + carry-forward − taken − pending.
  **Pending requests must reduce available balance** or employees will over-book.
- Employment Act minimums are a *seed default and a warning*, not an enforced floor —
  a tenant may have contractual terms above minimum and the system must not fight them.

**Acceptance criteria**
- [ ] Given an employee joining on 1 July with a 14-day annual entitlement and upfront
      accrual, then their first-year balance is pro-rated to 7 days.
- [ ] Given a pending 3-day request, then available balance is reduced by 3 immediately.
- [ ] Given a rejected request, then the balance is restored.
- [ ] Given carry-forward capped at 5 days, then a 9-day unused balance carries 5.
- [ ] Given an entitlement below the statutory minimum for that tenure, then the tenant
      is warned on save but not blocked.

### P0 — Leave: public holidays

- `public_holidays` table: date, name, scope (`national` | state code), tenant overrides.
- Seeded per calendar year. **State variation matters** — Selangor, Penang, Sarawak and
  others differ, and an office manager will notice on day one.
- Employee has a work location/state; leave day counting excludes their applicable
  holidays and non-working days.
- Configurable work week (default Mon–Fri; some tenants run Sat half-days, and Kelantan
  and Terengganu run Sun–Thu).

**Acceptance criteria**
- [ ] Given leave spanning a weekend and a state holiday, then only working days are deducted.
- [ ] Given employees in two states, then each has their own holiday set applied.
- [ ] Given a tenant with a Sun–Thu work week, then day counting reflects it.

### P0 — Leave: request and approval

- Request: type, start/end (half-day supported), reason, optional attachment (PRD-000),
  computed working days shown **before** submission.
- Routes to the manager via PRD-000 approvals; falls back to admin if no manager.
- Employee may cancel while pending; cancelling an approved future leave requires
  re-approval or admin action.
- Team calendar view: who is off, by team and by month. This is the feature managers
  actually use.
- Events: `leave.requested.v1`, `leave.approved.v1`, `leave.rejected.v1`,
  `leave.cancelled.v1`.
- Overlap warning when a request clashes with another team member's approved leave
  (warn, do not block).

**Acceptance criteria**
- [ ] Given a submitted request, then the manager has a notification and a pending approval.
- [ ] Given approval, then the balance is decremented and the employee is notified.
- [ ] Given a request exceeding available balance, then it is blocked with the shortfall
      stated (unless the leave type allows negative balance).
- [ ] Given a leave type requiring an attachment, then submission without one is rejected.
- [ ] Given overlapping dates with an existing request from the same employee, then 409.

### P0 — Claims: submission

- `expense_claims`: employee, claim date, category, description, amount, currency,
  tax amount, **receipt image (required, PRD-000)**, optional project and department.
- Claim categories per tenant: mileage, meals, travel, accommodation, supplies, other —
  each mapped to a **GL expense account**. This mapping is what makes posting possible.
- Multi-line claims (one submission, several receipts).
- Mileage as a category with distance × per-km rate.
- Per-category limits with warning on breach.

**Acceptance criteria**
- [ ] Given a claim without a receipt, then submission is rejected.
- [ ] Given a JPEG receipt photo, then it uploads and displays in the approval view.
- [ ] Given a multi-line claim, then the header total equals the sum of lines.
- [ ] Given a category over its limit, then a warning is shown and the claim still submits.

### P0 — Claims: approval and GL posting

**This is the differentiating requirement.**

- Approval routes via PRD-000 to the manager; a second finance approval above a
  configurable threshold (P1 if multi-step is not yet supported — single approver in v1).
- On approval, post a journal entry:
  **Dr {category expense account} / Dr SST Input (if applicable) / Cr Employee Reimbursements Payable**
  with `employee_id`, `project_id`, `department_code` dimensions from PRD-001.
- Add `Employee Reimbursements Payable` to the seeded chart of accounts.
- On reimbursement payment: **Dr Employee Reimbursements Payable / Cr Cash**, recorded
  as a payment against the claim.
- Unpaid approved claims appear as a liability and in cash-flow outlook.
- Rejection returns the claim to the employee with a comment; resubmission allowed.
- Events: `claim.submitted.v1`, `claim.approved.v1`, `claim.rejected.v1`, `claim.paid.v1`.

**Acceptance criteria**
- [ ] Given an approved RM250 meals claim, then a balanced journal entry posts to the
      meals expense account and reimbursements payable.
- [ ] Given a claim tagged to project P, then the expense line carries `project_id = P`
      and appears in P's profitability (PRD-001).
- [ ] Given a reimbursement payment, then payable is cleared and the claim is `paid`.
- [ ] Given a rejected claim, then no ledger entry exists.
- [ ] Given an approved claim, when edited, then 409 — approved claims are immutable
      because they have hit the ledger.
- [ ] Given claim approval, then the posting and the approval decision are atomic
      (no approved claim without its entry).

### P1

- Batch reimbursement run (pay all approved claims for a period as one payment).
- Leave encashment on exit.
- OCR of receipt images to pre-fill amount and date — a natural agent extension.
- Multi-step approval (manager then finance) once PRD-000 supports chains.
- Employee self-service view of their own leave and claim history as a standalone page.
- iCal feed of team leave.

### P2 (design for, do not build)

- **PeopleAgent**: flags leave-balance anomalies, chases unsubmitted claims, warns of
  understaffed periods, pre-fills claims from receipt images. Keep all events on the bus.
- Payroll integration by export to a bureau format rather than in-house calculation.
- Shift scheduling.

## Success Metrics

- An office manager can run a full month of leave without a spreadsheet.
- Approved claims appear in the P&L with correct account and dimensions, with zero
  re-keying — demonstrable in the seeded sample data.
- Leave balance correctness across mid-year joins, carry-forward, and state holidays is
  covered by tests, because a wrong balance destroys trust permanently.

## Open Questions

- **(Product, blocking)** Claims first or leave first? Claims makes the sharper demo and
  proves the architecture; leave gets the faster yes from the person who evaluates HR
  tools. Recommendation: claims first for validation, leave immediately after, because
  neither is sellable alone.
- **(Product, blocking)** Does v1 need multi-step approval (manager → finance) for claims,
  or is single-approver with a threshold-based single approver enough? Affects PRD-000 scope.
- **(Legal/HR, non-blocking)** Confirm current Employment Act 1955 leave minimums,
  including post-2022-amendment entitlements, before seeding defaults. Seeds are a
  starting point for tenants to edit, not compliance guidance.
- **(Engineering, non-blocking)** Where do public holidays come from each year —
  manual seed, or a maintained data file shipped with releases?

## Timeline Considerations

Hard-blocked on PRD-000 (approvals, files, notifications) and on PRD-001 ledger
dimensions for claims to post with project attribution.

Suggested phasing:
1. PRD-000 lands
2. Claims: submission + approval + GL posting (the differentiator)
3. Leave: types, policies, holidays, balances
4. Leave: requests, approvals, team calendar
5. Reimbursement batch run

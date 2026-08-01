import { z } from "zod";

/**
 * claim.paid.v1 — an approved claim was reimbursed (PRD-006a).
 *
 * The second posting in a claim's life: `Dr Employee Reimbursements Payable / Cr
 * Cash`, which clears exactly what approval created. After this the claim stops
 * counting toward the unpaid-claims liability in the cash-flow outlook.
 *
 * Emitted after the batch that wrote the entry and the `paid` status together, so
 * `entry_id` resolves for the same reason it does on `claim.approved`.
 */
export const claimPaidV1 = z.object({
  claim_id: z.string(),
  employee_id: z.string(),
  total_cents: z.number().int(),
  currency: z.string().length(3),
  paid_at: z.string().datetime(),
  /** The `Dr Employee Reimbursements Payable / Cr Cash` entry. */
  entry_id: z.string(),
  /** Bank reference, cheque number, however the tenant tracks the payout. */
  payment_reference: z.string().optional(),
});
export type ClaimPaidV1 = z.infer<typeof claimPaidV1>;

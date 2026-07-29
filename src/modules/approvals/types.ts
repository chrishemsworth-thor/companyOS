import { z } from "zod";

/**
 * Approvals primitive (PRD-000b) — vocabulary and row shape.
 *
 * Kept dependency-free so the resolution strategies, the service and the route
 * can all import it without cycles.
 */

/**
 * The subject types the primitive knows about.
 *
 * This enum is the ONLY thing a consuming module adds to use approvals — no
 * migration, because `approvals.subject_type` is plain TEXT (see
 * migrations/0022_approvals.sql). PRD-000's success metric is that PRD-004,
 * 006 and 007 each consume the primitive with zero schema additions beyond a
 * value here.
 *
 * `invoice` is RESERVED and unused in v1. PRD-000 lists it and PRD-007 specs a
 * renderer for it, but no PRD contains a requirement that requests an invoice
 * approval — PRD-001 does not gate invoice issue on one. It is carried here so
 * the enum matches the PRD and so the day something does request one it
 * resolves correctly, but nothing in this codebase creates one and S4 builds no
 * invoice renderer. See SESSION-PLAN conflict C5.
 */
export const subjectTypeSchema = z.enum([
  "leave_request",
  "expense_claim",
  "quote",
  "invoice",
  "other",
]);
export type SubjectType = z.infer<typeof subjectTypeSchema>;

/**
 * Row lifecycle. Unlike `subject_type` this IS constrained in SQL: it is the
 * primitive's own vocabulary and no consuming module extends it.
 *
 *   pending   → approved | rejected | cancelled
 *   approved  → (terminal)
 *   rejected  → (terminal)
 *   cancelled → (terminal)
 */
export const approvalStateSchema = z.enum(["pending", "approved", "rejected", "cancelled"]);
export type ApprovalState = z.infer<typeof approvalStateSchema>;

/** A decision a caller can record. Cancellation is not a decision — see the service. */
export type Decision = "approved" | "rejected";

export interface Approval {
  approval_id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  requested_by: string | null;
  approver_user_id: string;
  state: ApprovalState;
  decision_comment: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  idempotency_key: string | null;
}

export interface RequestApprovalInput {
  subject_type: SubjectType;
  subject_id: string;
  /**
   * The user who is asking. NULL/undefined for programmatic callers, which
   * have no user identity — resolution then skips the "not the requester" rule
   * because there is no requester to collide with.
   */
  requested_by?: string | null;
  /**
   * The employee the subject is ABOUT, when that differs from the requester —
   * e.g. an admin filing a claim on behalf of someone else, where the approver
   * should be that employee's manager rather than the admin's. Omitted in the
   * normal case, where it is derived from `requested_by`.
   */
  subject_employee_id?: string | null;
  /**
   * Explicit approver, bypassing resolution. For the rare case where a module
   * already knows who must decide. Still subject to every decision-time rule,
   * including the self-approval block.
   */
  approver_user_id?: string | null;
  /** Dedupe key: a repeat call with the same key returns the existing row. */
  idempotency_key?: string | null;
}

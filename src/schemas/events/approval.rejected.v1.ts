import { z } from "zod";

/**
 * approval.rejected.v1 — the decision went the other way.
 *
 * The comment is optional here, matching PRD-000 ("approve or reject with an
 * optional comment"), even though PRD-007's console requires one on reject. The
 * primitive stays permissive so a module calling `decide()` programmatically is
 * not blocked by a UI rule; consumers must handle its absence.
 *
 * A rejection is terminal for THIS row. Resubmission creates a new approval —
 * there is no `supersedes` link (SESSION-PLAN conflict C8).
 */
export const approvalRejectedV1 = z.object({
  approval_id: z.string(),
  subject_type: z.string(),
  subject_id: z.string(),
  requested_by: z.string().nullable(),
  approver_user_id: z.string(),
  decided_by: z.string(),
  decided_at: z.string().datetime(),
  comment: z.string().optional(),
});
export type ApprovalRejectedV1 = z.infer<typeof approvalRejectedV1>;

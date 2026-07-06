import { z } from "zod";

/** issue.completed.v1 — an issue reached done (companion to status_changed). */
export const issueCompletedV1 = z.object({
  issue_id: z.string(),
  project_id: z.string(),
  completed_at: z.string().datetime(),
});
export type IssueCompletedV1 = z.infer<typeof issueCompletedV1>;

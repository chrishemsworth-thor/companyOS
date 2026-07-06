import { z } from "zod";

const issueStatus = z.enum(["todo", "in_progress", "done", "cancelled"]);

/** issue.status_changed.v1 — an issue moved between statuses. */
export const issueStatusChangedV1 = z.object({
  issue_id: z.string(),
  project_id: z.string(),
  from: issueStatus,
  to: issueStatus,
});
export type IssueStatusChangedV1 = z.infer<typeof issueStatusChangedV1>;

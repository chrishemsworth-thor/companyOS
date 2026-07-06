import { z } from "zod";

/** issue.created.v1 — a new issue on a project. */
export const issueCreatedV1 = z.object({
  issue_id: z.string(),
  project_id: z.string(),
  title: z.string(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
});
export type IssueCreatedV1 = z.infer<typeof issueCreatedV1>;

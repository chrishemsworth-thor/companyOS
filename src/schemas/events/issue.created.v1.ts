import { z } from "zod";

/**
 * issue.created.v1 — a new issue on a project. The optional provenance fields
 * are present when the issue was mirrored in from an external tracker via
 * webhook ingestion (src/webhooks/).
 */
export const issueCreatedV1 = z.object({
  issue_id: z.string(),
  project_id: z.string(),
  title: z.string(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  provider: z.enum(["jira", "github", "bitbucket"]).optional(),
  external_id: z.string().optional(),
  external_url: z.string().optional(),
});
export type IssueCreatedV1 = z.infer<typeof issueCreatedV1>;

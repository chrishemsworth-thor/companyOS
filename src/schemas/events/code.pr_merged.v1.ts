import { z } from "zod";

/** code.pr_merged.v1 — a pull request merged on a connected external repo. */
export const codePrMergedV1 = z.object({
  provider: z.enum(["github", "bitbucket"]),
  repo: z.string(),
  external_id: z.string(),
  title: z.string(),
  source_branch: z.string().optional(),
  target_branch: z.string().optional(),
  external_actor: z.string().optional(),
  external_url: z.string().optional(),
});
export type CodePrMergedV1 = z.infer<typeof codePrMergedV1>;

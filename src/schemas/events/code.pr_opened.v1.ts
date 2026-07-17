import { z } from "zod";

/** code.pr_opened.v1 — a pull request opened on a connected external repo. */
export const codePrOpenedV1 = z.object({
  provider: z.enum(["github", "bitbucket"]),
  repo: z.string(),
  external_id: z.string(),
  title: z.string(),
  source_branch: z.string().optional(),
  target_branch: z.string().optional(),
  external_actor: z.string().optional(),
  external_url: z.string().optional(),
});
export type CodePrOpenedV1 = z.infer<typeof codePrOpenedV1>;

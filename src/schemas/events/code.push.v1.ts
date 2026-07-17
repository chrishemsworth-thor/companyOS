import { z } from "zod";

/** code.push.v1 — commits pushed to a connected external repo (GitHub/Bitbucket). */
export const codePushV1 = z.object({
  provider: z.enum(["github", "bitbucket"]),
  repo: z.string(),
  ref: z.string().optional(),
  commit_count: z.number().int().nonnegative().optional(),
  external_actor: z.string().optional(),
  external_url: z.string().optional(),
});
export type CodePushV1 = z.infer<typeof codePushV1>;

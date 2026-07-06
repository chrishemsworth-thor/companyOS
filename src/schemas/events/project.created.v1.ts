import { z } from "zod";

/** project.created.v1 — a new project in the build module. */
export const projectCreatedV1 = z.object({
  project_id: z.string(),
  name: z.string(),
});
export type ProjectCreatedV1 = z.infer<typeof projectCreatedV1>;

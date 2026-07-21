import { z } from "zod";

/** team.created.v1 — a new team in the People module. */
export const teamCreatedV1 = z.object({
  team_id: z.string(),
  name: z.string(),
  department_id: z.string().optional(),
});
export type TeamCreatedV1 = z.infer<typeof teamCreatedV1>;

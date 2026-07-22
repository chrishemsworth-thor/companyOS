import { z } from "zod";

/** lead.created.v1 — a new prospect entered the pipeline. */
export const leadCreatedV1 = z.object({
  lead_id: z.string(),
  name: z.string(),
  company: z.string().optional(),
  email: z.string().optional(),
  source: z.string(),
  status: z.enum(["new", "qualified", "converted", "lost"]),
});
export type LeadCreatedV1 = z.infer<typeof leadCreatedV1>;

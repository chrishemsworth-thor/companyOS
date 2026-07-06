import { z } from "zod";

/** deal.stage_changed.v1 — a deal moved between pipeline stages. */
export const dealStageChangedV1 = z.object({
  deal_id: z.string(),
  customer_id: z.string(),
  from_stage: z.string(),
  to_stage: z.string(),
});
export type DealStageChangedV1 = z.infer<typeof dealStageChangedV1>;

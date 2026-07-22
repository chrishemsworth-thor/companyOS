import { z } from "zod";

/**
 * lead.enriched.v1 — an enrichment provider filled at least one previously
 * empty field. Not emitted when the provider returned nothing new.
 */
export const leadEnrichedV1 = z.object({
  lead_id: z.string(),
  provider: z.string(),
  enriched_fields: z.array(z.string()).min(1),
});
export type LeadEnrichedV1 = z.infer<typeof leadEnrichedV1>;

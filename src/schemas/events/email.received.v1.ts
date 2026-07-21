import { z } from "zod";

/**
 * email.received.v1 — an inbound message observed in a connected Google mailbox
 * by the Phase-2 inbox sync (src/integrations/google/sync.ts). Metadata only:
 * the sync uses Gmail's format=metadata, so no body is carried on the bus.
 * Consumers that need the body fetch it from Gmail using message_id.
 */
export const emailReceivedV1 = z.object({
  account_id: z.string(),
  google_email: z.string(),
  message_id: z.string(),
  thread_id: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  snippet: z.string().optional(),
  date: z.string().optional(),
});
export type EmailReceivedV1 = z.infer<typeof emailReceivedV1>;

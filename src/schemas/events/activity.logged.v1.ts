import { z } from "zod";

/** activity.logged.v1 — a touch (note, call, email, meeting, reminder) recorded against a customer. */
export const activityLoggedV1 = z.object({
  activity_id: z.string(),
  customer_id: z.string(),
  deal_id: z.string().optional(),
  kind: z.enum(["note", "call", "email", "meeting", "reminder_sent"]),
  occurred_at: z.string().datetime(),
});
export type ActivityLoggedV1 = z.infer<typeof activityLoggedV1>;

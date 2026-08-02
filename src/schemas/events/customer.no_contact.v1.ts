import { z } from "zod";

/**
 * customer.no_contact.v1 — reminder dispatch could not find anybody to address.
 *
 * PRD-003 P0: "Given a customer with zero contacts, then reminder dispatch
 * fails gracefully with a `customer.no_contact` event rather than throwing."
 *
 * Emitted by `sendReminder` (src/delivery/dispatch.ts) when the whole
 * resolution chain comes up empty — no contact holding the requested role, no
 * primary, no contact at all, and no customer-level email or phone either.
 * The typed `DeliveryError("no_recipient")` is still raised afterwards so the
 * API answers 422 instead of a false success; see the dispatch comment.
 *
 * Registered without a NOTIFICATION_MAP entry on purpose: the notification
 * consumer must not query D1 to find a recipient (on the free plan it runs
 * inline with the emitting request), and there is no user id on this payload to
 * notify. It is an operational signal for events_log and the agent feed.
 *
 * Wire type is unversioned (`customer.no_contact`) per the registry convention;
 * PRD-003 writes it without a suffix and the envelope's `<entity>.<action>`
 * regex requires that shape.
 */
export const customerNoContactV1 = z.object({
  customer_id: z.string(),
  /** The invoice the reminder was for; null for non-invoice dispatch paths. */
  invoice_id: z.string().nullable(),
  /** The channel the caller asked for before fallback was attempted. */
  channel_requested: z.enum(["email", "whatsapp"]),
  /**
   * `no_contacts` — the customer has no contact rows and no customer-level
   * address. `no_address` — contacts exist but none carries an email or phone.
   * The distinction is what tells an operator whether to add a contact or fix
   * one.
   */
  reason: z.enum(["no_contacts", "no_address"]),
});
export type CustomerNoContactV1 = z.infer<typeof customerNoContactV1>;

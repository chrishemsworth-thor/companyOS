/**
 * Outbound delivery port — the one external boundary the native modules keep.
 * Email/WhatsApp providers (Resend, Twilio, ...) implement this; ConsoleDelivery
 * is the default log-and-ack implementation for dev/test.
 */

export interface ReminderRequest {
  invoice_id: string;
  customer_id: string;
  channel: "email" | "whatsapp";
  message: string;
}

export interface DeliveryProvider {
  /** Deliver an agent-composed nudge. Returns a delivery reference. */
  send(req: ReminderRequest): Promise<{ delivery_ref: string }>;
}

/**
 * Outbound delivery port — the one external boundary the native modules keep.
 * Email/WhatsApp providers (Resend, Twilio, ...) implement this; ConsoleDelivery
 * is the default log-and-ack implementation for dev/test.
 */

export type DeliveryChannel = "email" | "whatsapp";

export type DeliveryProviderName = "console" | "resend" | "twilio";

export interface ReminderRequest {
  invoice_id: string;
  customer_id: string;
  channel: DeliveryChannel;
  /** Recipient address: email for the email channel, E.164 phone for whatsapp. */
  to: string;
  /** Tenant sender identity from delivery_config (email or E.164 phone). */
  from: string;
  message: string;
}

export interface DeliveryProvider {
  readonly name: DeliveryProviderName;
  /** Deliver an agent-composed nudge. Returns a delivery reference. */
  send(req: ReminderRequest): Promise<{ delivery_ref: string }>;
}

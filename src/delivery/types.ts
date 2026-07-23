/**
 * Outbound delivery port — the one external boundary the native modules keep.
 * Email/WhatsApp providers (Resend, Twilio, ...) implement this; ConsoleDelivery
 * is the default log-and-ack implementation for dev/test.
 */

export type DeliveryChannel = "email" | "whatsapp";

export type DeliveryProviderName = "console" | "resend" | "twilio" | "google";

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

/**
 * Why an email is being sent. Recorded on every deliveries audit row and used
 * by the dispatcher to pick the gating class: customer-facing purposes stay
 * behind the per-tenant delivery_config opt-in, system purposes (operational
 * mail to the tenant's own staff) only need a configured transport.
 */
export type EmailPurpose =
  | "reminder"
  | "user_invite"
  | "password_reset"
  | "invoice"
  | "receipt"
  | "quote"
  | "internal_alert";

/** A fully-composed transactional email, ready for any email-capable provider. */
export interface EmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html?: string;
}

/** Providers that can carry arbitrary transactional email (console, resend, google). */
export interface EmailCapableProvider extends DeliveryProvider {
  sendEmail(msg: EmailMessage): Promise<{ delivery_ref: string }>;
}

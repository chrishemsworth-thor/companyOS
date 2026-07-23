import type { DeliveryProvider, EmailCapableProvider, EmailMessage, ReminderRequest } from "./types";

/** Log-and-ack delivery: the default whenever no real provider is configured. */
export class ConsoleDelivery implements DeliveryProvider, EmailCapableProvider {
  readonly name = "console" as const;

  async send(req: ReminderRequest): Promise<{ delivery_ref: string }> {
    console.log(
      `[reminder:console] ${req.channel} → customer ${req.customer_id} <${req.to}> re invoice ${req.invoice_id}: ${req.message}`,
    );
    return { delivery_ref: `dlv_${crypto.randomUUID()}` };
  }

  async sendEmail(msg: EmailMessage): Promise<{ delivery_ref: string }> {
    console.log(
      `[email:console] → <${msg.to}> subject="${msg.subject}": ${msg.text.slice(0, 200)}`,
    );
    return { delivery_ref: `dlv_${crypto.randomUUID()}` };
  }
}

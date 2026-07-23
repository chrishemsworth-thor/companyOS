import type { DeliveryProvider, EmailCapableProvider, EmailMessage, ReminderRequest } from "./types";

/**
 * Email delivery via Resend (https://resend.com). Plain fetch to the REST
 * API — no SDK, works natively on Workers. Selected by getDeliveryProvider
 * when RESEND_API_KEY is configured.
 */
export class ResendDelivery implements DeliveryProvider, EmailCapableProvider {
  readonly name = "resend" as const;

  constructor(private readonly apiKey: string) {}

  async send(req: ReminderRequest): Promise<{ delivery_ref: string }> {
    return this.sendEmail({
      to: req.to,
      from: req.from,
      subject: `Payment reminder — invoice ${req.invoice_id}`,
      text: req.message,
    });
  }

  async sendEmail(msg: EmailMessage): Promise<{ delivery_ref: string }> {
    const payload: Record<string, unknown> = {
      from: msg.from,
      to: [msg.to],
      subject: msg.subject,
      text: msg.text,
    };
    if (msg.html !== undefined) payload.html = msg.html;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new Error(`resend send failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { id: string };
    return { delivery_ref: body.id };
  }
}

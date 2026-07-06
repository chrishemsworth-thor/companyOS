import type { DeliveryProvider, ReminderRequest } from "./types";

/**
 * Email delivery via Resend (https://resend.com). Plain fetch to the REST
 * API — no SDK, works natively on Workers. Selected by getDeliveryProvider
 * when RESEND_API_KEY is configured.
 */
export class ResendDelivery implements DeliveryProvider {
  readonly name = "resend" as const;

  constructor(private readonly apiKey: string) {}

  async send(req: ReminderRequest): Promise<{ delivery_ref: string }> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: req.from,
        to: [req.to],
        subject: `Payment reminder — invoice ${req.invoice_id}`,
        text: req.message,
      }),
    });
    if (!res.ok) {
      throw new Error(`resend send failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { id: string };
    return { delivery_ref: body.id };
  }
}

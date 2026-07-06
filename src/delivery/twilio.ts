import type { DeliveryProvider, ReminderRequest } from "./types";

/**
 * WhatsApp delivery via the Twilio Messages API. Form-encoded POST with
 * Basic auth — no SDK, works natively on Workers. Selected by
 * getDeliveryProvider when TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN are set.
 */
export class TwilioDelivery implements DeliveryProvider {
  readonly name = "twilio" as const;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
  ) {}

  async send(req: ReminderRequest): Promise<{ delivery_ref: string }> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`;
    const form = new URLSearchParams({
      From: `whatsapp:${req.from}`,
      To: `whatsapp:${req.to}`,
      Body: req.message,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${this.accountSid}:${this.authToken}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (!res.ok) {
      throw new Error(`twilio send failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { sid: string };
    return { delivery_ref: body.sid };
  }
}

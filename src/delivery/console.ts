import type { DeliveryProvider, ReminderRequest } from "./types";

/** Log-and-ack delivery. Swapped for a real provider when Phase 2 wires email/WhatsApp. */
export class ConsoleDelivery implements DeliveryProvider {
  async send(req: ReminderRequest): Promise<{ delivery_ref: string }> {
    console.log(
      `[reminder:console] ${req.channel} → customer ${req.customer_id} re invoice ${req.invoice_id}: ${req.message}`,
    );
    return { delivery_ref: `dlv_${crypto.randomUUID()}` };
  }
}

/** Provider selection point; always console until a real provider is configured. */
export function getDeliveryProvider(): DeliveryProvider {
  return new ConsoleDelivery();
}

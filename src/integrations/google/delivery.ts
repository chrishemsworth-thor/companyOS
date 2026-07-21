import type { Env } from "../../env";
import type { DeliveryProvider, ReminderRequest } from "../../delivery/types";
import { getAccessToken } from "./tokens";
import { sendGmailMessage } from "./gmail-client";
import type { GoogleAccount } from "./types";

/**
 * Adapts a connected Google account to the DeliveryProvider port so the
 * existing reminder flow (sendReminder → deliveries audit log) can send through
 * Gmail. Selected in src/delivery/dispatch.ts when a tenant's email
 * delivery_config names a google_account_id.
 *
 * The From is always the connected mailbox — Gmail only lets you send as the
 * authenticated account (or its aliases), so the tenant's configured
 * from_address is intentionally ignored here.
 */
export class GmailReminderAdapter implements DeliveryProvider {
  readonly name = "google" as const;

  constructor(
    private readonly env: Env,
    private readonly account: GoogleAccount,
  ) {}

  async send(req: ReminderRequest): Promise<{ delivery_ref: string }> {
    const accessToken = await getAccessToken(this.env, this.account);
    const { id } = await sendGmailMessage(accessToken, {
      from: this.account.google_email,
      to: [req.to],
      subject: `Payment reminder — invoice ${req.invoice_id}`,
      bodyText: req.message,
    });
    return { delivery_ref: id };
  }
}

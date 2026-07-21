import { ulid } from "../lib/ulid";
import type { Env } from "../env";
import type { DeliveryChannel, DeliveryProvider, DeliveryProviderName } from "./types";
import { ConsoleDelivery } from "./console";
import { ResendDelivery } from "./resend";
import { TwilioDelivery } from "./twilio";
import { getAccount } from "../integrations/google/accounts";
import { GmailReminderAdapter } from "../integrations/google/delivery";
import { GMAIL_SEND_SCOPE, hasScope } from "../integrations/google/types";

export class DeliveryError extends Error {
  constructor(
    readonly code: "no_recipient" | "send_failed",
    message: string,
    readonly httpStatus: 422 | 502 = 422,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

/**
 * Provider selection point: the real provider when its secret is configured,
 * else ConsoleDelivery. Tests never configure secrets, so they always log.
 */
export function getDeliveryProvider(env: Env, channel: DeliveryChannel): DeliveryProvider {
  if (channel === "email" && env.RESEND_API_KEY) {
    return new ResendDelivery(env.RESEND_API_KEY);
  }
  if (channel === "whatsapp" && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN) {
    return new TwilioDelivery(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
  }
  return new ConsoleDelivery();
}

export interface SendReminderInput {
  invoice_id: string;
  customer_id: string;
  channel: DeliveryChannel;
  message: string;
}

export interface SendReminderResult {
  delivery_ref: string;
  /** The channel actually used (may differ from the request after fallback). */
  channel: DeliveryChannel;
  provider: DeliveryProviderName;
}

interface DeliveryConfigRow {
  from_address: string;
  enabled: number;
  google_account_id: string | null;
}

/**
 * Resolve the provider for an opted-in email send: a connected Gmail account
 * when the tenant's config names one (and it can still send), otherwise the
 * standard secret-driven selection (Resend → console). WhatsApp is unaffected.
 */
async function resolveEmailProvider(
  env: Env,
  tenantId: string,
  config: DeliveryConfigRow,
): Promise<DeliveryProvider> {
  if (config.google_account_id) {
    const account = await getAccount(env.DB, tenantId, config.google_account_id);
    if (account && account.status === "active" && hasScope(account.scopes, GMAIL_SEND_SCOPE)) {
      return new GmailReminderAdapter(env, account);
    }
    // Named account is gone/revoked/under-scoped — fall back rather than fail.
  }
  return getDeliveryProvider(env, "email");
}

/**
 * The one path every reminder takes: resolve the recipient address from the
 * customers table (falling back to the other channel when the requested one
 * has no address), gate real providers on the tenant's delivery_config
 * opt-in, send, and append a deliveries row for the audit trail.
 */
export async function sendReminder(
  env: Env,
  tenantId: string,
  input: SendReminderInput,
): Promise<SendReminderResult> {
  const customer = await env.DB.prepare(
    "SELECT email, phone FROM customers WHERE tenant_id = ? AND customer_id = ?",
  )
    .bind(tenantId, input.customer_id)
    .first<{ email: string | null; phone: string | null }>();

  const address: Record<DeliveryChannel, string | null> = {
    email: customer?.email ?? null,
    whatsapp: customer?.phone ?? null,
  };

  let channel = input.channel;
  if (!address[channel]) {
    const other: DeliveryChannel = channel === "email" ? "whatsapp" : "email";
    if (!address[other]) {
      throw new DeliveryError(
        "no_recipient",
        `customer ${input.customer_id} has no email or phone on file`,
      );
    }
    channel = other;
  }
  const to = address[channel] as string;

  const config = await env.DB.prepare(
    "SELECT from_address, enabled, google_account_id FROM delivery_config WHERE tenant_id = ? AND channel = ?",
  )
    .bind(tenantId, channel)
    .first<DeliveryConfigRow>();

  // Tenant-level opt-in: without an enabled delivery_config row the send
  // stays on the console even when provider secrets are configured. Email may
  // additionally route through a connected Gmail account (resolveEmailProvider).
  let provider: DeliveryProvider;
  if (config?.enabled !== 1) {
    provider = new ConsoleDelivery();
  } else if (channel === "email") {
    provider = await resolveEmailProvider(env, tenantId, config);
  } else {
    provider = getDeliveryProvider(env, channel);
  }

  const logRow = (status: "sent" | "failed", deliveryRef: string | null) =>
    env.DB.prepare(
      `INSERT INTO deliveries (delivery_id, tenant_id, invoice_id, customer_id, channel, provider, to_address, status, delivery_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `dlv_${ulid()}`,
        tenantId,
        input.invoice_id,
        input.customer_id,
        channel,
        provider.name,
        to,
        status,
        deliveryRef,
      )
      .run();

  try {
    const { delivery_ref } = await provider.send({
      invoice_id: input.invoice_id,
      customer_id: input.customer_id,
      channel,
      to,
      from: config?.from_address ?? "companyos@localhost",
      message: input.message,
    });
    await logRow("sent", delivery_ref);
    return { delivery_ref, channel, provider: provider.name };
  } catch (err) {
    await logRow("failed", null);
    throw new DeliveryError(
      "send_failed",
      `${provider.name} delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
}

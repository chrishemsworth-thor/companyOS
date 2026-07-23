import { ulid } from "../lib/ulid";
import type { Env } from "../env";
import type {
  DeliveryChannel,
  DeliveryProvider,
  DeliveryProviderName,
  EmailCapableProvider,
  EmailPurpose,
} from "./types";
import { ConsoleDelivery } from "./console";
import { ResendDelivery } from "./resend";
import { TwilioDelivery } from "./twilio";
import { getAccount } from "../integrations/google/accounts";
import { GmailDeliveryAdapter } from "../integrations/google/delivery";
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

async function loadDeliveryConfig(
  env: Env,
  tenantId: string,
  channel: DeliveryChannel,
): Promise<DeliveryConfigRow | null> {
  return env.DB.prepare(
    "SELECT from_address, enabled, google_account_id FROM delivery_config WHERE tenant_id = ? AND channel = ?",
  )
    .bind(tenantId, channel)
    .first<DeliveryConfigRow>();
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
      return new GmailDeliveryAdapter(env, account);
    }
    // Named account is gone/revoked/under-scoped — fall back rather than fail.
  }
  return getDeliveryProvider(env, "email");
}

/** Audit references attached to a deliveries row. */
interface DeliveryRefs {
  invoice_id?: string;
  customer_id?: string;
  user_id?: string;
}

/** Append one deliveries audit row; shared by sendReminder and sendEmail. */
function appendDeliveryRow(
  env: Env,
  tenantId: string,
  row: {
    purpose: EmailPurpose;
    refs: DeliveryRefs;
    subject: string | null;
    channel: DeliveryChannel;
    provider: DeliveryProviderName;
    to: string;
    status: "sent" | "failed";
    delivery_ref: string | null;
  },
) {
  return env.DB.prepare(
    `INSERT INTO deliveries (delivery_id, tenant_id, purpose, invoice_id, customer_id, user_id, subject, channel, provider, to_address, status, delivery_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      `dlv_${ulid()}`,
      tenantId,
      row.purpose,
      row.refs.invoice_id ?? null,
      row.refs.customer_id ?? null,
      row.refs.user_id ?? null,
      row.subject,
      row.channel,
      row.provider,
      row.to,
      row.status,
      row.delivery_ref,
    )
    .run();
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

  const config = await loadDeliveryConfig(env, tenantId, channel);

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

  const refs: DeliveryRefs = { invoice_id: input.invoice_id, customer_id: input.customer_id };

  try {
    const { delivery_ref } = await provider.send({
      invoice_id: input.invoice_id,
      customer_id: input.customer_id,
      channel,
      to,
      from: config?.from_address ?? "companyos@localhost",
      message: input.message,
    });
    await appendDeliveryRow(env, tenantId, {
      purpose: "reminder",
      refs,
      subject: null,
      channel,
      provider: provider.name,
      to,
      status: "sent",
      delivery_ref,
    });
    return { delivery_ref, channel, provider: provider.name };
  } catch (err) {
    await appendDeliveryRow(env, tenantId, {
      purpose: "reminder",
      refs,
      subject: null,
      channel,
      provider: provider.name,
      to,
      status: "failed",
      delivery_ref: null,
    });
    throw new DeliveryError(
      "send_failed",
      `${provider.name} delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
}

/**
 * System purposes are operational mail to the tenant's own people (invites,
 * password resets, internal alerts). They bypass the delivery_config.enabled
 * opt-in — that flag is a customer-contact gate (see migrations/0007) and an
 * invite must be deliverable before a tenant has configured dunning. Transport
 * still resolves connected Gmail → Resend → console, so a deploy with no
 * secrets keeps logging to the console as always.
 */
const SYSTEM_PURPOSES: ReadonlySet<EmailPurpose> = new Set([
  "user_invite",
  "password_reset",
  "internal_alert",
]);

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  purpose: EmailPurpose;
  /** Optional audit references written to the deliveries row. */
  refs?: DeliveryRefs;
}

export interface SendEmailResult {
  delivery_ref: string;
  provider: DeliveryProviderName;
}

/**
 * Send an arbitrary transactional email. Customer-facing purposes keep the
 * per-tenant delivery_config.enabled opt-in exactly like sendReminder; system
 * purposes only need a configured transport (see SYSTEM_PURPOSES). Every send
 * — real or console — is appended to the deliveries audit log with its purpose.
 */
export async function sendEmail(
  env: Env,
  tenantId: string,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  const config = await loadDeliveryConfig(env, tenantId, "email");
  const isSystem = SYSTEM_PURPOSES.has(input.purpose);

  let provider: DeliveryProvider;
  if (isSystem) {
    provider = config
      ? await resolveEmailProvider(env, tenantId, config)
      : getDeliveryProvider(env, "email");
  } else if (config?.enabled !== 1) {
    provider = new ConsoleDelivery();
  } else {
    provider = await resolveEmailProvider(env, tenantId, config);
  }

  const from = isSystem
    ? (config?.from_address ?? env.SYSTEM_FROM_ADDRESS ?? "companyos@localhost")
    : (config?.from_address ?? "companyos@localhost");

  const refs = input.refs ?? {};

  try {
    const { delivery_ref } = await (provider as EmailCapableProvider).sendEmail({
      to: input.to,
      from,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    await appendDeliveryRow(env, tenantId, {
      purpose: input.purpose,
      refs,
      subject: input.subject,
      channel: "email",
      provider: provider.name,
      to: input.to,
      status: "sent",
      delivery_ref,
    });
    return { delivery_ref, provider: provider.name };
  } catch (err) {
    await appendDeliveryRow(env, tenantId, {
      purpose: input.purpose,
      refs,
      subject: input.subject,
      channel: "email",
      provider: provider.name,
      to: input.to,
      status: "failed",
      delivery_ref: null,
    });
    throw new DeliveryError(
      "send_failed",
      `${provider.name} delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }
}

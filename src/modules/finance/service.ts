import { ulid } from "ulid";
import { makeEnvelope } from "../../schemas/envelope";
import {
  buildEntryStatements,
  ensureSystemAccounts,
  getAccountByCode,
} from "./ledger";
import type { Invoice, InvoiceLine, InvoiceStatus } from "./types";

/**
 * Native finance service — owns every invoice/payment write. Each mutation is
 * one atomic D1 batch (rows + the journal entry behind them), followed by
 * event emission onto the bus. The queue consumer's INSERT OR IGNORE into
 * events_log makes at-least-once emission safe.
 *
 * Posting rules (deliberately minimal):
 *   invoice issued    → Dr Accounts Receivable / Cr Revenue
 *   payment received  → Dr Cash / Cr Accounts Receivable
 */

export class FinanceError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_total"
      | "invalid_status"
      | "customer_mismatch"
      | "currency_mismatch"
      | "amount_mismatch"
      | "overpayment",
    message: string,
    readonly httpStatus: 404 | 409 | 422 = 422,
  ) {
    super(message);
    this.name = "FinanceError";
  }
}

export interface CreateInvoiceInput {
  customer_id: string;
  currency: string;
  due_date: string; // ISO date
  lines: { description: string; quantity: number; unit_cents: number }[];
}

export interface RecordPaymentInput {
  customer_id: string;
  amount_cents: number;
  currency: string;
  method?: string;
  received_at?: string;
  applications: { invoice_id: string; applied_cents: number }[];
}

interface InvoiceRow {
  invoice_id: string;
  customer_id: string;
  status: InvoiceStatus;
  total_cents: number;
  amount_due_cents: number;
  currency: string;
  due_date: string;
  issued_at: string | null;
  sent_at: string | null;
  paid_at: string | null;
}

const INVOICE_COLUMNS =
  "invoice_id, customer_id, status, total_cents, amount_due_cents, currency, due_date, issued_at, sent_at, paid_at";

export async function getInvoice(
  db: D1Database,
  tenantId: string,
  invoiceId: string,
): Promise<Invoice | null> {
  return db
    .prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE tenant_id = ? AND invoice_id = ?`)
    .bind(tenantId, invoiceId)
    .first<InvoiceRow>();
}

export async function listInvoices(
  db: D1Database,
  tenantId: string,
  filter: { status?: InvoiceStatus },
): Promise<Invoice[]> {
  const query = filter.status
    ? db
        .prepare(
          `SELECT ${INVOICE_COLUMNS} FROM invoices WHERE tenant_id = ? AND status = ? ORDER BY due_date`,
        )
        .bind(tenantId, filter.status)
    : db
        .prepare(`SELECT ${INVOICE_COLUMNS} FROM invoices WHERE tenant_id = ? ORDER BY due_date`)
        .bind(tenantId);
  const { results } = await query.all<InvoiceRow>();
  return results;
}

export async function getInvoiceLines(
  db: D1Database,
  tenantId: string,
  invoiceId: string,
): Promise<InvoiceLine[]> {
  const { results } = await db
    .prepare(
      `SELECT line_no, description, quantity, unit_cents FROM invoice_lines
       WHERE tenant_id = ? AND invoice_id = ? ORDER BY line_no`,
    )
    .bind(tenantId, invoiceId)
    .all<InvoiceLine>();
  return results;
}

/** Issue an invoice: rows + AR/Revenue journal entry in one batch, then emit invoice.created. */
export async function createInvoice(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: CreateInvoiceInput,
): Promise<Invoice> {
  const totalCents = input.lines.reduce((sum, l) => sum + l.quantity * l.unit_cents, 0);
  if (totalCents <= 0) {
    throw new FinanceError("invalid_total", "invoice total must be positive");
  }

  await ensureSystemAccounts(env.DB, tenantId);
  const ar = await getAccountByCode(env.DB, tenantId, "1100");
  const revenue = await getAccountByCode(env.DB, tenantId, "4000");

  const invoiceId = `inv_${ulid()}`;
  const issuedAt = new Date().toISOString();
  const { statements: entryStatements } = buildEntryStatements(env.DB, tenantId, {
    entry_date: issuedAt.slice(0, 10),
    memo: `invoice ${invoiceId} issued`,
    currency: input.currency,
    source_type: "invoice",
    source_id: invoiceId,
    lines: [
      { account_id: ar.account_id, amount_cents: totalCents },
      { account_id: revenue.account_id, amount_cents: -totalCents },
    ],
  });

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO invoices
         (invoice_id, tenant_id, customer_id, status, amount_due_cents, total_cents, currency, due_date, issued_at)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    ).bind(
      invoiceId,
      tenantId,
      input.customer_id,
      totalCents,
      totalCents,
      input.currency,
      input.due_date,
      issuedAt,
    ),
    ...input.lines.map((line, i) =>
      env.DB.prepare(
        `INSERT INTO invoice_lines (invoice_id, tenant_id, line_no, description, quantity, unit_cents)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(invoiceId, tenantId, i + 1, line.description, line.quantity, line.unit_cents),
    ),
    ...entryStatements,
  ]);

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "invoice.created",
      source_module: "finance",
      tenant_id: tenantId,
      payload: {
        invoice_id: invoiceId,
        customer_id: input.customer_id,
        total_cents: totalCents,
        currency: input.currency,
        due_date: input.due_date,
      },
    }),
  );

  return (await getInvoice(env.DB, tenantId, invoiceId))!;
}

/** Mark a draft invoice sent and emit invoice.sent. */
export async function sendInvoice(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  invoiceId: string,
): Promise<Invoice> {
  const invoice = await getInvoice(env.DB, tenantId, invoiceId);
  if (!invoice) throw new FinanceError("not_found", "invoice not found", 404);
  if (invoice.status !== "draft") {
    throw new FinanceError("invalid_status", `invoice is ${invoice.status}, expected draft`, 409);
  }

  const sentAt = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE invoices SET status = 'sent', sent_at = ?, updated_at = ? WHERE tenant_id = ? AND invoice_id = ?",
  )
    .bind(sentAt, sentAt, tenantId, invoiceId)
    .run();

  await env.EVENTS.send(
    makeEnvelope({
      event_type: "invoice.sent",
      source_module: "finance",
      tenant_id: tenantId,
      payload: { invoice_id: invoiceId, customer_id: invoice.customer_id, sent_at: sentAt },
    }),
  );

  return { ...invoice, status: "sent", sent_at: sentAt };
}

/**
 * Record a payment and apply it to one or more invoices atomically:
 * payment row + applications + invoice updates + Cash/AR journal entry.
 * Emits payment.received per fully settled invoice and payment.partial
 * per partially settled one.
 */
export async function recordPayment(
  env: { DB: D1Database; EVENTS: Queue },
  tenantId: string,
  input: RecordPaymentInput,
): Promise<{ payment_id: string; entry_id: string }> {
  const appliedTotal = input.applications.reduce((sum, a) => sum + a.applied_cents, 0);
  if (appliedTotal !== input.amount_cents) {
    throw new FinanceError(
      "amount_mismatch",
      `applications sum to ${appliedTotal}, payment is ${input.amount_cents}`,
    );
  }

  const settlable: InvoiceStatus[] = ["sent", "overdue", "partially_paid"];
  const invoices = new Map<string, Invoice>();
  for (const app of input.applications) {
    const invoice = await getInvoice(env.DB, tenantId, app.invoice_id);
    if (!invoice) throw new FinanceError("not_found", `invoice ${app.invoice_id} not found`, 404);
    if (invoice.customer_id !== input.customer_id) {
      throw new FinanceError(
        "customer_mismatch",
        `invoice ${app.invoice_id} belongs to ${invoice.customer_id}`,
      );
    }
    if (invoice.currency !== input.currency) {
      throw new FinanceError(
        "currency_mismatch",
        `invoice ${app.invoice_id} is in ${invoice.currency}`,
      );
    }
    if (!settlable.includes(invoice.status)) {
      throw new FinanceError(
        "invalid_status",
        `invoice ${app.invoice_id} is ${invoice.status}, not payable`,
        409,
      );
    }
    if (app.applied_cents > invoice.amount_due_cents) {
      throw new FinanceError(
        "overpayment",
        `invoice ${app.invoice_id} has ${invoice.amount_due_cents} due, cannot apply ${app.applied_cents}`,
      );
    }
    invoices.set(app.invoice_id, invoice);
  }

  await ensureSystemAccounts(env.DB, tenantId);
  const cash = await getAccountByCode(env.DB, tenantId, "1000");
  const ar = await getAccountByCode(env.DB, tenantId, "1100");

  const paymentId = `pay_${ulid()}`;
  const receivedAt = input.received_at ?? new Date().toISOString();
  const { entry_id, statements: entryStatements } = buildEntryStatements(env.DB, tenantId, {
    entry_date: receivedAt.slice(0, 10),
    memo: `payment ${paymentId} received`,
    currency: input.currency,
    source_type: "payment",
    source_id: paymentId,
    lines: [
      { account_id: cash.account_id, amount_cents: input.amount_cents },
      { account_id: ar.account_id, amount_cents: -input.amount_cents },
    ],
  });

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO payments
         (payment_id, tenant_id, customer_id, amount_cents, currency, method, received_at, entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      paymentId,
      tenantId,
      input.customer_id,
      input.amount_cents,
      input.currency,
      input.method ?? "bank_transfer",
      receivedAt,
      entry_id,
    ),
    ...input.applications.map((app) =>
      env.DB.prepare(
        `INSERT INTO payment_applications (payment_id, invoice_id, tenant_id, applied_cents)
         VALUES (?, ?, ?, ?)`,
      ).bind(paymentId, app.invoice_id, tenantId, app.applied_cents),
    ),
    ...input.applications.map((app) => {
      const remaining = invoices.get(app.invoice_id)!.amount_due_cents - app.applied_cents;
      return env.DB.prepare(
        `UPDATE invoices
         SET amount_due_cents = ?, status = ?, paid_at = ?, updated_at = ?
         WHERE tenant_id = ? AND invoice_id = ?`,
      ).bind(
        remaining,
        remaining === 0 ? "paid" : "partially_paid",
        remaining === 0 ? now : null,
        now,
        tenantId,
        app.invoice_id,
      );
    }),
    ...entryStatements,
  ]);

  for (const app of input.applications) {
    const remaining = invoices.get(app.invoice_id)!.amount_due_cents - app.applied_cents;
    if (remaining === 0) {
      await env.EVENTS.send(
        makeEnvelope({
          event_type: "payment.received",
          source_module: "finance",
          tenant_id: tenantId,
          payload: {
            payment_id: paymentId,
            invoice_id: app.invoice_id,
            customer_id: input.customer_id,
            amount_paid_cents: app.applied_cents,
            currency: input.currency,
          },
        }),
      );
    } else {
      await env.EVENTS.send(
        makeEnvelope({
          event_type: "payment.partial",
          source_module: "finance",
          tenant_id: tenantId,
          payload: {
            payment_id: paymentId,
            invoice_id: app.invoice_id,
            customer_id: input.customer_id,
            amount_paid_cents: app.applied_cents,
            remaining_cents: remaining,
            currency: input.currency,
          },
        }),
      );
    }
  }

  return { payment_id: paymentId, entry_id };
}

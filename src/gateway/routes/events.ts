import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { pageQuerySchema, paginate } from "../pagination";
import { eventRegistry } from "../../schemas/events/registry";

/**
 * Read-only feed over events_log, primarily so the operator UI can surface
 * agent activity (collections decisions, risk flags) without raw DB access.
 * Filters by event type and by the customer/invoice the payload references.
 */

const querySchema = pageQuerySchema.extend({
  type: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    )
    .refine((types) => !types || types.every((t) => t in eventRegistry), {
      message: "unknown event type",
    }),
  customer_id: z.string().optional(),
  invoice_id: z.string().optional(),
});

interface EventRow {
  event_id: string;
  event_type: string;
  source_module: string;
  occurred_at: string;
  trace_id: string;
  payload: string;
}

export const events = new Hono<AuthedEnv>();

events.get("/", zValidator("query", querySchema), async (c) => {
  const tenant = c.get("tenant");
  const { limit, cursor, type, customer_id, invoice_id } = c.req.valid("query");

  const where = ["tenant_id = ?"];
  const binds: unknown[] = [tenant.tenant_id];
  if (type && type.length > 0) {
    where.push(`event_type IN (${type.map(() => "?").join(", ")})`);
    binds.push(...type);
  }
  if (customer_id) {
    where.push("json_extract(payload, '$.customer_id') = ?");
    binds.push(customer_id);
  }
  if (invoice_id) {
    // Direct reference, or membership in a risk flag's open_invoices list.
    where.push(
      "(json_extract(payload, '$.invoice_id') = ? OR EXISTS (SELECT 1 FROM json_each(payload, '$.open_invoices') WHERE json_each.value = ?))",
    );
    binds.push(invoice_id, invoice_id);
  }
  if (cursor) {
    where.push("event_id < ?");
    binds.push(cursor);
  }

  // Newest first: event_ids are ULIDs, so DESC on the id is DESC on time and
  // the cursor walks backwards with `event_id < cursor`.
  const rows = await c.env.DB.prepare(
    `SELECT event_id, event_type, source_module, occurred_at, trace_id, payload
     FROM events_log
     WHERE ${where.join(" AND ")}
     ORDER BY event_id DESC
     LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<EventRow>();

  const page = paginate(rows.results, limit, "event_id");
  return c.json({
    items: page.items.map((row) => ({ ...row, payload: JSON.parse(row.payload) })),
    next_cursor: page.next_cursor,
  });
});

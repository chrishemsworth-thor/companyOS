import { z } from "zod";

/**
 * The fixture contract, enforced.
 *
 * PRD-002 asks whether scenarios should be committed fixtures or generated from
 * `seed:sample`, and this harness commits them: a baseline can only be compared
 * against a frozen context, and a scenario that drifts when the seed changes is
 * not a regression test. The cost of that choice is that a fixture can rot
 * silently against the context type — so it is validated on load, and a typo
 * fails the run rather than quietly evaluating a context with no invoices in it.
 */

const nullableString = z.string().nullable();

export const overdueInvoiceSchema = z.object({
  invoice_id: z.string().min(1),
  amount_due_cents: z.number().int(),
  currency: z.string().length(3),
  due_date: z.string(),
  days_overdue: z.number().int().min(0),
});

export const collectionsContextSchema = z.object({
  customer: z
    .object({
      customer_id: z.string(),
      name: z.string(),
      email: nullableString,
      phone: nullableString,
    })
    .nullable(),
  billing_contact: z
    .object({
      contact_id: z.string(),
      name: z.string(),
      title: nullableString,
      email: nullableString,
      phone: nullableString,
      matched: z.enum(["role", "primary", "any"]),
    })
    .nullable(),
  health: z
    .object({
      band: z.enum(["good", "watch", "at_risk"]),
      reasons: z.array(z.string()),
    })
    .nullable(),
  overdue_invoices: z.array(overdueInvoiceSchema),
  recent_payments: z.array(
    z.object({
      payment_id: z.string(),
      invoice_id: z.string(),
      applied_cents: z.number().int(),
      currency: z.string().length(3),
      received_at: z.string(),
    }),
  ),
  recent_activities: z.array(
    z.object({
      kind: z.string(),
      body: nullableString,
      occurred_at: z.string(),
    }),
  ),
  open_deals: z.array(
    z.object({
      title: z.string(),
      value_cents: z.number().int(),
      currency: z.string().length(3),
    }),
  ),
});

export const agentStateSummarySchema = z.object({
  escalation_stage: z.enum(["none", "reminded", "escalated"]),
  reminders_sent: z.number().int().min(0),
  last_contact: nullableString,
});

export const expectationSchema = z.object({
  action: z.array(z.string()).optional(),
  risk_score: z.object({ min: z.number().optional(), max: z.number().optional() }).optional(),
  channel: z.array(z.string()).optional(),
  source: z.array(z.enum(["llm", "fallback"])).optional(),
  message: z
    .object({
      mentions_refs: z.array(z.string()).optional(),
      forbids: z.array(z.string()).optional(),
      requires: z.array(z.string()).optional(),
      max_chars: z.number().int().optional(),
      min_chars: z.number().int().optional(),
    })
    .optional(),
  overrides: z
    .object({ expected: z.boolean(), guardrails: z.array(z.string()).optional() })
    .optional(),
});

export const llmModeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("live") }),
  z.object({ mode: z.literal("canned"), response: z.unknown() }),
  z.object({ mode: z.literal("malformed"), response: z.unknown().optional() }),
]);

export const collectionsScenarioSchema = z.object({
  id: z.string().regex(/^c\d{2}-[a-z0-9-]+$/, "id must look like c01-some-slug"),
  title: z.string().min(1),
  covers: z.string().min(1),
  now: z.string(),
  llm: llmModeSchema,
  state: agentStateSummarySchema,
  context: collectionsContextSchema,
  expect: expectationSchema,
  fallback: z.object({
    handled: z.boolean(),
    note: z.string().optional(),
    missing: z.array(z.string()).optional(),
  }),
  fixture_only: z.object({ blocked_by: z.string(), note: z.string() }).optional(),
  policy: z.record(z.union([z.number(), z.boolean()])).optional(),
});

export type CollectionsScenarioFixture = z.infer<typeof collectionsScenarioSchema>;

/** Parse one fixture, naming the file when it is wrong. */
export function parseScenario(raw: unknown, source: string): CollectionsScenarioFixture {
  const result = collectionsScenarioSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`eval fixture ${source} is invalid: ${result.error.message}`);
  }
  return result.data;
}

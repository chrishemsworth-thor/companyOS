import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { pageQuerySchema } from "../pagination";
import {
  accountBalance,
  ensureSystemAccounts,
  getEntry,
  LedgerError,
  listAccounts,
  listEntries,
  postEntry,
  reverseEntry,
} from "../../modules/finance/ledger";

const entryBodySchema = z.object({
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "entry_date must be YYYY-MM-DD"),
  memo: z.string().max(500).optional(),
  currency: z.string().length(3),
  lines: z
    .array(
      z.object({
        account_id: z.string().startsWith("acct_"),
        // Signed cents: > 0 debit, < 0 credit.
        amount_cents: z.number().int(),
      }),
    )
    .min(2),
});

export const ledger = new Hono<AuthedEnv>();

ledger.get("/accounts", async (c) => {
  const tenant = c.get("tenant");
  await ensureSystemAccounts(c.env.DB, tenant.tenant_id);
  return c.json({ accounts: await listAccounts(c.env.DB, tenant.tenant_id) });
});

ledger.get("/accounts/:id/balance", async (c) => {
  const tenant = c.get("tenant");
  const balance = await accountBalance(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!balance) return c.json({ error: "account not found" }, 404);
  return c.json(balance);
});

/** Manual journal entry. Unbalanced or otherwise invalid → 422, nothing written. */
ledger.post("/entries", zValidator("json", entryBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const body = c.req.valid("json");
  try {
    const { entry_id } = await postEntry(c.env.DB, tenant.tenant_id, {
      ...body,
      source_type: "manual",
    });
    return c.json({ entry_id }, 201);
  } catch (err) {
    if (err instanceof LedgerError) return c.json({ error: err.message, code: err.code }, 422);
    throw err;
  }
});

ledger.get("/entries", zValidator("query", pageQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const { cursor, limit } = c.req.valid("query");
  return c.json(await listEntries(c.env.DB, tenant.tenant_id, { cursor, limit }));
});

ledger.get("/entries/:id", async (c) => {
  const tenant = c.get("tenant");
  const entry = await getEntry(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!entry) return c.json({ error: "entry not found" }, 404);
  return c.json(entry);
});

/** Corrections are reversals, never edits — the ledger tables are append-only. */
ledger.post("/entries/:id/reverse", async (c) => {
  const tenant = c.get("tenant");
  const result = await reverseEntry(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!result) return c.json({ error: "entry not found" }, 404);
  return c.json({ entry_id: result.entry_id }, 201);
});

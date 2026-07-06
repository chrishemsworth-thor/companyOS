import { Hono } from "hono";
import type { Env } from "./env";
import { apiKeyAuth, type AuthedEnv } from "./gateway/middleware/auth";
import { invoices } from "./gateway/routes/invoices";
import { customers } from "./gateway/routes/customers";
import { ledger } from "./gateway/routes/ledger";
import { payments } from "./gateway/routes/payments";
import { deals } from "./gateway/routes/deals";
import { activities } from "./gateway/routes/activities";
import { tickets } from "./gateway/routes/tickets";
import { handleEventBatch } from "./queue/consumer";
import { runOverdueSweep } from "./modules/finance/overdue-sweep";

export { CollectionsAgent } from "./agents/collections";

const app = new Hono<AuthedEnv>();

app.get("/health", (c) => c.json({ ok: true, service: "companyos-gateway" }));

// Everything under /v1 requires a tenant API key.
app.use("/v1/*", apiKeyAuth());
app.route("/v1/invoices", invoices);
app.route("/v1/customers", customers);
app.route("/v1/ledger", ledger);
app.route("/v1/payments", payments);
app.route("/v1/deals", deals);
app.route("/v1/activities", activities);
app.route("/v1/tickets", tickets);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(`[gateway] unhandled error: ${err.stack ?? err.message}`);
  return c.json({ error: "internal error" }, 500);
});

export default {
  fetch: app.fetch,
  queue: handleEventBatch,
  // Daily overdue sweep — native replacement for ERPNext's due-date webhook.
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runOverdueSweep(env));
  },
} satisfies ExportedHandler<Env>;

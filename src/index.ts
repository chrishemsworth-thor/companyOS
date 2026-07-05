import { Hono } from "hono";
import type { Env } from "./env";
import { apiKeyAuth, type AuthedEnv } from "./gateway/middleware/auth";
import { invoices } from "./gateway/routes/invoices";
import { customers } from "./gateway/routes/customers";
import { webhooks } from "./gateway/routes/webhooks";
import { ledger } from "./gateway/routes/ledger";
import { handleEventBatch } from "./queue/consumer";

export { CollectionsAgent } from "./agents/collections";

const app = new Hono<AuthedEnv>();

app.get("/health", (c) => c.json({ ok: true, service: "companyos-gateway" }));

// Everything under /v1 requires a tenant API key.
app.use("/v1/*", apiKeyAuth());
app.route("/v1/invoices", invoices);
app.route("/v1/customers", customers);
app.route("/v1/webhooks", webhooks);
app.route("/v1/ledger", ledger);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(`[gateway] unhandled error: ${err.stack ?? err.message}`);
  return c.json({ error: "internal error" }, 500);
});

export default {
  fetch: app.fetch,
  queue: handleEventBatch,
} satisfies ExportedHandler<Env>;

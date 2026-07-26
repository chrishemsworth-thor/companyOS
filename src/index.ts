import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { type AuthedEnv } from "./gateway/middleware/auth";
import { authenticate } from "./gateway/middleware/session";
import { auth } from "./gateway/routes/auth";
import { platform } from "./gateway/routes/platform";
import { users } from "./gateway/routes/users";
import { meta } from "./gateway/routes/meta";
import { insights } from "./gateway/routes/insights";
import { invoices } from "./gateway/routes/invoices";
import { customers } from "./gateway/routes/customers";
import { ledger } from "./gateway/routes/ledger";
import { payments } from "./gateway/routes/payments";
import { deals } from "./gateway/routes/deals";
import { leads } from "./gateway/routes/leads";
import { activities } from "./gateway/routes/activities";
import { tickets } from "./gateway/routes/tickets";
import { projects, issues } from "./gateway/routes/projects";
import { events } from "./gateway/routes/events";
import { quotes } from "./gateway/routes/quotes";
import { settings } from "./gateway/routes/settings";
import { people } from "./gateway/routes/people";
import { webhookSources } from "./gateway/routes/webhook-sources";
import { googleAccounts } from "./gateway/routes/google-accounts";
import { googleOAuth } from "./gateway/routes/google-oauth";
import { webhooks } from "./webhooks/router";
import { handleEventBatch } from "./queue/consumer";
import { ensureEventBus } from "./queue/direct";
import { runOverdueSweep } from "./modules/finance/overdue-sweep";
import { runQuoteExpirySweep } from "./modules/quotes/expiry-sweep";
import { runGoogleInboxSync } from "./integrations/google/sync";

export { CollectionsAgent } from "./agents/collections";

const app = new Hono<AuthedEnv>();

// Baseline security response headers on every route. The API is JSON-only for
// programmatic/agent callers, but the OAuth callback and any future HTML
// surface benefit from clickjacking/MIME-sniffing protection; HSTS is only
// meaningful (and only emitted) over https, so wrangler dev on http is
// unaffected. Route-specific headers (e.g. the OAuth callback's CSP) are set
// on top of these by their handlers.
app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  if (new URL(c.req.url).protocol === "https:") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
});

app.get("/health", (c) => c.json({ ok: true, service: "companyos-gateway" }));

// The operator UI now authenticates with a session cookie (credentials:
// 'include'), so CORS must echo an explicit origin from ALLOWED_ORIGINS and
// allow credentials — a wildcard origin is illegal with credentialed requests.
// Programmatic/agent callers use `Authorization: Bearer` and are unaffected.
app.use(
  "/v1/*",
  cors({
    origin: (origin, c) => {
      const allowed = (c.env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s: string) => s.trim())
        .filter(Boolean);
      return allowed.includes(origin) ? origin : undefined;
    },
    credentials: true,
    allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-CSRF-Token"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

// Platform provisioning — internal/admin surface for onboarding whole
// companies (create tenant + first admin). Not tenant-scoped, so it lives
// outside /v1 and carries its own platform-admin-secret guard.
app.route("/admin", platform);

// Inbound webhook ingress (JIRA/GitHub/Bitbucket → Build). Deliveries carry
// no tenant credential, so this lives outside /v1 and authenticates each
// request with the source's derived signing secret (see src/webhooks/).
app.route("/webhooks", webhooks);

// Google OAuth callback. Google redirects the browser here with no bearer
// token, so this lives outside /v1 and self-authenticates on the single-use
// `state` nonce minted during the authenticated /connect call (see
// src/gateway/routes/google-oauth.ts).
app.route("/oauth/google", googleOAuth);

// Session login surface — public (no session required), mounted before the
// authenticate() guard so login/logout/me are reachable.
app.route("/v1/auth", auth);

// Everything else under /v1 requires either a session cookie (humans) or a
// tenant API key (agents/programmatic). authenticate() resolves both.
app.use("/v1/*", authenticate());
app.route("/v1/users", users);
app.route("/v1/meta", meta);
app.route("/v1/insights", insights);
app.route("/v1/invoices", invoices);
app.route("/v1/customers", customers);
app.route("/v1/ledger", ledger);
app.route("/v1/payments", payments);
app.route("/v1/deals", deals);
app.route("/v1/leads", leads);
app.route("/v1/activities", activities);
app.route("/v1/tickets", tickets);
app.route("/v1/projects", projects);
app.route("/v1/issues", issues);
app.route("/v1/events", events);
app.route("/v1/quotes", quotes);
app.route("/v1/settings", settings);
app.route("/v1/people", people);
app.route("/v1/webhook-sources", webhookSources);
app.route("/v1/google-accounts", googleAccounts);

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  console.error(`[gateway] unhandled error: ${err.stack ?? err.message}`);
  return c.json({ error: "internal error" }, 500);
});

// ensureEventBus() lets the Worker run without Cloudflare Queues (free plan):
// when the EVENTS binding is absent, events dispatch inline instead. See
// docs/queue-send.md.
// The frequent cron that drives Google inbound email sync. MUST match the
// entry in wrangler.jsonc / wrangler.free.jsonc `triggers.crons`.
const INBOX_SYNC_CRON = "*/5 * * * *";

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    app.fetch(request, ensureEventBus(env), ctx),
  queue: handleEventBatch,
  scheduled(controller, env, ctx) {
    const busEnv = ensureEventBus(env);
    if (controller.cron === INBOX_SYNC_CRON) {
      // Frequent: poll connected Gmail inboxes for newly received mail.
      ctx.waitUntil(runGoogleInboxSync(busEnv));
      return;
    }
    // Daily sweeps: mark overdue invoices and expire lapsed quotes.
    ctx.waitUntil(runOverdueSweep(busEnv));
    ctx.waitUntil(runQuoteExpirySweep(busEnv));
  },
} satisfies ExportedHandler<Env>;

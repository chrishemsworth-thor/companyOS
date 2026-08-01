import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { type AuthedEnv } from "./gateway/middleware/auth";
import { authenticate } from "./gateway/middleware/session";
import { guardModule } from "./gateway/middleware/capability";
import type { CapabilityModule } from "./auth/capabilities";
import { auth } from "./gateway/routes/auth";
import { me } from "./gateway/routes/me";
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
import { leave } from "./gateway/routes/leave";
import { leaveRequests } from "./gateway/routes/leave-requests";
import { files, publicFiles } from "./gateway/routes/files";
import { approvals } from "./gateway/routes/approvals";
import { notifications } from "./gateway/routes/notifications";
import { claims } from "./gateway/routes/claims";
import { claimCategories } from "./gateway/routes/claim-categories";
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

// Exported so `test/capabilities.test.ts` can walk `app.routes` and prove every
// registered /v1 path is covered by the capability mount table below.
export const app = new Hono<AuthedEnv>();

// Baseline security response headers on every route. The API is JSON-only for
// programmatic/agent callers, but the OAuth callback and any future HTML
// surface benefit from clickjacking/MIME-sniffing protection; HSTS is only
// meaningful (and only emitted) over https, so wrangler dev on http is
// unaffected. Route-specific headers (e.g. the OAuth callback's CSP) are set
// on top of these by their handlers. These survive thrown errors too: Hono's
// compose converts an error into onError's response inside the chain, so
// next() resolves and this post-next() code still runs (pinned by the
// "response headers on every path" tests in test/gateway.test.ts).
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

// Public file reads. Carries no credential, so — like /webhooks and
// /oauth/google — it lives outside /v1 rather than punching a hole in the
// authenticate() guard. It serves only purposes whose policy marks them
// publicly readable (`quote_logo` alone in v1, for the public quote page);
// everything else 404s here. See src/modules/files/policy.ts.
app.route("/files", publicFiles);

// Session login surface — public (no session required), mounted before the
// authenticate() guard so login/logout/me are reachable.
app.route("/v1/auth", auth);

// Everything else under /v1 requires either a session cookie (humans) or a
// tenant API key (agents/programmatic). authenticate() resolves both.
app.use("/v1/*", authenticate());

/**
 * The capability mount table — every `/v1` router paired with the capability
 * module that gates it (PRD-008). Reads need `<module>:read`, writes
 * `<module>:write`, derived from the HTTP method by `guardModule()`; roles are
 * mapped to capabilities in `src/auth/capabilities.ts`.
 *
 * This is a table rather than a series of `app.route()` calls on purpose: a new
 * router cannot be exposed without naming its module, so "a route shipped with
 * no gate" is not a mistake that survives review. `test/capabilities.test.ts`
 * additionally asserts every registered `/v1` path resolves to a row here.
 *
 * Per-route overrides that raise the bar (admin-only actions inside a broader
 * router) live in the route files via `requireCapability()`.
 */
export const V1_MOUNTS: ReadonlyArray<readonly [string, CapabilityModule, Hono<AuthedEnv>]> = [
  ["/v1/me", "self", me],
  ["/v1/users", "admin", users],
  ["/v1/webhook-sources", "admin", webhookSources],
  ["/v1/google-accounts", "admin", googleAccounts],
  ["/v1/meta", "meta", meta],
  ["/v1/insights", "insights", insights],
  ["/v1/invoices", "finance", invoices],
  ["/v1/ledger", "finance", ledger],
  ["/v1/payments", "finance", payments],
  ["/v1/customers", "crm", customers],
  ["/v1/deals", "crm", deals],
  ["/v1/leads", "crm", leads],
  ["/v1/activities", "crm", activities],
  ["/v1/quotes", "crm", quotes],
  ["/v1/tickets", "support", tickets],
  ["/v1/projects", "build", projects],
  ["/v1/issues", "build", issues],
  ["/v1/events", "agents", events],
  ["/v1/settings", "settings", settings],
  ["/v1/people", "people", people],
  // Leave configuration and balances (PRD-006b). HR administration over the
  // whole directory, so it sits on `people` alongside the directory itself —
  // `finance`, `support` and the `employee` tier get a 403 here, exactly as
  // they do on /v1/people. An employee reads their OWN balance, holidays and
  // working-day counts through /v1/me/leave, on the `self` axis.
  //
  // A separate row rather than a sub-route of `people` so the mount table stays
  // the complete list of routers: both rows declare the same module, so the
  // `/v1/people/*` gate matching first changes nothing.
  ["/v1/people/leave", "people", leave],
  ["/v1/files", "files", files],
  // Approvals and notifications are on the `self` axis, not a business module.
  // Every role that can log in has an approvals queue and a notification feed,
  // and `self` is the only module every role holds read AND write on —
  // including `readonly` and the `employee` self-service tier, who are exactly
  // the people filing the leave requests and claims these surfaces carry.
  // Authorization is per-row inside the services ("is this row yours"), never
  // per-role, which is why gating them on any business module would be wrong.
  ["/v1/approvals", "self", approvals],
  ["/v1/notifications", "self", notifications],
  // Claims are on the same `self` axis and for the same reason: the `employee`
  // tier holds `self` and nothing else, and employees are exactly who files a
  // claim. Visibility is per row inside the service ("is this yours, are you its
  // approver, do you hold finance:read"), and the one genuinely financial act —
  // recording the reimbursement — carries `finance:write` on its own route.
  // `/v1/claim-categories` reads are the picklist a filer needs; its writes map a
  // category to a GL account and are likewise held to `finance:write`.
  ["/v1/claims", "self", claims],
  ["/v1/claim-categories", "self", claimCategories],
  // Leave (PRD-006c) is on the `self` axis for the same reason, and it is the
  // clearest case for it: the `employee` tier holds no business capability at
  // all, and filing leave is the thing that tier exists to do. Gating it on
  // `people` would mean an employee needed read access to the HR directory —
  // employment terms, salaries-adjacent notes, everyone's records — to book a
  // day off.
  //
  // Not mounted under `/v1/me` despite PRD-006's wording, because a leave
  // request must be readable by its approver, who is not "me"; `me.ts` holds
  // "you can only ever read your own record" as an invariant. Authorization is
  // per-row in src/gateway/routes/leave-requests.ts — the subject employee,
  // anyone holding an approval on that one row, a `people:read` holder, or an
  // admin.
  ["/v1/leave", "self", leaveRequests],
];

for (const [path, module, router] of V1_MOUNTS) app.route(path, guardModule(module, router));

// 404s and unhandled 500s still carry the CORS and security headers: cors()
// sets its headers on c.res before next() and Hono preserves them, and the
// baseline middleware above re-runs after compose converts the error. That
// matters because a credentialed response missing Access-Control-Allow-Origin
// is blocked by the browser, which would surface a real server error as an
// opaque "failed to fetch". Pinned by test/gateway.test.ts.
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

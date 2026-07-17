import { Hono } from "hono";
import type { AuthedEnv } from "../gateway/middleware/auth";
import { IdempotencyConflict, withIdempotency } from "../gateway/idempotency";
import { runWithActor, type Actor } from "../auth/actor-context";
import { deriveSourceSecret, verifySignature } from "./verify";
import { getActiveSource } from "./sources";
import { ingestNormalizedEvent } from "./ingest";
import { normalizeJira } from "./normalize/jira";
import { normalizeGithub } from "./normalize/github";
import { normalizeBitbucket } from "./normalize/bitbucket";
import { isWebhookProvider, type NormalizedWebhookEvent, type WebhookProvider } from "./types";

/**
 * Inbound webhook ingress: POST /webhooks/:provider/:source_id. Mounted
 * BEFORE the /v1/* authenticate() guard (like /admin) — deliveries carry no
 * tenant credential. Instead the source_id token resolves the tenant, and the
 * request is authenticated by the source's derived signing secret (HMAC body
 * signature for GitHub/Bitbucket, URL secret for JIRA — see verify.ts).
 * Fails closed with 503 when WEBHOOK_MASTER_SECRET is unset.
 */
export const webhooks = new Hono<AuthedEnv>();

function normalize(
  provider: WebhookProvider,
  header: (name: string) => string | undefined,
  payload: unknown,
): NormalizedWebhookEvent {
  switch (provider) {
    case "jira":
      return normalizeJira(payload);
    case "github":
      return normalizeGithub(header("X-GitHub-Event"), payload);
    case "bitbucket":
      return normalizeBitbucket(header("X-Event-Key"), payload);
  }
}

/** Provider redelivery id, when the provider supplies one (JIRA doesn't). */
function deliveryId(provider: WebhookProvider, header: (name: string) => string | undefined) {
  if (provider === "github") return header("X-GitHub-Delivery");
  if (provider === "bitbucket") return header("X-Request-UUID");
  return undefined;
}

webhooks.post("/:provider/:source_id", async (c) => {
  const providerParam = c.req.param("provider");
  if (!isWebhookProvider(providerParam)) return c.json({ error: "not found" }, 404);
  const provider = providerParam;

  const master = c.env.WEBHOOK_MASTER_SECRET;
  if (!master) return c.json({ error: "webhook ingestion is not configured" }, 503);

  // Unknown, disabled, and wrong-provider sources 404 uniformly — the
  // endpoint must not reveal which tokens exist.
  const sourceId = c.req.param("source_id");
  const source = await getActiveSource(c.env.DB, sourceId);
  if (!source || source.provider !== provider) return c.json({ error: "not found" }, 404);

  const rawBody = await c.req.text();
  const derivedSecret = await deriveSourceSecret(master, sourceId);
  const verified = await verifySignature(
    provider,
    { header: (name) => c.req.header(name), querySecret: c.req.query("secret") },
    rawBody,
    derivedSecret,
  );
  if (!verified) return c.json({ error: "invalid signature" }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const event = normalize(provider, (name) => c.req.header(name), payload);
  if (event.kind === "ping") return c.json({ status: "ok" });

  // Dedup redeliveries on the provider's delivery id where one exists; the
  // ingest path is itself an idempotent upsert, so JIRA (no id) is still safe.
  const actor: Actor = { type: "system", id: `webhook:${provider}` };
  try {
    const result = await withIdempotency(
      c.env.DB,
      source.tenant_id,
      `webhook.${provider}`,
      deliveryId(provider, (name) => c.req.header(name)),
      rawBody,
      async () => {
        const outcome = await runWithActor(actor, () =>
          ingestNormalizedEvent(c.env, source, event),
        );
        return { status: outcome.status === "processed" ? 200 : 202, body: outcome };
      },
    );
    return c.json(result.body, result.status);
  } catch (err) {
    if (err instanceof IdempotencyConflict) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus);
    }
    throw err;
  }
});

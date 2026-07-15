import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import type { Context, MiddlewareHandler, Next } from "hono";
import { timingSafeEqualHex } from "../../auth/password";
import { createTenant, listTenants, TenantError } from "../../auth/tenants";
import { createUser, UserError } from "../../auth/users";

/**
 * Platform provisioning API. Internal/admin surface for onboarding whole
 * companies — creating a tenant plus its first admin user. It is NOT
 * tenant-scoped (it operates across the platform), so it is mounted BEFORE the
 * /v1/* `authenticate()` guard and gated by its own platform-admin secret
 * rather than a tenant session or API key.
 */
export const platform = new Hono<AuthedEnv>();

/**
 * Gate every /admin route on the platform-admin bearer secret. Fails closed:
 * if PLATFORM_ADMIN_SECRET is unset the API is unusable (503), so a
 * misconfigured deploy can't silently expose company creation.
 */
function requirePlatformAdmin(): MiddlewareHandler<AuthedEnv> {
  return async (c: Context<AuthedEnv>, next: Next) => {
    const secret = c.env.PLATFORM_ADMIN_SECRET;
    if (!secret) {
      return c.json({ error: "platform provisioning is not configured" }, 503);
    }
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    if (!token || !timingSafeEqualHex(hexEncode(token), hexEncode(secret))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}

// Encode arbitrary strings to hex so the constant-time comparison (which
// expects hex) stays length-safe — same trick as session-cookie verification.
function hexEncode(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, "0");
  return out;
}

platform.use("*", requirePlatformAdmin());

const createTenantSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(64),
  admin_email: z.string().email(),
  admin_password: z.string().min(8).max(512),
  admin_display_name: z.string().max(200).optional(),
});

/**
 * Provision a new company: create the tenant (with a fresh API key) and its
 * first admin user, atomically enough that a failure to create the admin rolls
 * the tenant back. Returns the plaintext API key and the admin — both shown
 * exactly once here.
 */
platform.post("/tenants", zValidator("json", createTenantSchema), async (c) => {
  const body = c.req.valid("json");
  try {
    const { tenant, api_key } = await createTenant(c.env.DB, {
      name: body.name,
      slug: body.slug,
    });
    try {
      const admin = await createUser(c.env.DB, {
        tenant_id: tenant.tenant_id,
        email: body.admin_email,
        password: body.admin_password,
        display_name: body.admin_display_name,
        role: "admin",
      });
      return c.json({ tenant, api_key, admin }, 201);
    } catch (err) {
      // Roll back the tenant so a failed admin creation doesn't leave an
      // orphaned, unloginable company behind.
      await c.env.DB.prepare("DELETE FROM tenants WHERE tenant_id = ?")
        .bind(tenant.tenant_id)
        .run();
      throw err;
    }
  } catch (err) {
    if (err instanceof TenantError) return c.json({ error: err.message, code: err.code }, err.httpStatus);
    if (err instanceof UserError) return c.json({ error: err.message, code: err.code }, err.httpStatus);
    throw err;
  }
});

/** List all companies on the platform (operational visibility). */
platform.get("/tenants", async (c) => {
  const tenants = await listTenants(c.env.DB);
  return c.json({ tenants });
});

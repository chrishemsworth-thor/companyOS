import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { requireRole } from "../middleware/session";
import {
  createUser,
  getUserAuthState,
  getUserById,
  listUsers,
  ROLES,
  updateUser,
  UserError,
} from "../../auth/users";
import { INVITE_TTL_SECONDS, issueUserToken } from "../../auth/tokens";
import { DeliveryError, sendEmail } from "../../delivery/dispatch";
import { userInviteEmail } from "../../delivery/templates/user-emails";
import { acceptInvitePath, consoleBaseUrl } from "../../delivery/templates/links";

/**
 * User management. Admin-only for human callers; a tenant-API-key (system)
 * caller bypasses the role gate — that is the bootstrap path for creating the
 * first admin user when a tenant has none yet.
 *
 * New users are created WITHOUT a password: they receive a single-use invite
 * link (emailed, and returned to the admin as invite_url for tenants with no
 * email transport) and set their own credential via /v1/auth/invite/accept.
 */
export const users = new Hono<AuthedEnv>();

users.use("*", requireRole("admin"));

const roleSchema = z.enum(ROLES);

const createSchema = z.object({
  email: z.string().email(),
  display_name: z.string().min(1).max(200).optional(),
  role: roleSchema.optional(),
});

const patchSchema = z
  .object({
    display_name: z.string().min(1).max(200),
    role: roleSchema,
    status: z.enum(["active", "disabled"]),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: "empty patch" });

function userErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof UserError) return c.json({ error: err.message, code: err.code }, err.httpStatus);
  throw err;
}

interface InviteResult {
  emailed: boolean;
  provider: string | null;
  expires_at: string;
  /** Single-use accept link — lets the admin hand it over out-of-band when the
   * tenant has no real email transport (console provider / send failure). */
  invite_url: string;
}

/** Issue a fresh invite token and try to email it. Send failure never throws:
 * the user exists either way, and the admin still gets the copyable link. */
async function issueAndSendInvite(
  c: Context<AuthedEnv>,
  input: { user_id: string; email: string },
): Promise<InviteResult> {
  const tenant = c.get("tenant");
  const actor = c.get("user");
  const { raw, expires_at } = await issueUserToken(c.env.DB, {
    tenant_id: tenant.tenant_id,
    user_id: input.user_id,
    purpose: "invite",
    ttlSeconds: INVITE_TTL_SECONDS,
    created_by: actor?.type === "user" ? actor.id : undefined,
  });
  const invite_url = consoleBaseUrl(c.env) + acceptInvitePath(raw);

  const inviter =
    actor?.type === "user" && actor.id
      ? (await getUserById(c.env.DB, tenant.tenant_id, actor.id))?.display_name ?? undefined
      : undefined;
  const tenantRow = await c.env.DB.prepare("SELECT name FROM tenants WHERE tenant_id = ?")
    .bind(tenant.tenant_id)
    .first<{ name: string }>();
  const rendered = userInviteEmail({
    tenantName: tenantRow?.name ?? "your workspace",
    inviterName: inviter,
    acceptUrl: invite_url,
    expiresDays: INVITE_TTL_SECONDS / 86_400,
  });

  try {
    const { provider } = await sendEmail(c.env, tenant.tenant_id, {
      to: input.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      purpose: "user_invite",
      refs: { user_id: input.user_id },
    });
    // The console provider "sends" by logging — surface that to the admin as
    // not-emailed so the UI offers the copyable link instead.
    return { emailed: provider !== "console", provider, expires_at, invite_url };
  } catch (err) {
    if (!(err instanceof DeliveryError)) throw err;
    return { emailed: false, provider: null, expires_at, invite_url };
  }
}

users.get("/", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ users: await listUsers(c.env.DB, tenant.tenant_id) });
});

users.post("/", zValidator("json", createSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const user = await createUser(c.env.DB, { tenant_id: tenant.tenant_id, ...c.req.valid("json") });
    const invite = await issueAndSendInvite(c, { user_id: user.user_id, email: user.email });
    return c.json({ user, invite }, 201);
  } catch (err) {
    return userErrorResponse(c, err);
  }
});

users.post("/:id/resend-invite", async (c) => {
  const tenant = c.get("tenant");
  const state = await getUserAuthState(c.env.DB, tenant.tenant_id, { user_id: c.req.param("id") });
  if (!state) return c.json({ error: "user not found", code: "not_found" }, 404);
  if (state.has_password || state.status === "disabled") {
    return c.json(
      { error: "user is not pending an invite", code: "not_invitable" },
      409,
    );
  }
  const invite = await issueAndSendInvite(c, { user_id: state.user_id, email: state.email });
  return c.json({ invite });
});

users.patch("/:id", zValidator("json", patchSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const user = await updateUser(c.env.DB, tenant.tenant_id, c.req.param("id"), c.req.valid("json"));
    return c.json(user);
  } catch (err) {
    return userErrorResponse(c, err);
  }
});

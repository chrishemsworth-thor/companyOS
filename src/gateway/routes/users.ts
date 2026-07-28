import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { requireRole } from "../middleware/session";
import {
  createUser,
  getUserAuthState,
  listUsers,
  ROLES,
  updateUser,
  UserError,
} from "../../auth/users";
import { issueAndSendInvite, type InviteResult } from "../../auth/invites";

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

/** The acting human's user id, for invite attribution (undefined for system). */
function inviterId(c: Context<AuthedEnv>): string | undefined {
  const actor = c.get("user");
  return actor?.type === "user" ? actor.id : undefined;
}

function sendInvite(
  c: Context<AuthedEnv>,
  user: { user_id: string; email: string },
): Promise<InviteResult> {
  return issueAndSendInvite(c.env, c.get("tenant").tenant_id, {
    user_id: user.user_id,
    email: user.email,
    inviter_user_id: inviterId(c),
  });
}

users.get("/", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ users: await listUsers(c.env.DB, tenant.tenant_id) });
});

users.post("/", zValidator("json", createSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const user = await createUser(c.env.DB, { tenant_id: tenant.tenant_id, ...c.req.valid("json") });
    const invite = await sendInvite(c, { user_id: user.user_id, email: user.email });
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
  const invite = await sendInvite(c, { user_id: state.user_id, email: state.email });
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

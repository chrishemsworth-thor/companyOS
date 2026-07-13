import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { requireRole } from "../middleware/session";
import { createUser, listUsers, ROLES, updateUser, UserError } from "../../auth/users";

/**
 * User management. Admin-only for human callers; a tenant-API-key (system)
 * caller bypasses the role gate — that is the bootstrap path for creating the
 * first admin user when a tenant has none yet.
 */
export const users = new Hono<AuthedEnv>();

users.use("*", requireRole("admin"));

const roleSchema = z.enum(ROLES);

const createSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(512),
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

users.get("/", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ users: await listUsers(c.env.DB, tenant.tenant_id) });
});

users.post("/", zValidator("json", createSchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const user = await createUser(c.env.DB, { tenant_id: tenant.tenant_id, ...c.req.valid("json") });
    return c.json(user, 201);
  } catch (err) {
    return userErrorResponse(c, err);
  }
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

import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { pageQuerySchema } from "../pagination";
import {
  addMessage,
  changeTicketStatus,
  createTicket,
  getTicket,
  listMessages,
  listTickets,
  SupportError,
} from "../../modules/support/service";

const createBodySchema = z.object({
  customer_id: z.string().min(1),
  subject: z.string().min(1).max(300),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  body: z.string().max(10_000).optional(),
});

const messageBodySchema = z.object({
  author: z.enum(["customer", "agent", "system"]),
  body: z.string().min(1).max(10_000),
});

const statusBodySchema = z.object({
  status: z.enum(["open", "pending", "resolved", "closed"]),
});

const listQuerySchema = pageQuerySchema.extend({
  status: z.enum(["open", "pending", "resolved", "closed"]).optional(),
});

function supportErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof SupportError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

export const tickets = new Hono<AuthedEnv>();

tickets.get("/", zValidator("query", listQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  const { status, cursor, limit } = c.req.valid("query");
  return c.json(await listTickets(c.env.DB, tenant.tenant_id, { status, cursor, limit }));
});

tickets.post("/", zValidator("json", createBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const ticket = await createTicket(c.env, tenant.tenant_id, c.req.valid("json"));
  return c.json(ticket, 201);
});

tickets.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const ticket = await getTicket(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!ticket) return c.json({ error: "ticket not found" }, 404);
  const messages = await listMessages(c.env.DB, tenant.tenant_id, c.req.param("id"));
  return c.json({ ...ticket, messages });
});

tickets.post("/:id/messages", zValidator("json", messageBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const message = await addMessage(c.env, tenant.tenant_id, c.req.param("id"), c.req.valid("json"));
    return c.json(message, 201);
  } catch (err) {
    return supportErrorResponse(c, err);
  }
});

/** State-machine transition; illegal moves → 409. */
tickets.post("/:id/status", zValidator("json", statusBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const ticket = await changeTicketStatus(
      c.env,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json").status,
    );
    return c.json(ticket);
  } catch (err) {
    return supportErrorResponse(c, err);
  }
});

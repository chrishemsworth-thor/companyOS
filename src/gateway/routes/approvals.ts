import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import { paginate, pageQuerySchema } from "../pagination";
import {
  ApprovalsError,
  cancel,
  decide,
  getApproval,
  listApprovals,
} from "../../modules/approvals/service";
import { approvalStateSchema, subjectTypeSchema } from "../../modules/approvals/types";

/**
 * Approvals HTTP surface (PRD-000b).
 *
 * Deliberately thin. The primitive's real API is the service — modules call
 * `requestApproval()` directly and there is no `POST /v1/approvals`, because a
 * request for a decision always originates from a subject (a claim, a leave
 * request) and letting a client conjure one would create approvals pointing at
 * subjects that do not exist.
 *
 * What is here is what a *human* needs: see my queue, decide, withdraw my own
 * request. Authorization is per-row inside the service rather than a
 * router-level `requireRole`, because every authenticated user legitimately has
 * an approvals queue — the question is never "what role are you" but "is this
 * row yours".
 */

export const approvals = new Hono<AuthedEnv>();

function approvalsErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof ApprovalsError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

const listQuerySchema = pageQuerySchema.extend({
  state: approvalStateSchema.optional(),
  subject_type: subjectTypeSchema.optional(),
  subject_id: z.string().optional(),
  /** `?mine=true` — approvals awaiting the calling user's decision. */
  mine: z.enum(["true", "false"]).optional(),
  /** `?requester=me` — approvals the calling user raised (PRD-007's My requests). */
  requester: z.literal("me").optional(),
});

const decisionBodySchema = z.object({
  /**
   * Optional, per PRD-000. PRD-007's console requires a comment on reject and
   * enforces that client-side; the primitive stays permissive so a
   * programmatic caller is not blocked by a UI rule.
   */
  comment: z.string().max(2000).optional(),
});

/**
 * The calling user's id, or null for a programmatic (tenant-API-key) caller.
 * API keys authenticate a tenant, not a person, so they have no approvals queue
 * and cannot record a decision — there would be nobody to write into
 * `decided_by`, and an audit trail naming "the tenant" is not an audit trail.
 */
function callerUserId(c: Context<AuthedEnv>): string | null {
  const actor = c.get("user");
  return actor?.type === "user" && actor.id ? actor.id : null;
}

function requireUser(c: Context<AuthedEnv>, action: string): string | Response {
  const userId = callerUserId(c);
  if (!userId) {
    return c.json(
      {
        error: `${action} requires an authenticated user session; a tenant API key has no user identity`,
        code: "invalid_request",
      },
      400,
    );
  }
  return userId;
}

/**
 * `GET /v1/approvals?state=pending&mine=true`
 *
 * Oldest first — the thing that has waited longest is the thing most likely to
 * be blocking somebody. `approval_id` is a ULID so that ordering is
 * chronological and cursor pagination works on it directly.
 */
approvals.get("/", async (c) => {
  const parsed = listQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "invalid_request" }, 400);
  }
  const query = parsed.data;
  const tenant = c.get("tenant");

  const filter: Parameters<typeof listApprovals>[2] = {
    limit: query.limit,
    cursor: query.cursor,
    state: query.state,
    subject_type: query.subject_type,
    subject_id: query.subject_id,
  };

  if (query.mine === "true") {
    const userId = requireUser(c, "?mine=true");
    if (typeof userId !== "string") return userId;
    filter.approver_user_id = userId;
  }
  if (query.requester === "me") {
    const userId = requireUser(c, "?requester=me");
    if (typeof userId !== "string") return userId;
    filter.requested_by = userId;
  }

  const rows = await listApprovals(c.env.DB, tenant.tenant_id, filter);
  return c.json(paginate(rows, query.limit, "approval_id"));
});

/** `GET /v1/approvals/:id` — one approval. Another tenant's id is a 404. */
approvals.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const approval = await getApproval(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!approval) return c.json({ error: "approval not found" }, 404);
  return c.json(approval);
});

/** Shared body of the two decision routes. */
async function recordDecision(
  c: Context<AuthedEnv>,
  approvalId: string,
  decision: "approved" | "rejected",
) {
  const userId = requireUser(c, "recording a decision");
  if (typeof userId !== "string") return userId;

  let body: unknown = {};
  try {
    const raw = await c.req.text();
    if (raw) body = JSON.parse(raw);
  } catch {
    return c.json({ error: "invalid JSON body", code: "invalid_request" }, 400);
  }
  const parsed = decisionBodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.message, code: "invalid_request" }, 400);
  }

  const tenant = c.get("tenant");
  try {
    const approval = await decide(c.env, tenant.tenant_id, approvalId, {
      actor_user_id: userId,
      actor_role: c.get("user")?.role,
      decision,
      comment: parsed.data.comment ?? null,
    });
    return c.json(approval);
  } catch (err) {
    return approvalsErrorResponse(c, err);
  }
}

/** `POST /v1/approvals/:id/approve` — terminal. Re-deciding is a 409. */
approvals.post("/:id/approve", (c) => recordDecision(c, c.req.param("id"), "approved"));

/** `POST /v1/approvals/:id/reject` — terminal. Comment optional here (see above). */
approvals.post("/:id/reject", (c) => recordDecision(c, c.req.param("id"), "rejected"));

/**
 * `POST /v1/approvals/:id/cancel` — withdraw a request you raised.
 *
 * Beyond PRD-000's three routes, and deliberately so: PRD-007's "My requests"
 * tab lets a requester cancel their own pending request, and the generic inbox
 * cannot know which subject module owns a given row. Without this, the console
 * would have to reach into a module it does not own to withdraw a request.
 *
 * Restricted to the requester (or an admin). Cancelling is not a decision, so
 * an *approver* cannot use this to duck a request they simply do not want to
 * answer — they must approve or reject it.
 */
approvals.post("/:id/cancel", async (c) => {
  const userId = requireUser(c, "cancelling a request");
  if (typeof userId !== "string") return userId;

  const tenant = c.get("tenant");
  const approval = await getApproval(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!approval) return c.json({ error: "approval not found" }, 404);

  const isAdmin = c.get("user")?.role === "admin";
  if (approval.requested_by !== userId && !isAdmin) {
    return c.json(
      { error: "only the requester or an admin may cancel this request", code: "forbidden" },
      403,
    );
  }

  try {
    return c.json(await cancel(c.env, tenant.tenant_id, c.req.param("id")));
  } catch (err) {
    return approvalsErrorResponse(c, err);
  }
});

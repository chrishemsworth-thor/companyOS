import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AuthedEnv } from "../middleware/auth";
import {
  BuildError,
  changeIssueStatus,
  createIssue,
  createProject,
  getIssue,
  getProject,
  listIssues,
  listProjects,
} from "../../modules/build/service";

const projectBodySchema = z.object({ name: z.string().min(1).max(200) });

const issueBodySchema = z.object({
  project_id: z.string().startsWith("prj_"),
  title: z.string().min(1).max(300),
  description: z.string().max(10_000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  assignee: z.string().max(200).optional(),
});

const issueStatusBodySchema = z.object({
  status: z.enum(["todo", "in_progress", "done", "cancelled"]),
});

const issueListQuerySchema = z.object({
  project_id: z.string().optional(),
  status: z.enum(["todo", "in_progress", "done", "cancelled"]).optional(),
});

function buildErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof BuildError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

export const projects = new Hono<AuthedEnv>();

projects.get("/", async (c) => {
  const tenant = c.get("tenant");
  return c.json({ projects: await listProjects(c.env.DB, tenant.tenant_id) });
});

projects.post("/", zValidator("json", projectBodySchema), async (c) => {
  const tenant = c.get("tenant");
  const project = await createProject(c.env, tenant.tenant_id, c.req.valid("json"));
  return c.json(project, 201);
});

projects.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const project = await getProject(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  return c.json(project);
});

export const issues = new Hono<AuthedEnv>();

issues.get("/", zValidator("query", issueListQuerySchema), async (c) => {
  const tenant = c.get("tenant");
  return c.json({ issues: await listIssues(c.env.DB, tenant.tenant_id, c.req.valid("query")) });
});

issues.post("/", zValidator("json", issueBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const issue = await createIssue(c.env, tenant.tenant_id, c.req.valid("json"));
    return c.json(issue, 201);
  } catch (err) {
    return buildErrorResponse(c, err);
  }
});

issues.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const issue = await getIssue(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!issue) return c.json({ error: "issue not found" }, 404);
  return c.json(issue);
});

issues.post("/:id/status", zValidator("json", issueStatusBodySchema), async (c) => {
  const tenant = c.get("tenant");
  try {
    const issue = await changeIssueStatus(
      c.env,
      tenant.tenant_id,
      c.req.param("id"),
      c.req.valid("json").status,
    );
    return c.json(issue);
  } catch (err) {
    return buildErrorResponse(c, err);
  }
});

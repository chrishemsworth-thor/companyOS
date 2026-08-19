import { Hono, type Context } from "hono";
import type { Env } from "../../env";
import type { AuthedEnv } from "../middleware/auth";
import {
  deleteFile,
  FilesError,
  getFile,
  getPublicFile,
  MAX_UPLOAD_BYTES_ANY_PURPOSE,
  MULTIPART_OVERHEAD_ALLOWANCE_BYTES,
  readFileBody,
  tooLargeMessage,
  uploadFile,
} from "../../modules/files/service";
import type { FileRecord } from "../../modules/files/types";

/**
 * File primitive routes (PRD-000a).
 *
 * Two surfaces, deliberately separated:
 *
 *  - `files` at `/v1/files` — tenant-scoped. Upload, read, delete. A read for
 *    another tenant's file id returns 404, never 403: a 403 confirms the id
 *    exists, which is exactly what the isolation rule is there to prevent.
 *  - `publicFiles` at `/files` — no credential at all, mounted outside `/v1`
 *    next to /webhooks and /oauth/google (the codebase's convention for
 *    credential-less callers). It serves only purposes whose policy marks them
 *    publicly readable — `quote_logo` alone in v1 — so PRD-004's public quote
 *    page can render a tenant's logo. Public readability is a property of the
 *    purpose, never of the caller.
 *
 * Note on content types: the allowlist is applied to the *declared* type, as
 * PRD-000 specifies. Combined with `X-Content-Type-Options: nosniff` on every
 * response and `Content-Disposition: inline` on a fixed type, a mislabelled
 * upload cannot be talked into executing in a browser. Magic-byte sniffing is
 * not in scope for v1.
 */

export const files = new Hono<AuthedEnv>();
export const publicFiles = new Hono<{ Bindings: Env }>();

function filesErrorResponse(c: Context<AuthedEnv>, err: unknown) {
  if (err instanceof FilesError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  throw err;
}

/**
 * A `Content-Disposition` value that survives a hostile filename. The quoted
 * form is stripped to safe ASCII; the RFC 5987 `filename*` carries the real
 * name for clients that understand it.
 */
function contentDisposition(filename: string, contentType: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  // HTML is never served inline from the generic file routes. The only HTML in
  // the bucket is an archived quote artifact (purpose `quote_artifact`, S9),
  // which is not publicly readable and has two purpose-built routes of its own
  // that render it deliberately with a restrictive CSP. Serving it inline HERE
  // would put stored markup on the API origin for any authenticated caller
  // holding an id — a cheap way to turn a file store into a stored-XSS surface,
  // for a convenience nobody needs.
  const mode = contentType.split(";")[0]!.trim().toLowerCase() === "text/html"
    ? "attachment"
    : "inline";
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * Stream a stored object with its metadata headers, or 404 if the bytes are gone.
 *
 * Exported because two routers legitimately serve the same bytes under different
 * authorization: this one on `files:read`, and `/v1/claims/:id/lines/:n/receipt`
 * on "may you see this claim" (the `employee` tier holds no files capability at
 * all — see the note in routes/claims.ts). Sharing the function keeps the
 * response headers, the ETag and the hostile-filename handling identical on both.
 */
export async function streamFile(
  env: Env,
  row: FileRecord,
  cacheControl: string,
): Promise<Response> {
  const object = await readFileBody(env, row);
  if (!object) {
    // Row says it exists, bucket disagrees. Same answer as a missing row —
    // there is nothing to serve either way.
    return Response.json({ error: "file not found" }, { status: 404 });
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": row.content_type,
      "Content-Length": String(row.size_bytes),
      "Content-Disposition": contentDisposition(row.filename, row.content_type),
      ETag: `"${row.sha256}"`,
      "Cache-Control": cacheControl,
    },
  });
}

/**
 * `POST /v1/files` — multipart upload.
 *
 * Parts: `file` (required, the binary), `purpose` (required), `filename`
 * (optional override of the part's own name).
 */
files.post("/", async (c) => {
  // Pre-flight on the declared length so an absurdly large body is refused
  // before it is buffered. The exact per-purpose ceiling is enforced on the
  // real byte count in the service — `purpose` is a form field, so it is not
  // known until the body has been parsed.
  const declared = Number(c.req.header("Content-Length") ?? "");
  if (
    Number.isFinite(declared) &&
    declared > MAX_UPLOAD_BYTES_ANY_PURPOSE + MULTIPART_OVERHEAD_ALLOWANCE_BYTES
  ) {
    return c.json(
      { error: tooLargeMessage(MAX_UPLOAD_BYTES_ANY_PURPOSE), code: "too_large" },
      413,
    );
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json(
      { error: "expected a multipart/form-data body with a 'file' part", code: "invalid_request" },
      400,
    );
  }

  const part = form.get("file");
  if (!part || typeof part === "string") {
    return c.json({ error: "missing 'file' part", code: "invalid_request" }, 400);
  }
  const purpose = form.get("purpose");
  if (typeof purpose !== "string" || purpose === "") {
    return c.json({ error: "missing 'purpose' field", code: "invalid_request" }, 400);
  }
  const contentType = part.type;
  if (!contentType) {
    return c.json(
      { error: "the 'file' part must declare a Content-Type", code: "invalid_request" },
      400,
    );
  }

  const filenameOverride = form.get("filename");
  const filename =
    typeof filenameOverride === "string" && filenameOverride !== ""
      ? filenameOverride
      : ((part as File).name ?? "upload");

  const actor = c.get("user");
  const tenant = c.get("tenant");
  try {
    const metadata = await uploadFile(c.env, tenant.tenant_id, {
      bytes: await part.arrayBuffer(),
      filename: filename.slice(0, 300),
      contentType,
      purpose,
      uploadedBy: actor?.type === "user" ? (actor.id ?? null) : null,
    });
    return c.json(metadata, 201);
  } catch (err) {
    return filesErrorResponse(c, err);
  }
});

/**
 * `GET /v1/files/:id` — stream a file the caller's tenant owns.
 *
 * The row is resolved with `tenant_id` in the WHERE clause, so another
 * tenant's id simply does not resolve. 404, not 403.
 */
files.get("/:id", async (c) => {
  const tenant = c.get("tenant");
  const row = await getFile(c.env.DB, tenant.tenant_id, c.req.param("id"));
  if (!row) return c.json({ error: "file not found" }, 404);
  return streamFile(c.env, row, "private, max-age=300");
});

/** `DELETE /v1/files/:id` — soft-delete the row, hard-delete the object. */
files.delete("/:id", async (c) => {
  const tenant = c.get("tenant");
  try {
    await deleteFile(c.env, tenant.tenant_id, c.req.param("id"));
    return c.body(null, 204);
  } catch (err) {
    return filesErrorResponse(c, err);
  }
});

/**
 * `GET /files/:id` — unauthenticated read, publicly readable purposes only.
 *
 * Every other purpose 404s here regardless of who asks, so this route cannot
 * be used to probe for private files. Uploads are immutable, so the bytes
 * behind an id never change and can be cached indefinitely.
 */
publicFiles.get("/:id", async (c) => {
  const row = await getPublicFile(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "file not found" }, 404);
  return streamFile(c.env, row, "public, max-age=31536000, immutable");
});

import type { Env } from "../../env";
import { ulid } from "../../lib/ulid";
import { FILE_POLICIES, isFilePurpose, isPubliclyReadable, policyFor } from "./policy";
import type { FileMetadata, FileRecord, UploadInput } from "./types";

/**
 * File storage primitive (PRD-000a).
 *
 * Bytes go to R2 under `{tenant_id}/{uuid}`; the `files` row in D1 is the
 * authority on who owns them. Every read resolves the row first and compares
 * its `tenant_id` to the caller — the key is never trusted on its own.
 *
 * Uploads are immutable. There is no update path and no versioning: replacing
 * a file means uploading a new one and pointing at the new id.
 */

/** Mirrors SupportError: a code, a message, and the status the route returns. */
export class FilesError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_request" | "too_large" | "unsupported_type",
    message: string,
    readonly httpStatus: 400 | 404 | 413 | 415,
  ) {
    super(message);
    this.name = "FilesError";
  }
}

const FILE_COLUMNS =
  "file_id, tenant_id, r2_key, filename, content_type, size_bytes, sha256, purpose, uploaded_by, created_at, deleted_at";

/**
 * The largest `maxBytes` any purpose allows. The route uses it as a cheap
 * pre-flight check on `Content-Length` so a wildly oversized body is rejected
 * before it is buffered — the exact, per-purpose limit is enforced on the real
 * byte length once the part is parsed, because `purpose` is itself a form
 * field and is not known until then.
 */
export const MAX_UPLOAD_BYTES_ANY_PURPOSE = Math.max(
  ...Object.values(FILE_POLICIES).map((p) => p.maxBytes),
);

/**
 * Slack for multipart framing (boundaries, part headers) in the pre-flight
 * check, so a file just under the ceiling is not rejected for its envelope.
 */
export const MULTIPART_OVERHEAD_ALLOWANCE_BYTES = 64 * 1024;

function toMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;
}

/** The 413 message. Named limits, so the caller knows what to do about it. */
export function tooLargeMessage(limitBytes: number, actualBytes?: number, purpose?: string): string {
  const scope = purpose ? `purpose '${purpose}'` : "an upload";
  const actual = actualBytes === undefined ? "" : ` (received ${toMegabytes(actualBytes)})`;
  return `file too large: ${scope} allows at most ${toMegabytes(limitBytes)}${actual}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toMetadata(row: FileRecord): FileMetadata {
  return {
    file_id: row.file_id,
    filename: row.filename,
    content_type: row.content_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    purpose: row.purpose as FileMetadata["purpose"],
    uploaded_by: row.uploaded_by,
    created_at: row.created_at,
  };
}

/**
 * Validate against the purpose's policy, store the bytes, then record them.
 *
 * Order matters: the object is written before the row so a failed insert
 * leaves nothing to point at. If the insert does fail the object is removed
 * again, so a D1 error cannot orphan bytes in the bucket.
 */
export async function uploadFile(
  env: Env,
  tenantId: string,
  input: UploadInput,
): Promise<FileMetadata> {
  if (!isFilePurpose(input.purpose)) {
    throw new FilesError(
      "invalid_request",
      `unknown purpose '${input.purpose}': expected one of ${Object.keys(FILE_POLICIES).join(", ")}`,
      400,
    );
  }
  const policy = policyFor(input.purpose);

  // Normalise away any `; charset=...` parameter before matching the allowlist.
  const contentType = input.contentType.split(";")[0]!.trim().toLowerCase();
  if (!policy.contentTypes.includes(contentType)) {
    throw new FilesError(
      "unsupported_type",
      `unsupported content type '${contentType}' for purpose '${input.purpose}': allowed types are ${policy.contentTypes.join(", ")}`,
      415,
    );
  }

  // The real length, not the declared one — a lying Content-Length header
  // cannot buy extra bytes.
  const size = input.bytes.byteLength;
  if (size > policy.maxBytes) {
    throw new FilesError("too_large", tooLargeMessage(policy.maxBytes, size, input.purpose), 413);
  }
  if (size === 0) {
    throw new FilesError("invalid_request", "file is empty", 400);
  }

  const fileId = `file_${ulid()}`;
  const key = `${tenantId}/${crypto.randomUUID()}`;
  const digest = await sha256Hex(input.bytes);

  await env.FILES.put(key, input.bytes, {
    httpMetadata: { contentType },
    // Enough to attribute a stray object back to its row without a D1 lookup.
    customMetadata: { tenant_id: tenantId, file_id: fileId, purpose: input.purpose },
  });

  try {
    await env.DB.prepare(
      `INSERT INTO files (file_id, tenant_id, r2_key, filename, content_type, size_bytes, sha256, purpose, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        fileId,
        tenantId,
        key,
        input.filename,
        contentType,
        size,
        digest,
        input.purpose,
        input.uploadedBy,
      )
      .run();
  } catch (err) {
    // No row means no reference: drop the bytes rather than leak them.
    await env.FILES.delete(key);
    throw err;
  }

  const row = await getFile(env.DB, tenantId, fileId);
  if (!row) throw new FilesError("not_found", "file not found after upload", 404);
  return toMetadata(row);
}

/**
 * Resolve a file within a tenant. Scoped by `tenant_id` in the WHERE clause,
 * so a caller asking for another tenant's id gets null and the route turns
 * that into a 404 — never a 403, which would confirm the id exists.
 */
export async function getFile(
  db: D1Database,
  tenantId: string,
  fileId: string,
): Promise<FileRecord | null> {
  return db
    .prepare(
      `SELECT ${FILE_COLUMNS} FROM files
       WHERE tenant_id = ? AND file_id = ? AND deleted_at IS NULL`,
    )
    .bind(tenantId, fileId)
    .first<FileRecord>();
}

/**
 * Resolve a file for the credential-less public route. Looked up by id alone
 * — there is no caller to scope to — and then gated on the purpose's
 * `publiclyReadable` flag. Anything not publicly readable resolves to null and
 * 404s, so this route cannot be used to probe for private files.
 */
export async function getPublicFile(db: D1Database, fileId: string): Promise<FileRecord | null> {
  const row = await db
    .prepare(
      `SELECT ${FILE_COLUMNS} FROM files WHERE file_id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(fileId)
    .first<FileRecord>();
  if (!row) return null;
  return isPubliclyReadable(row.purpose) ? row : null;
}

/** The stored bytes, or null when the object is missing from the bucket. */
export async function readFileBody(env: Env, row: FileRecord): Promise<R2ObjectBody | null> {
  return env.FILES.get(row.r2_key);
}

/**
 * Soft-delete the row and hard-delete the object. The record of the upload
 * survives for audit; the bytes do not. Deleting an already-deleted (or
 * another tenant's) file is a 404.
 */
export async function deleteFile(env: Env, tenantId: string, fileId: string): Promise<void> {
  const row = await getFile(env.DB, tenantId, fileId);
  if (!row) throw new FilesError("not_found", "file not found", 404);

  await env.DB.prepare(
    `UPDATE files SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE tenant_id = ? AND file_id = ? AND deleted_at IS NULL`,
  )
    .bind(tenantId, fileId)
    .run();

  await env.FILES.delete(row.r2_key);
}

export { toMetadata };

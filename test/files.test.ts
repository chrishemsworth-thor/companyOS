import { describe, it, expect, beforeAll } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { sha256Hex } from "../src/gateway/middleware/auth";

/**
 * PRD-000a — the file storage primitive.
 *
 * Every acceptance criterion in PRD-000 § "P0 — File storage" and in the S2
 * brief has a test here, plus the per-purpose policy that SESSION-PLAN
 * conflict C3 adds on top of them.
 *
 * Isolated storage note: D1 *and* R2 writes made inside an `it` are rolled
 * back before the next one, so every test uploads whatever it needs. Only the
 * tenant rows are seeded in `beforeAll`, which does persist for the file.
 */

const API_KEY = "test_api_key_files";
const TENANT_ID = "biz_files";
const OTHER_API_KEY = "test_api_key_files_other";
const OTHER_TENANT_ID = "biz_files_other";

// No Content-Type header on these: fetch sets multipart/form-data with the
// boundary itself, and overriding it breaks the parse.
const auth = { Authorization: `Bearer ${API_KEY}` };
const otherAuth = { Authorization: `Bearer ${OTHER_API_KEY}` };

const PNG = "image/png";
const MB = 1024 * 1024;

interface FileMetadata {
  file_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  purpose: string;
  uploaded_by: string | null;
  created_at: string;
}

async function seedTenants() {
  await env.DB.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)")
    .bind(TENANT_ID, "Files Test SME", await sha256Hex(API_KEY))
    .run();
  await env.DB.prepare("INSERT OR IGNORE INTO tenants (tenant_id, name, api_key_hash) VALUES (?, ?, ?)")
    .bind(OTHER_TENANT_ID, "Other Files SME", await sha256Hex(OTHER_API_KEY))
    .run();
}

async function fetchWorker(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://gateway.test${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/**
 * Status of a request whose body we do not care about — but which must still
 * be drained. A streamed R2 body left unread holds the bucket open and the
 * isolated-storage teardown between tests fails on it.
 */
async function statusOf(path: string, init?: RequestInit): Promise<number> {
  const res = await fetchWorker(path, init);
  await res.arrayBuffer();
  return res.status;
}

/** Deterministic bytes, so a digest comparison means something. */
function bytes(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) % 256;
  return out;
}

async function digestOf(content: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", content);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function uploadBody(
  content: Uint8Array,
  opts: { purpose: string; type?: string; filename?: string; omitFile?: boolean },
): FormData {
  const form = new FormData();
  if (!opts.omitFile) {
    form.append(
      "file",
      new File([content], opts.filename ?? "logo.png", { type: opts.type ?? PNG }),
    );
  }
  form.append("purpose", opts.purpose);
  return form;
}

async function upload(
  content: Uint8Array,
  opts: { purpose: string; type?: string; filename?: string; omitFile?: boolean },
  headers: Record<string, string> = auth,
): Promise<Response> {
  return fetchWorker("/v1/files", { method: "POST", headers, body: uploadBody(content, opts) });
}

/** Upload and assert it worked, returning the metadata. */
async function uploadOk(
  content: Uint8Array,
  opts: { purpose: string; type?: string; filename?: string },
  headers: Record<string, string> = auth,
): Promise<FileMetadata> {
  const res = await upload(content, opts, headers);
  expect(res.status).toBe(201);
  return (await res.json()) as FileMetadata;
}

async function r2KeyOf(fileId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT r2_key FROM files WHERE file_id = ?")
    .bind(fileId)
    .first<{ r2_key: string }>();
  expect(row).not.toBeNull();
  return row!.r2_key;
}

beforeAll(seedTenants);

describe("upload + read round trip", () => {
  it("stores the bytes and streams them back byte-identical", async () => {
    const content = bytes(2048);
    const meta = await uploadOk(content, { purpose: "other", type: "application/pdf", filename: "receipt.pdf" });

    expect(meta.file_id).toMatch(/^file_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(meta.filename).toBe("receipt.pdf");
    expect(meta.content_type).toBe("application/pdf");
    expect(meta.size_bytes).toBe(2048);
    expect(meta.purpose).toBe("other");

    const res = await fetchWorker(`/v1/files/${meta.file_id}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Length")).toBe("2048");
    expect(res.headers.get("Content-Disposition")).toContain('filename="receipt.pdf"');
    expect(res.headers.get("ETag")).toBe(`"${meta.sha256}"`);
    // Authenticated reads must never land in a shared cache.
    expect(res.headers.get("Cache-Control")).toContain("private");

    const returned = new Uint8Array(await res.arrayBuffer());
    expect(returned).toEqual(content);
  });

  it("stores the SHA-256 of the content (PRD-004 signature integrity)", async () => {
    const content = bytes(4096, 11);
    const meta = await uploadOk(content, { purpose: "signature" });
    expect(meta.sha256).toBe(await digestOf(content));
  });

  it("keys the object as {tenant_id}/{uuid} and never trusts the key alone", async () => {
    const meta = await uploadOk(bytes(64), { purpose: "other" });
    const key = await r2KeyOf(meta.file_id);
    expect(key).toMatch(
      /^biz_files\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    // The object exists under that key, but the row is what authorizes a read.
    expect(await env.FILES.head(key)).not.toBeNull();
  });

  it("attributes the upload to the caller (null for an API-key/system caller)", async () => {
    const meta = await uploadOk(bytes(32), { purpose: "other" });
    expect(meta.uploaded_by).toBeNull();
  });
});

describe("tenant isolation", () => {
  // PRD-000 AC1: 404, not 403 — a 403 confirms the id exists.
  it("returns 404, never 403, when another tenant reads the file id", async () => {
    const meta = await uploadOk(bytes(512), { purpose: "claim_receipt" });

    const res = await fetchWorker(`/v1/files/${meta.file_id}`, { headers: otherAuth });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
    const body = (await res.json()) as { error: string };
    // The message must not confirm the file exists or name its owner.
    expect(body.error).toBe("file not found");
    expect(body.error).not.toContain(TENANT_ID);
  });

  it("returns 404 when another tenant deletes the file id, and the object survives", async () => {
    const meta = await uploadOk(bytes(512), { purpose: "claim_receipt" });
    const key = await r2KeyOf(meta.file_id);

    const res = await fetchWorker(`/v1/files/${meta.file_id}`, {
      method: "DELETE",
      headers: otherAuth,
    });
    expect(res.status).toBe(404);

    // The owner's file is untouched by the failed cross-tenant delete.
    expect(await env.FILES.head(key)).not.toBeNull();
    expect(await statusOf(`/v1/files/${meta.file_id}`, { headers: auth })).toBe(200);
  });

  it("requires authentication on the tenant-scoped read", async () => {
    const meta = await uploadOk(bytes(128), { purpose: "other" });
    const res = await fetchWorker(`/v1/files/${meta.file_id}`);
    expect(res.status).toBe(401);
  });

  it("404s an unknown file id", async () => {
    const res = await fetchWorker("/v1/files/file_01JZZZZZZZZZZZZZZZZZZZZZZZ", { headers: auth });
    expect(res.status).toBe(404);
  });
});

describe("size limits", () => {
  // PRD-000 AC2.
  it("rejects a 12 MB upload with 413 and a message naming the limit", async () => {
    const res = await upload(bytes(12 * MB), { purpose: "claim_receipt" });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("too_large");
    expect(body.error).toMatch(/too large/i);
    expect(body.error).toContain("10 MB");
  });

  // C3: the limit is per purpose, not global.
  it("accepts 3 MB as a claim_receipt but 413s the same bytes as a quote_logo", async () => {
    const content = bytes(3 * MB);

    const receipt = await upload(content, { purpose: "claim_receipt" });
    expect(receipt.status).toBe(201);

    const logo = await upload(content, { purpose: "quote_logo" });
    expect(logo.status).toBe(413);
    const body = (await logo.json()) as { error: string };
    expect(body.error).toContain("quote_logo");
    expect(body.error).toContain("2 MB");
  });

  it("refuses an oversized body on Content-Length, before parsing it", async () => {
    // A multipart FormData body is sent without a Content-Length, so the test
    // above is caught by the exact per-purpose check after parsing. This one
    // sends a fixed-length body so the pre-flight guard — the reason a 12 MB
    // upload is not buffered in the first place — is exercised too.
    const res = await fetchWorker("/v1/files", {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "multipart/form-data; boundary=xyz",
        // Set explicitly: a Request handed straight to worker.fetch() never
        // goes over the wire, so the runtime does not compute one for us the
        // way a real HTTP client would.
        "Content-Length": String(11 * MB),
      },
      body: bytes(11 * MB),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("too_large");
    expect(body.error).toContain("10 MB");
    // The per-purpose message would name a purpose; this one cannot know it.
    expect(body.error).not.toContain("purpose '");
  });

  it("rejects an empty file with 400", async () => {
    const res = await upload(new Uint8Array(0), { purpose: "other" });
    expect(res.status).toBe(400);
  });
});

describe("content type allowlist", () => {
  // PRD-000 AC3.
  it("rejects application/zip with 415", async () => {
    const res = await upload(bytes(256), {
      purpose: "other",
      type: "application/zip",
      filename: "bundle.zip",
    });
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("unsupported_type");
    expect(body.error).toContain("application/zip");
  });

  // C3: quote_logo's allowlist is narrower than the default, because it is the
  // one purpose served to an unauthenticated caller.
  it("rejects application/pdf as a quote_logo while allowing it as a claim_receipt", async () => {
    const content = bytes(256);

    const logo = await upload(content, {
      purpose: "quote_logo",
      type: "application/pdf",
      filename: "brand.pdf",
    });
    expect(logo.status).toBe(415);

    const receipt = await upload(content, {
      purpose: "claim_receipt",
      type: "application/pdf",
      filename: "receipt.pdf",
    });
    expect(receipt.status).toBe(201);
  });

  it("accepts every default image type", async () => {
    for (const type of ["image/png", "image/jpeg", "image/webp"]) {
      const res = await upload(bytes(128), { purpose: "quote_logo", type });
      expect(res.status, type).toBe(201);
    }
  });
});

describe("request validation", () => {
  it("rejects an unknown purpose with 400", async () => {
    const res = await upload(bytes(64), { purpose: "top_secret" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("invalid_request");
    expect(body.error).toContain("top_secret");
  });

  it("rejects a body with no 'file' part with 400", async () => {
    const res = await upload(bytes(64), { purpose: "other", omitFile: true });
    expect(res.status).toBe(400);
  });

  it("rejects a non-multipart body with 400", async () => {
    const res = await fetchWorker("/v1/files", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ purpose: "other" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("delete", () => {
  // PRD-000 AC4.
  it("soft-deletes the row, 404s the read, and removes the R2 object", async () => {
    const meta = await uploadOk(bytes(1024), { purpose: "claim_receipt" });
    const key = await r2KeyOf(meta.file_id);
    expect(await env.FILES.head(key)).not.toBeNull();

    const del = await fetchWorker(`/v1/files/${meta.file_id}`, { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);

    const read = await fetchWorker(`/v1/files/${meta.file_id}`, { headers: auth });
    expect(read.status).toBe(404);

    // The bytes are gone from the bucket...
    expect(await env.FILES.head(key)).toBeNull();

    // ...while the row survives, stamped, for the audit trail.
    const row = await env.DB.prepare("SELECT deleted_at FROM files WHERE file_id = ?")
      .bind(meta.file_id)
      .first<{ deleted_at: string | null }>();
    expect(row?.deleted_at).toBeTruthy();
  });

  it("404s a second delete of the same file", async () => {
    const meta = await uploadOk(bytes(128), { purpose: "other" });
    expect(await statusOf(`/v1/files/${meta.file_id}`, { method: "DELETE", headers: auth })).toBe(204);
    expect(await statusOf(`/v1/files/${meta.file_id}`, { method: "DELETE", headers: auth })).toBe(404);
  });

  it("stops serving a deleted quote_logo on the public route", async () => {
    const meta = await uploadOk(bytes(256), { purpose: "quote_logo" });
    expect(await statusOf(`/files/${meta.file_id}`)).toBe(200);

    await fetchWorker(`/v1/files/${meta.file_id}`, { method: "DELETE", headers: auth });
    expect(await statusOf(`/files/${meta.file_id}`)).toBe(404);
  });
});

describe("public read (C3 — per-purpose, never per-caller)", () => {
  it("serves a quote_logo with no credential at all", async () => {
    const content = bytes(600, 3);
    const meta = await uploadOk(content, { purpose: "quote_logo", type: "image/webp" });

    const res = await fetchWorker(`/files/${meta.file_id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
    // Uploads are immutable, so the bytes behind an id never change.
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(content);
  });

  it("404s every purpose that is not publicly readable", async () => {
    for (const purpose of ["claim_receipt", "signature", "other"]) {
      const meta = await uploadOk(bytes(128), { purpose });
      const res = await fetchWorker(`/files/${meta.file_id}`);
      expect(res.status, purpose).toBe(404);
    }
  });

  it("stays 404 on the public route even for the owning tenant's credential", async () => {
    // Public readability is a property of the purpose, not of the caller: a
    // valid credential does not unlock a private file on this route.
    const meta = await uploadOk(bytes(128), { purpose: "claim_receipt" });
    const res = await fetchWorker(`/files/${meta.file_id}`, { headers: auth });
    expect(res.status).toBe(404);
    // ...though the same file is readable on the tenant-scoped route.
    expect(await statusOf(`/v1/files/${meta.file_id}`, { headers: auth })).toBe(200);
  });

  it("404s an unknown id without revealing whether it ever existed", async () => {
    const res = await fetchWorker("/files/file_01JZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toEqual({ error: "file not found" });
  });
});

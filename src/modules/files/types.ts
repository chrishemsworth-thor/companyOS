/** File primitive domain types (PRD-000a). */

import type { FilePurpose } from "./policy";

/** A stored file's metadata row. The bytes live in R2 under `r2_key`. */
export interface FileRecord {
  file_id: string;
  tenant_id: string;
  /** `{tenant_id}/{uuid}` — a layout convention, never an authorization check. */
  r2_key: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** SHA-256 hex of the content; PRD-004 uses it for signature integrity. */
  sha256: string;
  purpose: string;
  uploaded_by: string | null;
  created_at: string;
  deleted_at: string | null;
}

/** What the API hands back — no `r2_key`, no `tenant_id`, both internal. */
export interface FileMetadata {
  file_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  purpose: FilePurpose;
  uploaded_by: string | null;
  created_at: string;
}

export interface UploadInput {
  bytes: ArrayBuffer;
  filename: string;
  contentType: string;
  /** Raw string from the request; validated against the purpose enum. */
  purpose: string;
  /** `usr_...` for human callers, null for tenant-API-key (system) callers. */
  uploadedBy: string | null;
}

/**
 * Per-purpose file policy.
 *
 * PRD-000 states one global rule — 10 MB, four content types, always
 * authenticated. That rule does not survive contact with its own consumers:
 * PRD-004 needs a tenant logo rendered on an *unauthenticated* public quote
 * page and capped at 2 MB, and PRD-005 will want public customer uploads with
 * limits stricter than the authenticated path (SESSION-PLAN conflict C3).
 *
 * So the global rule becomes the DEFAULT row of a table keyed on `purpose`,
 * and each purpose overrides what it needs. The tenant-isolation rule is
 * untouched by this: `publiclyReadable` is a property of a purpose, never of a
 * caller, and `quote_logo` is the only purpose that has it in v1.
 *
 * Adding a purpose is an entry in this file plus a value in the Zod enum — no
 * migration, because `files.purpose` is unconstrained TEXT by design.
 */

export const FILE_PURPOSES = [
  "quote_logo",
  "claim_receipt",
  /** Medical certificates and the like, on a leave request (PRD-006c, S7). */
  "leave_attachment",
  "signature",
  /** The frozen HTML of an accepted quote (PRD-004, S9). */
  "quote_artifact",
  "other",
] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

export interface FilePolicy {
  /** Hard ceiling on stored bytes. Exceeding it is a 413. */
  maxBytes: number;
  /** Exact `Content-Type` allowlist. Anything else is a 415. */
  contentTypes: readonly string[];
  /**
   * Whether the bytes are served by the credential-less `GET /files/:id`
   * route. False for everything a customer should never see.
   */
  publiclyReadable: boolean;
}

const MB = 1024 * 1024;

/** PRD-000's stated rule, applied to every purpose that does not override it. */
const DEFAULT_POLICY: FilePolicy = {
  maxBytes: 10 * MB,
  contentTypes: ["image/png", "image/jpeg", "image/webp", "application/pdf"],
  publiclyReadable: false,
};

export const FILE_POLICIES: Record<FilePurpose, FilePolicy> = {
  // The one publicly readable purpose in v1: PRD-004 renders it in an <img>
  // on a page the customer opens without logging in. Smaller cap because a
  // logo is a logo, and no PDF — a PDF cannot render in an <img>, and this is
  // the only purpose whose bytes are served to an unauthenticated caller, so
  // its allowlist is the one worth keeping narrow.
  quote_logo: {
    maxBytes: 2 * MB,
    contentTypes: ["image/png", "image/jpeg", "image/webp"],
    publiclyReadable: true,
  },
  claim_receipt: DEFAULT_POLICY,
  // A photographed medical certificate, same shape as a receipt. Never publicly
  // readable — it is health information about a named employee, which is the
  // most sensitive thing this system stores.
  leave_attachment: DEFAULT_POLICY,
  // A hand-drawn or typed signature captured on the public quote page. Tighter
  // than the default on both axes: no PDF (it is rendered into an <img> on the
  // archived artifact, and a PDF cannot be), and 1 MB, because a canvas
  // signature is a few tens of kilobytes and the bytes arrive from an
  // UNAUTHENTICATED caller. Never publicly readable — it is a person's
  // signature, and the artifact embeds a copy anyway.
  signature: {
    maxBytes: 1 * MB,
    contentTypes: ["image/png", "image/jpeg", "image/webp"],
    publiclyReadable: false,
  },
  // The frozen document a customer accepted: the artifact whose SHA-256 is the
  // acceptance record's proof. Large because it inlines its own images as
  // `data:` URIs — a 2 MB logo is ~2.7 MB base64 — which is exactly what makes
  // it render identically after the tenant changes their branding.
  //
  // NOT publicly readable. It is reachable two ways, both of which resolve the
  // caller's right to it first: `GET /q/:token/artifact` (holding the link) and
  // `GET /v1/quotes/:id/artifact` (holding the tenant's credentials). Marking
  // it public would mean stored HTML served to anyone with an id.
  quote_artifact: {
    maxBytes: 8 * MB,
    contentTypes: ["text/html"],
    publiclyReadable: false,
  },
  other: DEFAULT_POLICY,
};

export function isFilePurpose(value: string): value is FilePurpose {
  return (FILE_PURPOSES as readonly string[]).includes(value);
}

export function policyFor(purpose: FilePurpose): FilePolicy {
  return FILE_POLICIES[purpose];
}

/**
 * Whether a stored file may be served without a credential. Takes the raw
 * `purpose` string off the row: an unrecognised purpose (a value written by a
 * future migration this build does not know about) is never public.
 */
export function isPubliclyReadable(purpose: string): boolean {
  return isFilePurpose(purpose) && FILE_POLICIES[purpose].publiclyReadable;
}

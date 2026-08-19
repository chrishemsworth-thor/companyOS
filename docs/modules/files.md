# Files (platform primitive)

Tenant-scoped binary storage. Any module can store a file and get back a stable
id without knowing that R2 exists. Built by PRD-000a as the first of the three
platform primitives (files → approvals → notifications).

**In scope:** upload, read, delete, per-purpose policy, tenant isolation,
SHA-256 of content.
**Out of scope:** versioning (uploads are immutable — a new file is a new
object), virus scanning, image resizing, magic-byte sniffing.

## Data model (`migrations/0021_files.sql`)

| Table | Purpose | Key columns |
|---|---|---|
| `files` | One row per stored object | `file_id` (`file_`), `r2_key`, `filename`, `content_type`, `size_bytes`, `sha256`, `purpose`, `uploaded_by`, `deleted_at` |

Bytes live in R2 under **`{tenant_id}/{uuid}`**. The key prefix is a layout
convention only: **the row owns tenancy**, and every read resolves the row and
compares `tenant_id` to the caller before streaming. A guessed key is never
enough, and a cross-tenant read by file id returns **404, not 403** — a 403
would confirm the id exists.

Deletion is a soft delete of the row plus a **hard delete of the object**. The
audit trail of who uploaded what survives; the bytes do not.

`purpose` is unconstrained `TEXT` validated by a Zod enum in the service, not a
SQL `CHECK`. Per-purpose policy is the point of the column, and consuming PRDs
add purposes as they land — a `CHECK` would mean a migration per module. Same
deliberate divergence the approvals primitive makes for `subject_type`.

## Per-purpose policy (`src/modules/files/policy.ts`)

PRD-000 specifies one global rule; its own consumers need three different ones
(SESSION-PLAN conflict C3). So the global rule is the **default row** of a
table keyed on `purpose`:

| purpose | max | content types | publicly readable |
|---|---|---|---|
| `quote_logo` | 2 MB | png, jpeg, webp | **yes** |
| `claim_receipt` | 10 MB | png, jpeg, webp, pdf | no |
| `leave_attachment` | 10 MB | png, jpeg, webp, pdf | no |
| `signature` | 1 MB | png, jpeg, webp | no |
| `quote_artifact` | 8 MB | `text/html` | no |
| `other` | 10 MB | png, jpeg, webp, pdf | no |

`quote_logo` drops PDF: it is the one purpose served to an unauthenticated
caller, and a PDF cannot render in the `<img>` on PRD-004's public quote page.

**S9 tightened `signature` and added `quote_artifact`** (PRD-004):

- `signature` is a canvas drawing of a few tens of kilobytes, arriving from an
  **unauthenticated** caller on the public quote page, and it is rendered into
  an `<img>` on the archived artifact. So: 1 MB, images only, no PDF.
- `quote_artifact` is the frozen HTML of an accepted quote — the document whose
  SHA-256 is the acceptance record's proof. It is large because it **inlines its
  own images as `data:` URIs**, which is what lets it render identically after
  the tenant changes their branding or deletes the logo. It is **not** publicly
  readable: it is reached through `GET /q/:token/artifact` (holding the link) or
  `GET /v1/quotes/:id/artifact` (holding the tenant's credentials), each of
  which establishes the caller's right to it first.

**Public readability is a property of the purpose, never of the caller.**
A valid credential does not unlock a private file on the public route, and an
unrecognised purpose is never public. Adding a purpose is an entry in this file
plus a value in the enum — no migration.

## API

`FilesError` maps to 400 (`invalid_request`), 404 (`not_found`), 413
(`too_large`) and 415 (`unsupported_type`).

| Method & path | Auth | Body / returns |
|---|---|---|
| `POST /v1/files` | tenant-scoped | `multipart/form-data`: `file` (required), `purpose` (required), `filename` (optional override) → **201** with `{file_id, filename, content_type, size_bytes, sha256, purpose, uploaded_by, created_at}` |
| `GET /v1/files/:id` | tenant-scoped | Streams the bytes. `ETag` is the sha256; `Cache-Control: private` |
| `DELETE /v1/files/:id` | tenant-scoped | **204**. Soft-deletes the row, deletes the object |
| `GET /files/:id` | **none** | Publicly readable purposes only, everything else 404. `Cache-Control: public, immutable` — uploads never change |

The public route sits outside `/v1`, next to `/webhooks` and `/oauth/google`,
rather than punching a hole in the `authenticate()` guard.

Size is enforced twice: a pre-flight check on `Content-Length` against the
largest limit any purpose allows (so an absurd body is refused before it is
buffered), then the exact per-purpose limit against the real byte count —
`purpose` is itself a form field, so it is not known until the body is parsed,
and a lying `Content-Length` buys nothing.

The content-type allowlist is applied to the **declared** type, as PRD-000
specifies. Combined with `X-Content-Type-Options: nosniff` on every response
and `Content-Disposition: inline`, a mislabelled upload cannot be talked into
executing in a browser.

**One exception, added by S9: stored `text/html` is served as `attachment`, not
`inline`.** The only HTML in the bucket is an archived quote artifact, which is
not publicly readable — but serving it inline here would put stored markup on
the API origin for any authenticated caller holding an id, which is a cheap way
to turn a file store into a stored-XSS surface for a convenience nobody needs.
The artifact's own two routes serve it as HTML deliberately, under
`default-src 'none'; style-src 'unsafe-inline'; img-src data:`, which it
satisfies precisely because it is self-contained.

## Events

**None.** The file primitive emits nothing in v1 — no consumer needs to react
to an upload. Approvals (`approval.*.v1`) are the next primitive's events.

## Bindings

`FILES` (R2, bucket `companyos-files`) in **both** wrangler configs — the test
suite reads `wrangler.jsonc`, the free-plan deploy reads `wrangler.free.jsonc`.
Create the bucket once with `npx wrangler r2 bucket create companyos-files`;
leave it private (see [production-deployment.md](../production-deployment.md)
§2).

## Tests

`test/files.test.ts` — 25 tests in the Workers runtime, one per PRD-000
acceptance criterion plus the C3 per-purpose cases.

Two harness notes worth keeping: use `env.FILES.head()` rather than `get()` for
existence assertions (an unread R2 body stream breaks the isolated-storage
teardown), and drain any response body you do not assert on, for the same
reason. A `FormData` request body carries no `Content-Length` in the test
runtime, so the pre-flight guard needs the header set explicitly to be covered.

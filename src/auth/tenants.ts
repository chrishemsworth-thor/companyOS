import { ulid } from "../lib/ulid";
import { sha256Hex, type Tenant } from "../gateway/middleware/auth";

/**
 * Tenant (company) service. A tenant is one business running on CompanyOS.
 * Every other table hangs off `tenant_id`, so creating a tenant is the root of
 * onboarding a new company. The API key is shown once at creation and only its
 * SHA-256 hash is stored — same discipline as `api_key_hash` everywhere else.
 */

export interface TenantPublic {
  tenant_id: string;
  name: string;
  slug: string;
  created_at: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export class TenantError extends Error {
  constructor(
    readonly code: "slug_taken" | "invalid_slug" | "not_found",
    message: string,
    readonly httpStatus: 400 | 404 | 409 = 409,
  ) {
    super(message);
    this.name = "TenantError";
  }
}

/** Validate a workspace slug: lowercase alphanumerics + internal hyphens. */
export function normalizeSlug(input: string): string {
  const slug = input.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    throw new TenantError(
      "invalid_slug",
      "slug must be 1-50 chars: lowercase letters, digits, and internal hyphens",
      400,
    );
  }
  return slug;
}

/**
 * Provision a new company. Generates a `biz_<ulid>` id and a fresh API key,
 * stores only the key's hash, and returns the plaintext key exactly once so the
 * caller can hand it to the tenant. Throws TenantError('slug_taken') on a slug
 * collision (surfaced by the unique index).
 */
export async function createTenant(
  db: D1Database,
  input: { name: string; slug: string },
): Promise<{ tenant: TenantPublic; api_key: string }> {
  const slug = normalizeSlug(input.slug);
  const tenantId = `biz_${ulid()}`;
  // Prefixed, high-entropy key. Only the hash is persisted.
  const apiKey = `cos_${ulid()}${ulid()}`;
  const apiKeyHash = await sha256Hex(apiKey);

  try {
    await db
      .prepare("INSERT INTO tenants (tenant_id, name, slug, api_key_hash) VALUES (?, ?, ?, ?)")
      .bind(tenantId, input.name, slug, apiKeyHash)
      .run();
  } catch (err) {
    // The slug (and, redundantly, the key hash) are UNIQUE — a collision is the
    // only expected failure here.
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new TenantError("slug_taken", "workspace slug already in use", 409);
    }
    throw err;
  }

  const tenant = (await getTenantBySlug(db, slug))!;
  return { tenant, api_key: apiKey };
}

/** Resolve a company by its login slug (workspace). Null if unknown. */
export async function resolveTenantBySlug(db: D1Database, slug: string): Promise<Tenant | null> {
  return db
    .prepare("SELECT tenant_id, name FROM tenants WHERE slug = ?")
    .bind(slug.trim().toLowerCase())
    .first<Tenant>();
}

export async function getTenantBySlug(db: D1Database, slug: string): Promise<TenantPublic | null> {
  return db
    .prepare("SELECT tenant_id, name, slug, created_at FROM tenants WHERE slug = ?")
    .bind(slug.trim().toLowerCase())
    .first<TenantPublic>();
}

/** List all companies on the platform (for internal operational visibility). */
export async function listTenants(db: D1Database): Promise<TenantPublic[]> {
  const { results } = await db
    .prepare("SELECT tenant_id, name, slug, created_at FROM tenants ORDER BY created_at")
    .all<TenantPublic>();
  return results;
}

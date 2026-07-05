import type { Env } from "../../env";
import type { ModuleCredentials } from "../adapters/types";

/**
 * Resolve a tenant's credentials for one module instance from D1.
 * Returns null when the tenant hasn't connected that module yet.
 */
export async function getModuleCredentials(
  env: Env,
  tenantId: string,
  module: string,
): Promise<ModuleCredentials | null> {
  const row = await env.DB.prepare(
    "SELECT base_url, api_key, api_secret FROM tenant_credentials WHERE tenant_id = ? AND module = ?",
  )
    .bind(tenantId, module)
    .first<ModuleCredentials>();
  return row ?? null;
}

/** In mock mode adapters never call out, so placeholder creds are fine. */
export const MOCK_CREDENTIALS: ModuleCredentials = {
  base_url: "https://erpnext.mock.invalid",
  api_key: "mock",
  api_secret: "mock",
};

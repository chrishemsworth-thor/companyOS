import type { Env } from "../../env";

/**
 * Where links in outbound email point. The Worker doesn't serve the operator
 * console itself, so the console origin must come from config: an explicit
 * CONSOLE_BASE_URL wins, else the first ALLOWED_ORIGINS entry (by convention
 * the production console — see wrangler.jsonc), else the local Vite dev URL.
 */
export function consoleBaseUrl(env: Env): string {
  if (env.CONSOLE_BASE_URL) return env.CONSOLE_BASE_URL.replace(/\/+$/, "");
  const firstOrigin = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)[0];
  return (firstOrigin ?? "http://localhost:5173").replace(/\/+$/, "");
}

export const acceptInvitePath = (token: string) => `/accept-invite?token=${token}`;
export const resetPasswordPath = (token: string) => `/reset-password?token=${token}`;

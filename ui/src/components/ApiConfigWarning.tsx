import { AlertTriangle } from "lucide-react";
import { API_MISCONFIGURED, DEFAULT_BASE_URL } from "../auth/AuthContext";

/**
 * Shown on the public auth pages when a deployed bundle was built without
 * VITE_API_BASE_URL. Without this, every request goes to the visitor's own
 * machine and the only symptom is ERR_CONNECTION_REFUSED behind a generic
 * "could not reach the server" — which reads as a broken feature rather than a
 * broken deploy. Renders nothing in local dev and on correctly built bundles.
 */
export function ApiConfigWarning() {
  if (!API_MISCONFIGURED) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-md border border-bad/40 bg-bad-bg/60 p-2.5 text-sm text-bad"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        This console was deployed without an API address, so it is trying to reach{" "}
        <code>{DEFAULT_BASE_URL}</code> — your own device. Nothing here will work until it is
        rebuilt with <code>VITE_API_BASE_URL</code> set (<code>npm run build:prod</code>). Please
        pass this on to whoever deployed it.
      </span>
    </div>
  );
}

import { ApiError } from "../api/client";

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError
      ? `${error.message}${error.code ? ` (${error.code})` : ""}`
      : error instanceof Error
        ? error.message
        : "request failed";
  return <div className="form-error">{message}</div>;
}

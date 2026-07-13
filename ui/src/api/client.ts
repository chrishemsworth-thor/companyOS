export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

const MUTATING = new Set(["POST", "PATCH", "PUT", "DELETE"]);

export interface ApiClientOptions {
  /** Returns the current CSRF token, attached to mutating requests. */
  getCsrf?: () => string | null;
  /** Called when the server rejects a request as unauthenticated (401). */
  onUnauthorized?: () => void;
}

/**
 * Thin fetch wrapper for the CompanyOS API. Auth is cookie-based: every request
 * sends `credentials: 'include'` so the HttpOnly session cookie rides along, and
 * mutating requests attach the synchronizer CSRF token. The browser never holds
 * the tenant API key.
 */
export class ApiClient {
  constructor(
    private baseUrl: string,
    private opts: ApiClientOptions = {},
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(init?.headers as Record<string, string> | undefined),
    };
    if (MUTATING.has(method)) {
      headers["X-CSRF-Token"] = this.opts.getCsrf?.() ?? "";
    }
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers,
    });
    if (!res.ok) {
      if (res.status === 401) this.opts.onUnauthorized?.();
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      throw new ApiError(
        typeof body.error === "string" ? body.error : `request failed (${res.status})`,
        res.status,
        typeof body.code === "string" ? body.code : undefined,
      );
    }
    return (await res.json()) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: opts?.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : undefined,
    });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body: JSON.stringify(body) });
  }
}

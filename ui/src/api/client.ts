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

  /**
   * Fetch binary content as a Blob — receipt images on the claim approval card.
   *
   * Needed because an `<img src="…/v1/claims/…/receipt">` would send **no
   * credential**: the session cookie is `SameSite=Lax`, which excludes
   * cross-origin subresource requests, and the console and API are separate
   * origins in every deployment. So the bytes come through here with
   * `credentials: 'include'` and the caller renders an object URL.
   *
   * Not routed through `request()` — that always parses JSON — but it keeps the
   * same 401 handling, so an expired session logs out rather than showing a
   * silently broken image.
   */
  async getBlob(path: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}${path}`, { credentials: "include" });
    if (!res.ok) {
      if (res.status === 401) this.opts.onUnauthorized?.();
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      throw new ApiError(
        typeof body.error === "string" ? body.error : `request failed (${res.status})`,
        res.status,
        typeof body.code === "string" ? body.code : undefined,
      );
    }
    return res.blob();
  }

  /**
   * Multipart upload — the file primitive's `POST /v1/files`.
   *
   * Deliberately does NOT set `Content-Type`: the browser has to write it
   * itself so it can append the multipart boundary. Setting it by hand (as
   * `request()` does for JSON) produces a body the server cannot parse, which
   * is why this is its own method rather than a flag on `post`.
   */
  async postForm<T>(path: string, form: FormData): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRF-Token": this.opts.getCsrf?.() ?? "" },
      body: form,
    });
    if (!res.ok) {
      if (res.status === 401) this.opts.onUnauthorized?.();
      const body = await res.json().catch(() => ({}) as Record<string, unknown>);
      throw new ApiError(
        typeof body.error === "string" ? body.error : `upload failed (${res.status})`,
        res.status,
        typeof body.code === "string" ? body.code : undefined,
      );
    }
    return (await res.json()) as T;
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

  put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", body: JSON.stringify(body) });
  }

  /**
   * DELETE. The first console caller is revoking a public quote link, whose
   * route answers 204 with no body — so this does not go through `request()`,
   * which always parses JSON and would choke on an empty one. `MUTATING`
   * already listed DELETE, so the CSRF token was always going to ride along;
   * only the response handling needed writing.
   */
  async delete(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      credentials: "include",
      headers: { "X-CSRF-Token": this.opts.getCsrf?.() ?? "" },
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
  }
}

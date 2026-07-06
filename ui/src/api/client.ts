export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!res.ok) {
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
}

/** Cheap, cheap read used only to confirm an API key actually resolves a tenant. */
export async function verifyApiKey(baseUrl: string, apiKey: string): Promise<boolean> {
  const res = await fetch(`${baseUrl}/v1/customers`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return res.ok;
}

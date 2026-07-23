import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiClient, ApiError } from "../api/client";

const STORAGE_BASE_URL = "companyos_base_url";

/**
 * Production builds pin the API origin at build time (VITE_API_BASE_URL) so
 * operators never see or edit it; the login page then hides the field and any
 * stale localStorage override is ignored. Dev builds leave it unset, keeping
 * the editable field with the local-Worker default.
 */
const CONFIGURED_BASE_URL =
  (import.meta.env.VITE_API_BASE_URL ?? "").trim().replace(/\/+$/, "") || null;
export const BASE_URL_LOCKED = CONFIGURED_BASE_URL !== null;
export const DEFAULT_BASE_URL = CONFIGURED_BASE_URL ?? "http://localhost:8787";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthUser {
  user_id: string;
  email: string;
  display_name: string | null;
  role: "admin" | "operator" | "finance" | "support" | "readonly";
  status: "active" | "disabled";
}

/** The company (tenant) the current session belongs to. */
export interface AuthTenant {
  tenant_id: string;
  name: string;
  /** Null until the first-run onboarding journey is finished or dismissed. */
  onboarded_at: string | null;
}

/** The response shape of /v1/auth/login and /v1/auth/invite/accept. */
export interface AuthCompletion {
  user: AuthUser;
  tenant?: AuthTenant | null;
  csrf_token: string;
}

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  tenant: AuthTenant | null;
  baseUrl: string;
  client: ApiClient | null;
  login: (workspace: string, email: string, password: string) => Promise<void>;
  /** Adopt a server-issued session (login or invite-accept response body). */
  completeAuth: (body: AuthCompletion) => void;
  logout: () => Promise<void>;
  setBaseUrl: (url: string) => void;
  /** Reflect a successful POST /v1/settings/onboarding/complete locally. */
  markOnboarded: () => void;
  /** Reflect the tenant rename that a company-profile save performs server-side. */
  renameTenant: (name: string) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [baseUrl, setBaseUrlState] = useState<string>(() =>
    BASE_URL_LOCKED ? DEFAULT_BASE_URL : (localStorage.getItem(STORAGE_BASE_URL) ?? DEFAULT_BASE_URL),
  );
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenant, setTenant] = useState<AuthTenant | null>(null);
  // CSRF token lives in a ref so the ApiClient's getter always reads the latest
  // value without rebuilding the client on every token change.
  const csrfRef = useRef<string | null>(null);

  const client = useMemo(
    () =>
      new ApiClient(baseUrl, {
        getCsrf: () => csrfRef.current,
        onUnauthorized: () => {
          csrfRef.current = null;
          setUser(null);
          setTenant(null);
          setStatus("anonymous");
        },
      }),
    [baseUrl],
  );

  // Bootstrap: ask the server who we are (rides the session cookie, if any).
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetch(`${baseUrl}/v1/auth/me`, { credentials: "include" })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) {
          setUser(null);
          setTenant(null);
          setStatus("anonymous");
          return;
        }
        const body = (await res.json()) as {
          user: AuthUser;
          tenant: AuthTenant | null;
          csrf_token: string;
        };
        csrfRef.current = body.csrf_token;
        setUser(body.user);
        setTenant(body.tenant ?? null);
        setStatus("authenticated");
      })
      .catch(() => {
        if (!cancelled) setStatus("anonymous");
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  const completeAuth = (body: AuthCompletion) => {
    csrfRef.current = body.csrf_token;
    setUser(body.user);
    setTenant(body.tenant ?? null);
    setStatus("authenticated");
  };

  const login = async (workspace: string, email: string, password: string) => {
    const res = await postJson(baseUrl, "/v1/auth/login", { workspace, email, password });
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (!res.ok) {
      throw new ApiError(
        typeof body.error === "string" ? body.error : `login failed (${res.status})`,
        res.status,
        typeof body.code === "string" ? body.code : undefined,
      );
    }
    completeAuth(body as unknown as AuthCompletion);
  };

  const logout = async () => {
    try {
      await postJson(baseUrl, "/v1/auth/logout", {});
    } finally {
      csrfRef.current = null;
      setUser(null);
      setTenant(null);
      setStatus("anonymous");
    }
  };

  const setBaseUrl = (url: string) => {
    if (BASE_URL_LOCKED) return;
    localStorage.setItem(STORAGE_BASE_URL, url);
    setBaseUrlState(url);
  };

  const markOnboarded = () =>
    setTenant((t) => (t ? { ...t, onboarded_at: t.onboarded_at ?? new Date().toISOString() } : t));

  const renameTenant = (name: string) => setTenant((t) => (t && name ? { ...t, name } : t));

  return (
    <AuthContext.Provider
      value={{
        status,
        user,
        tenant,
        baseUrl,
        client,
        login,
        completeAuth,
        logout,
        setBaseUrl,
        markOnboarded,
        renameTenant,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

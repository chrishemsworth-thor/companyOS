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
import { can as roleCan, type Capability, type Role } from "../lib/roles";

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

/**
 * True when a deployed (non-local) bundle was built without VITE_API_BASE_URL,
 * so it would silently call http://localhost:8787 on the visitor's own machine
 * and fail with ERR_CONNECTION_REFUSED. Anyone who previously typed an origin
 * into the dev-only base-URL field has a localStorage override and won't notice
 * — which makes this misconfiguration look like a bug in whatever page a fresh
 * visitor lands on. Surface it instead of letting it masquerade.
 */
export const API_MISCONFIGURED =
  CONFIGURED_BASE_URL === null &&
  typeof location !== "undefined" &&
  !["localhost", "127.0.0.1", "0.0.0.0", ""].includes(location.hostname);

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthUser {
  user_id: string;
  email: string;
  display_name: string | null;
  role: Role;
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
  /** Server-derived capability list; absent on older responses. */
  capabilities?: Capability[];
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
  /**
   * Does the signed-in user hold this capability? Used to hide actions that
   * would only come back 403 (PRD-008). This is a rendering convenience — the
   * server enforces the same matrix on every request, so a client that lies to
   * itself gains nothing.
   */
  can: (capability: Capability) => boolean;
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
        const body = (await res.json()) as AuthCompletion & { tenant: AuthTenant | null };
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

  // Capabilities are derived from the role rather than stored from the login
  // response, so a role change picked up by /v1/auth/me takes effect without a
  // second source of truth to keep in step.
  const can = (capability: Capability) => roleCan(user?.role, capability);

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
        can,
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

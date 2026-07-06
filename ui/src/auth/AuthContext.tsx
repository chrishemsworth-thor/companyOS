import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { ApiClient } from "../api/client";

const STORAGE_KEY = "companyos_api_key";
const STORAGE_BASE_URL = "companyos_base_url";
export const DEFAULT_BASE_URL = "http://localhost:8787";

interface AuthContextValue {
  apiKey: string | null;
  baseUrl: string;
  client: ApiClient | null;
  login: (apiKey: string, baseUrl: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(() => sessionStorage.getItem(STORAGE_KEY));
  const [baseUrl, setBaseUrl] = useState<string>(
    () => sessionStorage.getItem(STORAGE_BASE_URL) ?? DEFAULT_BASE_URL,
  );

  const login = (key: string, url: string) => {
    sessionStorage.setItem(STORAGE_KEY, key);
    sessionStorage.setItem(STORAGE_BASE_URL, url);
    setApiKey(key);
    setBaseUrl(url);
  };

  const logout = () => {
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_BASE_URL);
    setApiKey(null);
  };

  const client = useMemo(() => (apiKey ? new ApiClient(baseUrl, apiKey) : null), [apiKey, baseUrl]);

  return (
    <AuthContext.Provider value={{ apiKey, baseUrl, client, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

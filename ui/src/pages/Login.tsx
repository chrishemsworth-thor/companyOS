import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth, DEFAULT_BASE_URL } from "../auth/AuthContext";
import { verifyApiKey } from "../api/client";

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setChecking(true);
    try {
      const ok = await verifyApiKey(baseUrl, apiKey.trim());
      if (!ok) {
        setError("That API key was rejected by the server. Check the key and the API URL.");
        return;
      }
      login(apiKey.trim(), baseUrl.trim());
      navigate("/");
    } catch {
      setError(`Could not reach ${baseUrl}. Is the Worker running?`);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>CompanyOS Operator Console</h1>
        <p className="muted">
          Paste a tenant API key (from <code>npm run seed:local</code> or your own tenant) to
          connect. This is a read-only console — the key is kept only in this browser tab's
          session storage.
        </p>
        <label>
          API base URL
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
        </label>
        <label>
          Tenant API key
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="e.g. co_live_..."
            required
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button type="submit" disabled={checking}>
          {checking ? "Connecting…" : "Connect"}
        </button>
      </form>
    </div>
  );
}

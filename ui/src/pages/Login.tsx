import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { Button } from "../components/Button";

export function Login() {
  const { login, baseUrl, setBaseUrl } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [url, setUrl] = useState(baseUrl);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (url.trim() !== baseUrl) setBaseUrl(url.trim());
      await login(email.trim(), password);
      navigate("/");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 401 ? "Invalid email or password." : err.message || "Login failed.",
        );
      } else {
        setError(`Could not reach ${url}. Is the Worker running?`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-accent text-lg font-bold text-accent-contrast shadow-sm">
            C
          </span>
          <div>
            <h1 className="m-0 text-xl font-semibold tracking-tight">Welcome to CompanyOS</h1>
            <p className="mt-1 text-sm text-muted">Sign in to your operator console</p>
          </div>
        </div>

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-md"
        >
          <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
            Email
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
            Password
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
            API base URL
            <input
              className="input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              required
            />
          </label>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-md border border-bad/40 bg-bad-bg/60 p-2.5 text-sm text-bad"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>{error}</span>
            </div>
          )}

          <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
            {busy ? "Signing in…" : "Sign in"}
          </Button>

          <p className="m-0 text-center text-xs leading-relaxed text-subtle">
            Your session is kept in a secure, HttpOnly cookie — the tenant API key never touches the
            browser.
          </p>
        </form>
      </div>
    </div>
  );
}

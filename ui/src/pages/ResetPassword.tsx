import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../components/Button";

/**
 * Landing page for the emailed reset link (/reset-password?token=…). On
 * success every existing session is revoked server-side and the user signs
 * in fresh with the new password.
 */
export function ResetPassword() {
  const { baseUrl } = useAuth();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/v1/auth/password/reset`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError(
          body.code === "invalid_token"
            ? "This reset link is invalid, expired, or already used. Request a new one."
            : typeof body.error === "string"
              ? body.error
              : "Could not reset the password. Please try again.",
        );
        return;
      }
      setDone(true);
    } catch {
      setError("Could not reach the server. Please try again.");
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
            <h1 className="m-0 text-xl font-semibold tracking-tight">Choose a new password</h1>
            <p className="mt-1 text-sm text-muted">For your CompanyOS operator account</p>
          </div>
        </div>

        {done ? (
          <div className="rounded-xl border border-border bg-surface p-6 text-sm shadow-md">
            <div className="flex items-start gap-2 rounded-md border border-good/40 bg-good-bg/60 p-2.5 text-good">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                Password updated. You've been signed out everywhere — sign in with your new
                password.
              </span>
            </div>
            <p className="mt-4 mb-0 text-center">
              <Link to="/login" className="text-accent">
                Go to sign in
              </Link>
            </p>
          </div>
        ) : !token ? (
          <div className="rounded-xl border border-border bg-surface p-6 text-sm shadow-md">
            <p className="m-0">
              This page needs a reset link.{" "}
              <Link to="/forgot-password" className="text-accent">
                Request a new one
              </Link>
              .
            </p>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-md"
          >
            <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
              New password (min 8 characters)
              <input
                type="password"
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
              Confirm new password
              <input
                type="password"
                className="input"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                minLength={8}
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
              {busy ? "Updating…" : "Update password"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertCircle } from "lucide-react";
import { useAuth, type AuthCompletion } from "../auth/AuthContext";
import { Button } from "../components/Button";

/**
 * Landing page for the emailed invite link (/accept-invite?token=…). The new
 * team member sets their own password; on success the server responds with a
 * live session (same shape as login), so they land in the console signed in.
 */
export function AcceptInvite() {
  const { baseUrl, completeAuth } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";

  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
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
      const res = await fetch(`${baseUrl}/v1/auth/invite/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          password,
          display_name: displayName.trim() || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(
          body.code === "invalid_token"
            ? "This invite link is invalid, expired, or already used. Ask your admin to send a new one."
            : typeof body.error === "string"
              ? body.error
              : "Could not accept the invitation. Please try again.",
        );
        return;
      }
      completeAuth(body as unknown as AuthCompletion);
      navigate("/");
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
            <h1 className="m-0 text-xl font-semibold tracking-tight">Join your team on CompanyOS</h1>
            <p className="mt-1 text-sm text-muted">Set a password to activate your account</p>
          </div>
        </div>

        {!token ? (
          <div className="rounded-xl border border-border bg-surface p-6 text-sm shadow-md">
            <p className="m-0">
              This page needs an invite link. Check the invitation email from your admin, or ask
              them to send a new one.
            </p>
            <p className="mt-3 mb-0">
              Already have an account?{" "}
              <Link to="/login" className="text-accent">
                Sign in
              </Link>
            </p>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-md"
          >
            <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
              Your name (optional)
              <input
                className="input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
              Password (min 8 characters)
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
              Confirm password
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
              {busy ? "Activating…" : "Set password & sign in"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

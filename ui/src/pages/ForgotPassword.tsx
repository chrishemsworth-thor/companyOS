import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { MailCheck } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { Button } from "../components/Button";

/**
 * Request a password-reset link. The server always answers 200 whether or not
 * the account exists (anti-enumeration), so the page always shows the same
 * "check your inbox" confirmation.
 */
export function ForgotPassword() {
  const { baseUrl } = useAuth();
  const [workspace, setWorkspace] = useState("");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await fetch(`${baseUrl}/v1/auth/password/forgot`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: workspace.trim(), email: email.trim() }),
      });
      setSent(true);
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
            <h1 className="m-0 text-xl font-semibold tracking-tight">Forgot your password?</h1>
            <p className="mt-1 text-sm text-muted">We'll email you a reset link</p>
          </div>
        </div>

        {sent ? (
          <div className="rounded-xl border border-border bg-surface p-6 text-sm shadow-md">
            <div className="flex items-start gap-2 rounded-md border border-good/40 bg-good-bg/60 p-2.5 text-good">
              <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                If that account exists, we've sent a reset link to <strong>{email}</strong>. The
                link expires in 60 minutes.
              </span>
            </div>
            <p className="mt-4 mb-0 text-center">
              <Link to="/login" className="text-accent">
                Back to sign in
              </Link>
            </p>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-6 shadow-md"
          >
            <label className="flex flex-col gap-1.5 text-sm font-medium text-fg">
              Company workspace
              <input
                type="text"
                className="input"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                placeholder="e.g. acme"
                autoComplete="organization"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </label>
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

            {error && (
              <div
                role="alert"
                className="rounded-md border border-bad/40 bg-bad-bg/60 p-2.5 text-sm text-bad"
              >
                {error}
              </div>
            )}

            <Button type="submit" variant="primary" loading={busy} className="mt-1 w-full">
              {busy ? "Sending…" : "Send reset link"}
            </Button>

            <p className="m-0 text-center text-xs text-subtle">
              <Link to="/login" className="text-accent">
                Back to sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

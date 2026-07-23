import { useState } from "react";
import { Check, Copy, MailCheck } from "lucide-react";
import { Button } from "./Button";

/** The invite block returned by POST /v1/users and /v1/users/:id/resend-invite. */
export interface InviteInfo {
  emailed: boolean;
  provider: string | null;
  expires_at: string;
  invite_url: string;
}

/**
 * Shows the outcome of issuing an invite: a confirmation when the invite was
 * emailed, and always the single-use accept link so the admin can hand it
 * over out-of-band (the only path when the tenant has no email transport).
 */
export function InvitePanel({ email, invite }: { email: string; invite: InviteInfo }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite.invite_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be unavailable (http, permissions) — the link is
      // visible below, so manual selection still works.
    }
  };

  const expires = new Date(invite.expires_at).toLocaleString();

  return (
    <div className="flex flex-col gap-3">
      {invite.emailed ? (
        <div className="flex items-start gap-2 rounded-md border border-good/40 bg-good-bg/60 p-2.5 text-sm text-good">
          <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            Invite emailed to <strong>{email}</strong>. The link below is the same single-use
            invitation, in case they can't find the email.
          </span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-border bg-surface-2 p-2.5 text-sm">
          <span>
            No email was sent (email delivery isn't configured yet) — copy this single-use invite
            link and share it with <strong>{email}</strong> yourself.
          </span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input className="input flex-1" readOnly value={invite.invite_url} onFocus={(e) => e.target.select()} />
        <Button
          type="button"
          onClick={copy}
          icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="m-0 text-xs text-muted">
        The link lets them set their own password. It can be used once and expires {expires}.
      </p>
    </div>
  );
}

import { buttonHtml, escapeHtml, wrapHtml } from "./layout";

/**
 * User-lifecycle email content. Plain typed functions returning the composed
 * subject/text/html — no template engine. Every template must provide a
 * complete text body: the html part is an enhancement, never the only copy.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function userInviteEmail(p: {
  tenantName: string;
  inviterName?: string;
  acceptUrl: string;
  expiresDays: number;
}): RenderedEmail {
  const invitedBy = p.inviterName
    ? `${p.inviterName} has invited you to join`
    : "You have been invited to join";
  const subject = `You've been invited to ${p.tenantName} on CompanyOS`;
  const text =
    `${invitedBy} ${p.tenantName} on CompanyOS.\n\n` +
    `Set your password and sign in here (link valid for ${p.expiresDays} days, single use):\n` +
    `${p.acceptUrl}\n\n` +
    `If you weren't expecting this invitation, you can ignore this email.`;
  const html = wrapHtml({
    title: `Join ${p.tenantName} on CompanyOS`,
    bodyHtml:
      `<p>${escapeHtml(invitedBy)} <strong>${escapeHtml(p.tenantName)}</strong> on CompanyOS.</p>` +
      buttonHtml(p.acceptUrl, "Set your password") +
      `<p style="font-size:13px;color:#6b7280;">This link is valid for ${p.expiresDays} days and can only be used once.</p>`,
    footerText: "If you weren't expecting this invitation, you can ignore this email.",
  });
  return { subject, text, html };
}

export function passwordResetEmail(p: {
  tenantName: string;
  resetUrl: string;
  expiresMinutes: number;
}): RenderedEmail {
  const subject = `Reset your ${p.tenantName} password`;
  const text =
    `We received a request to reset your ${p.tenantName} password on CompanyOS.\n\n` +
    `Choose a new password here (link valid for ${p.expiresMinutes} minutes, single use):\n` +
    `${p.resetUrl}\n\n` +
    `If you didn't request this, you can ignore this email — your password is unchanged.`;
  const html = wrapHtml({
    title: "Reset your password",
    bodyHtml:
      `<p>We received a request to reset your <strong>${escapeHtml(p.tenantName)}</strong> password on CompanyOS.</p>` +
      buttonHtml(p.resetUrl, "Choose a new password") +
      `<p style="font-size:13px;color:#6b7280;">This link is valid for ${p.expiresMinutes} minutes and can only be used once.</p>`,
    footerText: "If you didn't request this, you can ignore this email — your password is unchanged.",
  });
  return { subject, text, html };
}

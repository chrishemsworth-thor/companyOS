import type { Env } from "../env";
import { getUserById } from "./users";
import { INVITE_TTL_SECONDS, issueUserToken } from "./tokens";
import { DeliveryError, sendEmail } from "../delivery/dispatch";
import { userInviteEmail } from "../delivery/templates/user-emails";
import { acceptInvitePath, consoleBaseUrl } from "../delivery/templates/links";

/**
 * Issuing a platform invite: mint a single-use token and email the accept
 * link. Shared by the two surfaces that can grant console access — admin user
 * management (/v1/users) and inviting an existing employee
 * (/v1/people/employees/:id/invite) — so both produce an identical invite.
 */

export interface InviteResult {
  /** False when nothing real was sent (console provider or a send failure). */
  emailed: boolean;
  provider: string | null;
  expires_at: string;
  /**
   * The single-use accept link. Returned to the admin so they can hand it over
   * out-of-band when the tenant has no email transport configured.
   */
  invite_url: string;
}

/**
 * Issue a fresh invite for an existing user and try to email it. A send
 * failure never throws: the account exists either way and the caller still
 * gets a usable link, so a broken mail provider can't wedge onboarding.
 * Re-issuing invalidates any previous live invite for that user.
 */
export async function issueAndSendInvite(
  env: Env,
  tenantId: string,
  input: { user_id: string; email: string; inviter_user_id?: string },
): Promise<InviteResult> {
  const { raw, expires_at } = await issueUserToken(env.DB, {
    tenant_id: tenantId,
    user_id: input.user_id,
    purpose: "invite",
    ttlSeconds: INVITE_TTL_SECONDS,
    created_by: input.inviter_user_id,
  });
  const invite_url = consoleBaseUrl(env) + acceptInvitePath(raw);

  const inviter = input.inviter_user_id
    ? ((await getUserById(env.DB, tenantId, input.inviter_user_id))?.display_name ?? undefined)
    : undefined;
  const tenantRow = await env.DB.prepare("SELECT name FROM tenants WHERE tenant_id = ?")
    .bind(tenantId)
    .first<{ name: string }>();

  const rendered = userInviteEmail({
    tenantName: tenantRow?.name ?? "your workspace",
    inviterName: inviter,
    acceptUrl: invite_url,
    expiresDays: INVITE_TTL_SECONDS / 86_400,
  });

  try {
    const { provider } = await sendEmail(env, tenantId, {
      to: input.email,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      purpose: "user_invite",
      refs: { user_id: input.user_id },
    });
    // The console provider "sends" by logging — report that as not-emailed so
    // the UI offers the copyable link instead of claiming mail is on its way.
    return { emailed: provider !== "console", provider, expires_at, invite_url };
  } catch (err) {
    if (!(err instanceof DeliveryError)) throw err;
    return { emailed: false, provider: null, expires_at, invite_url };
  }
}

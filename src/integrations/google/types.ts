/**
 * Google (Gmail/Workspace) integration domain types and scope constants.
 *
 * The integration lives outside src/delivery/ (static-secret, outbound-only
 * providers) and src/webhooks/ (provider-initiated, signature-verified push)
 * because it needs an OAuth token lifecycle plus — in a later phase — inbound
 * read. See docs/modules/google.md.
 */

export type GoogleAccountKind = "shared" | "user";

export type GoogleAccountStatus = "active" | "revoked" | "error";

/** Send-only: mint and send messages, but cannot read the mailbox. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** Read-only mailbox access (Phase 2 inbound sync). */
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
/** Read + modify (labels/archive). Only requested when a concrete need exists. */
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/**
 * Identity scopes always requested alongside the Gmail scopes so the callback
 * can learn which mailbox was connected (email) and bind it to Google's stable
 * subject id (sub) rather than the mutable address.
 */
export const IDENTITY_SCOPES = ["openid", "email"];

/** The access levels a caller can request when connecting an account. */
export type GoogleAccess = "send" | "send_and_read";

/** Resolve a requested access level to the Gmail scopes it needs. */
export function gmailScopesFor(access: GoogleAccess): string[] {
  return access === "send_and_read"
    ? [GMAIL_SEND_SCOPE, GMAIL_READONLY_SCOPE]
    : [GMAIL_SEND_SCOPE];
}

/** True when the granted scope string includes `scope`. */
export function hasScope(grantedScopes: string, scope: string): boolean {
  return grantedScopes.split(/\s+/).filter(Boolean).includes(scope);
}

/** A connected Google account (google_accounts row, migration 0015). */
export interface GoogleAccount {
  account_id: string;
  tenant_id: string;
  kind: GoogleAccountKind;
  user_id: string | null;
  label: string | null;
  google_email: string;
  google_sub: string | null;
  scopes: string;
  history_id: string | null;
  status: GoogleAccountStatus;
  last_error: string | null;
  connected_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Columns safe to return over the API. Deliberately excludes
 * refresh_token_ciphertext / refresh_token_iv / enc_key_version — token
 * material never leaves the Worker.
 */
export const ACCOUNT_PUBLIC_COLUMNS =
  "account_id, tenant_id, kind, user_id, label, google_email, google_sub, scopes, history_id, status, last_error, connected_by_user_id, created_at, updated_at";

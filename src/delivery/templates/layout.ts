/**
 * Minimal HTML email shell. Transactional mail here is deliberately simple:
 * inline styles only (email clients strip <style> blocks unpredictably), no
 * images, no external assets — everything renders identically on Workers.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function wrapHtml(input: { title: string; bodyHtml: string; footerText: string }): string {
  return (
    `<div style="margin:0;padding:24px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:8px;padding:32px;border:1px solid #e4e6ea;">` +
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;color:#111827;">${escapeHtml(input.title)}</h1>` +
    `<div style="font-size:15px;line-height:1.6;color:#374151;">${input.bodyHtml}</div>` +
    `</div>` +
    `<p style="max-width:560px;margin:16px auto 0;font-size:12px;line-height:1.5;color:#6b7280;text-align:center;">${escapeHtml(input.footerText)}</p>` +
    `</div>`
  );
}

/** A prominent, bulletproof-enough CTA link button. */
export function buttonHtml(url: string, label: string): string {
  return (
    `<p style="margin:24px 0;">` +
    `<a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;padding:10px 20px;border-radius:6px;">${escapeHtml(label)}</a>` +
    `</p>` +
    `<p style="font-size:13px;color:#6b7280;">Or paste this link into your browser:<br/><a href="${escapeHtml(url)}" style="color:#2563eb;word-break:break-all;">${escapeHtml(url)}</a></p>`
  );
}

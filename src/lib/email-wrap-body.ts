// src/lib/email-wrap-body.ts
export const buildEmailHtml = (
  body: string,
  influencerName: string | undefined,
  senderEmail: string,
  senderName?: string,
  recipientEmail?: string,
  warmupDay: number = 0,
  unsubscribeUrl?: string // optional https unsubscribe page
): string => {
  const safeBodyHtml = String(body || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "<br>");
  const fromName =
    (senderName && String(senderName).trim()) ||
    (senderEmail || "").split("@")[0] ||
    "Team";
  const recipientDomain =
    (recipientEmail || "").split("@").pop()?.toLowerCase() || "";

  const WARMUP_NO_FOOTER_PROVIDERS = [
    "mail.ru",
    "yandex.ru",
    "rambler.ru",
    "bk.ru",
    "gmail.com",
    "googlemail.com",
  ];
  const isGmail = ["gmail.com", "googlemail.com"].includes(recipientDomain);
  const skipFooterForProvider =
    WARMUP_NO_FOOTER_PROVIDERS.includes(recipientDomain) &&
    !(isGmail && warmupDay >= 15);

  // prefer mailto during warmup; https unsubscribe page optional
  const unsubscribeMailto = `mailto:${encodeURIComponent(
    process.env.MAILGUN_REPLY_TO_EMAIL || senderEmail
  )}?subject=Unsubscribe`;
  const unsubscribeVisibleHref =
    unsubscribeUrl && unsubscribeUrl.startsWith("http")
      ? unsubscribeUrl
      : undefined;

  const preheaderText =
    "Let’s discuss a potential collaboration — quick reply is appreciated.";

  // Put visible unsubscribe inside the white card and center it; keep it small & muted.
  const visibleUnsubscribeHtml = !skipFooterForProvider
    ? `
    <tr>
      <td style="padding:10px 28px 22px 28px;background:#ffffff;text-align:center;">
        <div style="font-size:12px;color:#9aa0a6;">
          Reply to this email to continue the conversation.
          &nbsp;|&nbsp;
          <a href="${escapeHtml(
            unsubscribeVisibleHref || unsubscribeMailto
          )}" style="color:#6b7280;text-decoration:none;">Unsubscribe</a>
        </div>
      </td>
    </tr>
  `
    : "";

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Helvetica,Arial,sans-serif;color:#111111;">
  <span style="display:none;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;">${escapeHtml(
    preheaderText
  )}</span>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;width:100%;">
    <tr>
      <td align="center" style="padding:20px 12px;">
        <table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px;max-width:680px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr><td style="padding:22px 28px;font-size:15px;line-height:1.6;color:#111827;">
            ${safeBodyHtml}

            <div style="margin-top:18px;padding-top:14px;border-top:1px solid #eef2f7;">
              <div style="font-weight:600;color:#111827;font-size:15px;margin-top:8px;">${escapeHtml(
                fromName
              )}</div>
              <div style="color:#6b7280;font-size:13px;margin-top:4px;">IMX — Partnerships</div>
            </div>
          </td></tr>

          ${visibleUnsubscribeHtml}

        </table>
      </td>
    </tr>
  </table>

  <div style="display:none; white-space:nowrap; font:15px/1px monospace;">&nbsp; &nbsp; &nbsp;</div>
</body>
</html>`;
};

// helper
function escapeHtml(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

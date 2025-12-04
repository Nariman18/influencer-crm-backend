// src/lib/email-wrap-body.ts
export const buildEmailHtml = (
  body: string,
  influencerName: string | undefined,
  senderEmail: string,
  senderName?: string,
  recipientEmail?: string,
  warmupDay: number = 0,
  unsubscribeUrl?: string
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

  const unsubscribeMailto = `mailto:${encodeURIComponent(
    process.env.MAILGUN_REPLY_TO_EMAIL || senderEmail
  )}?subject=Unsubscribe`;
  const unsubscribeHref = unsubscribeUrl?.startsWith("http")
    ? unsubscribeUrl
    : undefined;
  const unsubscribeVisibleHref = unsubscribeHref || unsubscribeMailto;

  const preheaderText =
    "Let’s discuss a potential collaboration! Quick reply is appreciated.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta http-equiv="x-ua-compatible" content="IE=edge">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Message from ${escapeHtml(fromName)}</title>
<style>
  @media only screen and (max-width:600px) {
    .container { width:100% !important; }
    .content-padding { padding:16px !important; }
  }
  .preheader { display:none !important; visibility:hidden; mso-hide:all; font-size:1px; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; }
</style>
</head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Helvetica,Arial,sans-serif;color:#111111;">
  <span class="preheader">${escapeHtml(preheaderText)}</span>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;width:100%;min-width:320px;">
    <tr>
      <td align="center" style="padding:20px 12px;">
        <table role="presentation" class="container" width="680" cellpadding="0" cellspacing="0" style="width:680px;max-width:680px;background:#ffffff;border-radius:8px;overflow:hidden;">
          <tr><td style="padding:18px 22px 0 22px;background:#ffffff;"></td></tr>
          <tr>
            <td class="content-padding" style="padding:22px 28px 10px 28px;font-size:15px;line-height:1.6;color:#111827;">
              ${safeBodyHtml}
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
                <tr>
                  <td style="padding-top:14px;border-top:1px solid #eef2f7;">
                    <div style="font-weight:600;color:#111827;font-size:15px;margin-top:8px;">${escapeHtml(
                      fromName
                    )}</div>
                    <div style="color:#6b7280;font-size:13px;margin-top:4px;">IMX — Partnerships</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="padding:0 28px 10px 28px;background:#ffffff;"></td></tr>
        </table>

        ${
          !skipFooterForProvider
            ? `<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px;max-width:680px;margin-top:12px;">
                 <tr>
                   <td align="center" style="padding:12px 20px;background:transparent;color:#9aa0a6;font-size:12px;">
                     Reply to this email to continue the conversation.
                     &nbsp;|&nbsp;
                     <a href="${escapeHtml(
                       unsubscribeVisibleHref
                     )}" style="color:#6b7280;text-decoration:none;display:inline-block;padding:6px 8px;border-radius:4px;border:1px solid transparent;" ${
                unsubscribeHref
                  ? 'target="_blank" rel="noopener noreferrer"'
                  : ""
              }>Unsubscribe</a>
                   </td>
                 </tr>
               </table>`
            : `<!-- footer removed during warmup for ${recipientDomain} (day=${warmupDay}) -->`
        }

      </td>
    </tr>
  </table>

  <div style="display:none; white-space:nowrap; font:15px/1px monospace;">&nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp;</div>
</body>
</html>`;
};

/** helper: simple escaping for title / attributes (keep minimal) */
function escapeHtml(s: string) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

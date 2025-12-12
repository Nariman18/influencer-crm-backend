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

  const preheaderText = "Quick note — reply if you're interested.";

  // basic unsubscribe (mailto) fallback
  const unsubscribeMailto = `mailto:${encodeURIComponent(
    process.env.MAILGUN_REPLY_TO_EMAIL || senderEmail
  )}?subject=Unsubscribe`;

  const visibleUnsubscribeHtml =
    unsubscribeUrl && unsubscribeUrl.startsWith("http")
      ? `<tr><td style="padding:12px 20px;text-align:center;"><div style="font-size:12px;color:#9aa0a6;">If you'd like to stop receiving these emails, <a href="${escapeHtml(
          unsubscribeUrl
        )}" style="color:#6b7280;text-decoration:none;">unsubscribe</a>.</div></td></tr>`
      : `<tr><td style="padding:12px 20px;text-align:center;"><div style="font-size:12px;color:#9aa0a6;">Reply to this message with "Unsubscribe" or <a href="${escapeHtml(
          unsubscribeMailto
        )}" style="color:#6b7280;text-decoration:none;">click to unsubscribe</a>.</div></td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111111;">
  <!-- Hidden preheader text -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(
    preheaderText
  )}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;width:100%;">
    <tr>
      <td align="center" style="padding:24px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
          <tr>
            <td style="padding:20px;font-size:16px;line-height:1.5;color:#111111;">
              ${safeBodyHtml}

              <div style="margin-top:18px;padding-top:14px;border-top:1px solid #eef2f7;">
                <div style="font-weight:600;color:#111827;font-size:15px;margin-top:8px;">${escapeHtml(
                  fromName
                )}</div>
                <div style="color:#6b7280;font-size:13px;margin-top:4px;">IMX Agency</div>
              </div>
            </td>
          </tr>

          ${visibleUnsubscribeHtml}

        </table>
      </td>
    </tr>
  </table>
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

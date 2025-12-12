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

  const preheaderText = "Quick note - reply if you're interested.";

  // Very small, minimal HTML email wrapper (no visible unsubscribe, minimal inline styles)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
</head>
<body style="margin:0;padding:0;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111111;">
  <!-- hidden preheader -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(
    preheaderText
  )}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="width:100%;background:#ffffff;">
    <tr>
      <td align="center" style="padding:18px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;">
          <tr>
            <td style="padding:12px 10px;font-size:16px;line-height:1.45;color:#111111;">
              ${safeBodyHtml}
              <div style="margin-top:18px;font-size:14px;color:#111111;">
                <div style="font-weight:600;">${escapeHtml(fromName)}</div>
                <div style="font-size:13px;color:#666666;margin-top:4px;">${escapeHtml(
                  senderEmail
                )}</div>
              </div>
            </td>
          </tr>
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

// typescript
export const buildEmailHtml = (
  body: string,
  influencerName: string | undefined,
  senderEmail: string,
  senderName?: string,
  recipientEmail?: string,
  warmupDay: number = 0 // сколько дней прошло в прогреве
): string => {
  // safety
  const safeBodyHtml = String(body || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "<br>");
  const fromName =
    (senderName && String(senderName).trim()) ||
    (senderEmail || "").split("@")[0] ||
    "Team";
  const recipientDomain =
    (recipientEmail || "").split("@").pop()?.toLowerCase() || "";

  // провайдеры без футера во время прогрева
  const WARMUP_NO_FOOTER_PROVIDERS = [
    "mail.ru",
    "yandex.ru",
    "rambler.ru",
    "bk.ru",
    "gmail.com",
    "googlemail.com",
  ];

  const isGmail = ["gmail.com", "googlemail.com"].includes(recipientDomain);
  // для Gmail включаем footer только если прошло >= 15 дней
  const skipFooterForProvider =
    WARMUP_NO_FOOTER_PROVIDERS.includes(recipientDomain) &&
    !(isGmail && warmupDay >= 15);

  const unsubscribeLink = `mailto:${encodeURIComponent(
    process.env.MAILGUN_REPLY_TO_EMAIL || senderEmail
  )}?subject=Unsubscribe`;

  // короткий preheader — виден в почтовых клиентах и улучшает доставляемость
  const preheaderText =
    "Let’s discuss a potential collaboration — quick reply is appreciated.";

  // Table-based, inline styles, минимальные head-styles для мобильной
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta http-equiv="x-ua-compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Message from ${fromName}</title>
    <style>
      /* keep only small mobile helpers — most styling is inline for compatibility */
      @media only screen and (max-width:600px) {
        .container { width:100% !important; }
        .content-padding { padding:16px !important; }
      }
      /* hide preheader visually but keep it for inbox preview */
      .preheader { display:none !important; visibility:hidden; mso-hide:all; font-size:1px; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; }
    </style>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:Helvetica,Arial,sans-serif;color:#111111;">
    <!-- preheader -->
    <span class="preheader">${preheaderText}</span>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;width:100%;min-width:320px;">
      <tr>
        <td align="center" style="padding:20px 12px;">
          <!-- container -->
          <table role="presentation" class="container" width="680" cellpadding="0" cellspacing="0" style="width:680px;max-width:680px;background:#ffffff;border-radius:8px;overflow:hidden;">
            <!-- header space -->
            <tr>
              <td style="padding:18px 22px 0 22px;background:#ffffff;"></td>
            </tr>

            <!-- content -->
            <tr>
              <td class="content-padding" style="padding:22px 28px 10px 28px;font-size:15px;line-height:1.6;color:#111827;">
                ${safeBodyHtml}
                <!-- signature block -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:18px;">
                  <tr>
                    <td style="padding-top:14px;border-top:1px solid #eef2f7;">
                      <div style="font-weight:600;color:#111827;font-size:15px;margin-top:8px;">${fromName}</div>
                      <div style="color:#6b7280;font-size:13px;margin-top:4px;">IMX — Partnerships</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- small spacer -->
            <tr>
              <td style="padding:0 28px 10px 28px;background:#ffffff;"></td>
            </tr>
          </table>

          <!-- footer area (outside main white card to avoid clipping in some clients) -->
          ${
            !skipFooterForProvider
              ? `<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="width:680px;max-width:680px;margin-top:12px;">
                  <tr>
                    <td align="center" style="padding:12px 20px;background:transparent;color:#9aa0a6;font-size:12px;">
                      Reply to this email to continue the conversation.
                      &nbsp;|&nbsp;
                      <a href="${unsubscribeLink}" style="color:#6b7280;text-decoration:none;">Unsubscribe</a>
                    </td>
                  </tr>
                </table>`
              : `<!-- footer intentionally removed for warm-up recipient=${recipientDomain} warmupDay=${warmupDay} -->`
          }

        </td>
      </tr>
    </table>

    <!-- Outlook specific fix -->
    <div style="display:none; white-space:nowrap; font:15px/1px monospace;">&nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp; &nbsp;</div>
  </body>
</html>`;
};

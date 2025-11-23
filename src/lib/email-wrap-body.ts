// src/lib/email-wrap-body.ts
export const normalizeBodyToHtml = (body: string): string => {
  if (!body) return "";
  return String(body).replace(/\r\n/g, "\n").replace(/\n/g, "<br>");
};

export const buildEmailHtml = (
  body: string,
  influencerName: string,
  senderEmail: string,
  senderName?: string
): string => {
  const safeBodyHtml = normalizeBodyToHtml(body || "");

  // ✅ Using sender's actual name instead of generic text or email username
  const fromName = senderName || senderEmail.split("@")[0];

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
      body { 
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        color: #1f2937; 
        background: #f9fafb; 
        margin: 0; 
        padding: 20px;
        line-height: 1.6;
      }
      
      .email-container { 
        max-width: 600px; 
        margin: 0 auto; 
        background: #ffffff; 
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 2px 8px rgba(0,0,0,0.05);
      }
      
      .email-content { 
        padding: 32px 28px;
        color: #374151; 
        font-size: 15px;
      }
      
      .email-body {
        color: #1F2937;
        line-height: 1.7;
        margin-bottom: 24px;
      }
      
      .signature { 
        margin-top: 32px;
        padding-top: 24px;
        border-top: 1px solid #E5E7EB;
        color: #6B7280; 
        font-size: 14px;
      }
      
      .signature-name {
        color: #1F2937;
        font-weight: 600;
        margin: 8px 0;
      }
      
      .footer {
        background: #f9fafb;
        padding: 20px 28px;
        text-align: center;
        font-size: 12px;
        color: #9CA3AF;
        border-top: 1px solid #E5E7EB;
      }
      
      @media (max-width: 600px) {
        body {
          padding: 12px;
        }
        
        .email-content { 
          padding: 24px 20px;
        }
        
        .footer {
          padding: 16px 20px;
        }
      }
    </style>
  </head>
  <body>
    <div class="email-container">
      <div class="email-content">
        <div class="email-body">
          ${safeBodyHtml}
        </div>

        <div class="signature">
          <p style="margin: 0 0 8px 0;">Best regards,</p>
          <p class="signature-name">${fromName}</p>
        </div>
      </div>

      <div class="footer">
        <p style="margin: 0; font-size: 11px; color: #9CA3AF;">
          Reply directly to this email to continue the conversation.
        </p>
      </div>
    </div>
  </body>
</html>`;
};

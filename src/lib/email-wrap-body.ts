export const normalizeBodyToHtml = (body: string): string => {
  if (!body) return "";
  return String(body).replace(/\r\n/g, "\n").replace(/\n/g, "<br>");
};

export const buildEmailHtml = (
  body: string,
  influencerName: string,
  senderEmail: string
): string => {
  const safeBodyHtml = normalizeBodyToHtml(body || "");

  const mailtoHref = `mailto:${encodeURIComponent(senderEmail || "")}`;

  // Enhanced Gmail URL with better compatibility
  const gmailComposeHref = `https://mail.google.com/mail/u/0/?view=cm&fs=1&to=${encodeURIComponent(
    senderEmail || ""
  )}&su=Re:%20Influencer%20Collaboration`;

  return `<!DOCTYPE html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <style>
        /* Base styles with consistent colors */
        body { 
          font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif; 
          color: #111827; 
          background: #f9fafb; 
          margin: 0; 
          padding: 0; 
          -webkit-text-size-adjust: 100%;
          -ms-text-size-adjust: 100%;
        }
        
        .container { 
          max-width: 680px; 
          margin: 18px auto; 
          background: #ffffff; 
          border-radius: 8px; 
          overflow: hidden; 
          box-shadow: 0 6px 18px rgba(2,6,23,0.06); 
        }
        
        .header { 
          background: #dc2626; 
          color: #ffffff; 
          padding: 24px; 
          text-align: center; 
        }
        
        .header h2 { 
          margin: 0; 
          font-size: 22px; 
          font-weight: 600;
          letter-spacing: -0.2px; 
        }
        
        .content { 
          padding: 28px 24px; 
          color: #374151; 
          font-size: 15px; 
          line-height: 1.6; 
        }
        
        /* CTA section with email-compatible spacing */
        .cta { 
          margin: 24px 0; 
        }
        
        .button-container {
          display: inline-block;
          width: 100%;
        }
        
        /* Button styles with explicit colors and email-compatible spacing */
        .btn { 
          display: inline-block; 
          text-decoration: none; 
          padding: 12px 20px; 
          border-radius: 6px; 
          font-weight: 600; 
          font-size: 14px; 
          text-align: center;
          border: none;
        }
        
        /* Gmail button - gray-600 (#4B5563) */
        .btn-gmail { 
          background: #4B5563; 
          color: #ffffff; 
          margin-right: 16px; /* Email-compatible spacing */
        }
        
        /* Mail button - red (#DC2626) */
        .btn-mail { 
          background: #DC2626; 
          color: #ffffff; 
        }

         .btn-gmail:hover {
          background: #374151 !important;
        }
          
        .btn-mail:hover {
          background: #B91C1C !important;
        }

        .signature { 
          margin-top: 24px; 
          border-top: 1px solid #E5E7EB; 
          padding-top: 20px; 
          color: #6B7280; 
          font-size: 14px; 
        }
        
        .content-body {
          color: #1F2937;
          line-height: 1.7;
        }
        
        /* Mobile responsiveness */
        @media (max-width: 600px) {
          .container { 
            margin: 12px; 
            border-radius: 6px; 
          }
          
          .content { 
            padding: 20px 16px; 
          }
          
          .header { 
            padding: 20px 16px; 
          }
          
          .header h2 {
            font-size: 20px;
          }
          
          .btn-gmail {
            margin-right: 0;
            margin-bottom: 12px;
            display: block;
          }
          
          .btn-mail {
            display: block;
          }
          
          .btn {
            width: 100%;
            padding: 14px 16px;
            font-size: 15px;
            box-sizing: border-box;
          }
        }
        
        /* Dark mode support for email clients that support it */
        @media (prefers-color-scheme: dark) {
          .container {
            background: #1F2937;
            color: #F9FAFB;
          }
          .content {
            color: #F9FAFB;
          }
          .content-body {
            color: #F9FAFB;
          }
          .signature {
            border-top-color: #4B5563;
            color: #D1D5DB;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>Influencer Collaboration</h2>
        </div>

        <div class="content">
          <div class="content-body">
            ${safeBodyHtml}
          </div>

          <div class="cta">
            <div class="button-container">
              <a class="btn btn-gmail" href="${gmailComposeHref}" target="_blank" rel="noopener noreferrer" 
                 onclick="window.open('${gmailComposeHref}', '_blank', 'noopener,noreferrer'); return false;"
                 style="background: #4B5563; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block; margin-right: 16px;">
                Reply via Gmail
              </a>

              <a class="btn btn-mail" href="${mailtoHref}" 
                 style="background: #DC2626; color: #ffffff; text-decoration: none; padding: 12px 20px; border-radius: 6px; font-weight: 600; font-size: 14px; display: inline-block;">
                Reply via email
              </a>
            </div>
            
            <!-- Help text for Gmail app users -->
            <div style="margin-top: 12px; font-size: 12px; color: #6B7280;">
              <p style="margin: 0;">If "Reply via Gmail" doesn't work in the Gmail app, use "Reply via Email" instead.</p>
            </div>
          </div>

          <div class="signature">
            <p style="margin: 0 0 8px 0;">Best regards,</p>
            <p style="margin: 0 0 12px 0; font-weight: 600;">Influencer CRM Team</p>
            <p style="margin: 0; font-size: 13px; color: #9CA3AF;">If you'd prefer to reply using another email client, click "Reply via email".</p>
          </div>
        </div>

        <!-- Footer with inline styles for Gmail compatibility -->
        <div style="background: #111827; color: #ffffff; padding: 20px 24px; text-align: center; font-size: 12px; line-height: 1.5;">
          <p style="margin: 0 0 8px 0;">This email was sent to <span style="color: #DC2626; font-weight: 600;">${
            influencerName || ""
          }</span> via Influencer CRM Platform</p>
          <p style="margin: 0;">© ${new Date().getFullYear()} Influencer CRM. All rights reserved.</p>
        </div>
      </div>

      <script>
        // Fallback for Gmail links in email clients that support JavaScript
        document.addEventListener('DOMContentLoaded', function() {
          const gmailLinks = document.querySelectorAll('a[href*="mail.google.com"]');
          gmailLinks.forEach(link => {
            link.addEventListener('click', function(e) {
              // Force open in new tab for better UX
              window.open(this.href, '_blank', 'noopener,noreferrer');
              e.preventDefault();
            });
          });
        });
      </script>
    </body>
  </html>`;
};

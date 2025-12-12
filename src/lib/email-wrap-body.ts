export const buildEmailHtml = (
  body: string,
  senderEmail: string,
  senderName?: string
): string => {
  const safeBody = String(body || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n/g, "<br>");

  const fromName =
    (senderName && senderName.trim()) || senderEmail.split("@")[0] || "Team";

  return `
<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; font-size: 15px; color: #000; background: #fff; margin: 0; padding: 0;">
    ${safeBody}
    <br><br>
    ${fromName}<br>
    ${senderEmail}
  </body>
</html>`;
};

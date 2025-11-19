// Load environment variables from .env.server
require("dotenv").config({ path: ".env.server" });

const nodemailer = require("nodemailer");

const host = process.env.MAILGUN_SMTP_HOST || "smtp.mailgun.org";
const port = Number(process.env.MAILGUN_SMTP_PORT || 587);
const secure = String(process.env.MAILGUN_SMTP_SECURE || "false") === "true";
const user = process.env.MAILGUN_SMTP_USER;
const pass = process.env.MAILGUN_SMTP_PASSWORD;

const from = process.env.MAILGUN_FROM_EMAIL || user;
const to = process.env.TEST_RECIPIENT || "aliyevnariman98@gmail.com";

(async () => {
  if (!user || !pass) {
    console.error("SMTP_USER or SMTP_PASSWORD missing");
    console.log({ user, pass });
    process.exit(1);
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });

  try {
    const info = await transporter.sendMail({
      from: `"Test" <${from}>`,
      to,
      subject: "SMTP test from Mailgun",
      html: "<p>This is a test email via Mailgun SMTP</p>",
    });

    console.log("SMTP send success:", info);
    process.exit(0);
  } catch (err) {
    console.error("SMTP send failed:", err);
    process.exit(2);
  }
})();

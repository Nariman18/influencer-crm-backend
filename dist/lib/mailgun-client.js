"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendMailgunEmail = void 0;
// src/lib/mailgun-client.ts
const axios_1 = __importDefault(require("axios"));
const mailgun_smtp_1 = require("./mailgun-smtp");
const API_KEY = process.env.MAILGUN_API_KEY || "";
const DOMAIN = process.env.MAILGUN_DOMAIN || "";
const BASE = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net/v3";
const FROM_EMAIL = process.env.MAILGUN_FROM_EMAIL || "";
const FROM_NAME = process.env.MAILGUN_FROM_NAME || "Influencer CRM";
/** SMTP fallback considered "configured" when all three vars are present */
const SMTP_CONFIGURED = Boolean(process.env.MAILGUN_SMTP_HOST) &&
    Boolean(process.env.MAILGUN_SMTP_USER) &&
    Boolean(process.env.MAILGUN_SMTP_PASSWORD);
console.log("[mailgun-client] Mailgun config:", {
    MAILGUN_FROM_EMAIL: FROM_EMAIL ? "present" : "missing",
    MAILGUN_FROM_NAME: FROM_NAME ? "present" : "missing",
    MAILGUN_DOMAIN: DOMAIN ? "present" : "missing",
    MAILGUN_API_KEY: API_KEY ? "present" : "missing",
    SMTP_FALLBACK: SMTP_CONFIGURED ? "enabled" : "disabled",
});
if (!FROM_EMAIL || !API_KEY || !DOMAIN) {
    console.warn("[mailgun-client] MAILGUN config incomplete — sends may fail", {
        MAILGUN_FROM_EMAIL: FROM_EMAIL ? "present" : "missing",
        MAILGUN_API_KEY: API_KEY ? "present" : "missing",
        MAILGUN_DOMAIN: DOMAIN ? "present" : "missing",
    });
}
const buildFrom = () => {
    const rawName = String(FROM_NAME || "")
        .replace(/^["']|["']$/g, "")
        .trim();
    const cleaned = rawName
        .replace(/[\r\n\t]/g, " ")
        .replace(/["<>]/g, "")
        .replace(/,/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 64);
    const safeName = cleaned || "No Reply";
    const validEmail = typeof FROM_EMAIL === "string" &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(FROM_EMAIL.trim());
    const fromAddr = validEmail
        ? FROM_EMAIL.trim()
        : "invalid-from@example.invalid";
    return `"${safeName}" <${fromAddr}>`;
};
const isEmailValid = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
const sendMailgunEmail = async (opts) => {
    if (!isEmailValid(opts.to)) {
        const msg = `Invalid recipient email: "${opts.to}"`;
        console.error("[mailgun-client] " + msg);
        return { success: false, error: msg };
    }
    if (!isEmailValid(FROM_EMAIL)) {
        const msg = `Invalid MAILGUN_FROM_EMAIL: "${FROM_EMAIL}"`;
        console.error("[mailgun-client] " + msg);
        return { success: false, error: msg };
    }
    const fromHeader = buildFrom();
    // If API config missing, attempt SMTP fallback early
    if (!API_KEY || !DOMAIN) {
        const msg = "Mailgun API key or domain missing in environment";
        console.error("[mailgun-client] " + msg);
        if (SMTP_CONFIGURED) {
            console.warn("[mailgun-client] attempting SMTP fallback because API config is missing");
            try {
                const smtpRes = await (0, mailgun_smtp_1.sendViaSmtp)({
                    to: opts.to,
                    subject: opts.subject,
                    html: opts.html,
                    replyTo: opts.replyTo,
                    headers: opts.headers,
                    from: fromHeader,
                });
                const smtpMessageId = smtpRes?.info?.messageId || smtpRes?.info?.response || undefined;
                const smtpNormalized = typeof smtpMessageId === "string"
                    ? smtpMessageId.replace(/[<>]/g, "").trim()
                    : undefined;
                return {
                    success: true,
                    id: smtpMessageId,
                    messageId: smtpMessageId,
                    messageIdNormalized: smtpNormalized,
                };
            }
            catch (smtpErr) {
                return {
                    success: false,
                    error: `SMTP fallback failed: ${smtpErr?.message || smtpErr}`,
                };
            }
        }
        return { success: false, error: msg };
    }
    const url = `${BASE}/${DOMAIN}/messages`;
    const form = new URLSearchParams();
    form.append("from", fromHeader);
    form.append("to", opts.to);
    form.append("subject", opts.subject);
    form.append("html", opts.html);
    if (opts.replyTo)
        form.append("h:Reply-To", opts.replyTo);
    if (opts.headers) {
        for (const [k, v] of Object.entries(opts.headers)) {
            form.append(`h:${k}`, v);
        }
    }
    console.log("[mailgun-client] sending mailgun request", {
        url,
        from: fromHeader,
        to: opts.to,
        subject: opts.subject,
        replyTo: opts.replyTo,
    });
    try {
        const res = await axios_1.default.post(url, form.toString(), {
            auth: { username: "api", password: API_KEY },
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 20000,
        });
        // Mailgun usually returns: { id: "<...>", message: "Queued. Thank you." }
        const rawId = res.data?.id || res.data?.messageId || undefined;
        const normalizedId = typeof rawId === "string" ? rawId.replace(/[<>]/g, "").trim() : undefined;
        return {
            success: true,
            id: rawId,
            messageId: rawId,
            messageIdNormalized: normalizedId,
            message: res.data?.message || undefined,
        };
    }
    catch (err) {
        const responseData = err?.response?.data;
        let errString;
        try {
            if (typeof responseData === "string")
                errString = responseData;
            else if (responseData && typeof responseData === "object")
                errString = JSON.stringify(responseData);
            else
                errString = err?.message || String(err);
        }
        catch {
            errString = err?.message || "Unknown Mailgun error";
        }
        console.error("[mailgun-client] Mailgun API send error:", responseData || err?.message || err);
        // Try SMTP fallback if configured
        if (SMTP_CONFIGURED) {
            console.warn("[mailgun-client] Mailgun API failed; attempting SMTP fallback", { to: opts.to });
            try {
                const smtpRes = await (0, mailgun_smtp_1.sendViaSmtp)({
                    to: opts.to,
                    subject: opts.subject,
                    html: opts.html,
                    replyTo: opts.replyTo,
                    headers: opts.headers,
                    from: fromHeader,
                });
                const smtpMessageId = smtpRes?.info?.messageId || smtpRes?.info?.response || undefined;
                const smtpNormalized = typeof smtpMessageId === "string"
                    ? smtpMessageId.replace(/[<>]/g, "").trim()
                    : undefined;
                console.log("[mailgun-client] SMTP fallback succeeded", {
                    to: opts.to,
                    smtpMessageId,
                });
                return {
                    success: true,
                    id: smtpMessageId,
                    messageId: smtpMessageId,
                    messageIdNormalized: smtpNormalized,
                };
            }
            catch (smtpErr) {
                const smtpErrMsg = smtpErr?.message || String(smtpErr);
                console.error("[mailgun-client] SMTP fallback failed:", smtpErrMsg);
                return {
                    success: false,
                    error: `${errString} ; SMTP fallback: ${smtpErrMsg}`,
                };
            }
        }
        return { success: false, error: errString };
    }
};
exports.sendMailgunEmail = sendMailgunEmail;
exports.default = exports.sendMailgunEmail;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendMailgunEmail = void 0;
// lib/mailgun-client.ts
const axios_1 = __importDefault(require("axios"));
const API_KEY = process.env.MAILGUN_API_KEY;
const DOMAIN = process.env.MAILGUN_DOMAIN;
const BASE = process.env.MAILGUN_BASE_URL || "https://api.mailgun.net/v3";
const FROM_EMAIL = process.env.MAILGUN_FROM_EMAIL;
const FROM_NAME = process.env.MAILGUN_FROM_NAME || "Influencer CRM";
if (!FROM_EMAIL) {
    console.warn("[mailgun-client] MAILGUN_FROM_EMAIL not set — Mailgun sends will likely fail");
}
const buildFrom = () => {
    // Very basic email sanity check
    const validEmail = FROM_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(FROM_EMAIL);
    return `${FROM_NAME} <${FROM_EMAIL ?? "INVALID_FROM"}>`;
};
const sendMailgunEmail = async (opts) => {
    try {
        const url = `${BASE}/${DOMAIN}/messages`;
        const form = new URLSearchParams();
        form.append("from", buildFrom());
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
        const res = await axios_1.default.post(url, form.toString(), {
            auth: { username: "api", password: API_KEY },
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 20000,
        });
        return {
            success: true,
            id: res.data?.id,
            messageId: res.data?.message || undefined,
        };
    }
    catch (err) {
        // normalize error to a string before returning
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
        console.error("Mailgun send error:", responseData || err?.message || err);
        return {
            success: false,
            error: errString,
        };
    }
};
exports.sendMailgunEmail = sendMailgunEmail;

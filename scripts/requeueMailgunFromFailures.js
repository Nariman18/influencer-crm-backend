"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// scripts/requeueMailgunFromFailures.ts
require("dotenv/config");
const prisma_1 = __importDefault(require("../src/config/prisma"));
const redis_queue_1 = __importDefault(require("../src/lib/redis-queue"));
async function main() {
    console.log("[repair] looking for emails failed with Mailgun 'from' error...");
    const rows = await prisma_1.default.email.findMany({
        where: {
            status: "FAILED",
            errorMessage: {
                contains: "from parameter is not a valid address",
                mode: "insensitive",
            },
        },
        include: {
            sentBy: true,
            influencer: true,
        },
    });
    console.log("[repair] found", rows.length);
    for (const r of rows) {
        try {
            // normalize errorMessage to a string (if it was stored as JSON or unusual)
            const normalizedError = typeof r.errorMessage === "string"
                ? r.errorMessage
                : JSON.stringify(r.errorMessage);
            // Compute recipient ('to') from related influencer row (fallback: null)
            const toAddress = r.influencer?.email ?? null;
            if (!toAddress || typeof toAddress !== "string") {
                console.warn("[repair] skipping email record - no recipient address available:", r.id);
                continue;
            }
            // Compute replyTo: prefer the sender's googleEmail (if present), else fallback to MAILGUN_FROM_EMAIL
            const replyToAddress = r.sentBy?.googleEmail || process.env.MAILGUN_FROM_EMAIL || undefined;
            // Reset DB row so worker can reattempt
            await prisma_1.default.email.update({
                where: { id: r.id },
                data: {
                    status: "PENDING",
                    attemptCount: 0,
                    errorMessage: { set: null },
                },
            });
            // Requeue job with automation preserved
            await redis_queue_1.default.addEmailJob({
                userId: String(r.sentById),
                to: r.influencer?.email ?? "",
                subject: r.subject ?? "",
                body: r.body ?? "",
                influencerName: r.influencer?.name ?? "",
                emailRecordId: r.id,
                influencerId: r.influencerId ?? undefined,
                replyTo: r.sentBy?.googleEmail ?? process.env.MAILGUN_FROM_EMAIL,
                automation: r.isAutomation ? { start: true } : undefined,
            }, 1000);
            console.log("[repair] requeued", r.id, "to:", toAddress, "replyTo:", replyToAddress, "oldErrorPreview:", (normalizedError || "").substring(0, 200));
        }
        catch (err) {
            console.error("[repair] failed to requeue:", r.id, err);
        }
    }
    await prisma_1.default.$disconnect();
    console.log("[repair] done");
    process.exit(0);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});

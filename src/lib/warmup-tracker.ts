// src/lib/warmup-tracker.ts
import { getPrisma } from "../config/prisma";

const prisma = getPrisma();

/**
 * Get the daily limit from environment variable
 */
export const getDailyLimit = (): number => {
  const warmupEnabled = process.env.WARMUP_ENABLED === "true";

  if (!warmupEnabled) {
    return 999999; // No limit when warm-up disabled
  }

  const limit = Number(process.env.WARMUP_DAILY_LIMIT) || 80;
  return limit;
};

/**
 * Count how many emails have been sent/queued today
 */
export const getEmailsSentToday = async (): Promise<number> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const count = await prisma.email.count({
    where: {
      createdAt: { gte: today },
      status: { in: ["SENT", "PENDING"] },
    },
  });

  return count;
};

/**
 * Check if we can send more emails
 */
export const canSendMore = async (
  requestedCount: number
): Promise<{
  allowed: boolean;
  sent: number;
  limit: number;
  remaining: number;
  message?: string;
}> => {
  const limit = getDailyLimit();
  const sent = await getEmailsSentToday();
  const remaining = Math.max(0, limit - sent);

  if (sent >= limit) {
    return {
      allowed: false,
      sent,
      limit,
      remaining: 0,
      message: `Daily limit reached: ${sent}/${limit} emails sent today. Please try again tomorrow.`,
    };
  }

  if (sent + requestedCount > limit) {
    return {
      allowed: false,
      sent,
      limit,
      remaining,
      message: `Cannot send ${requestedCount} emails. Only ${remaining} emails remaining today (${sent}/${limit} already sent).`,
    };
  }

  return {
    allowed: true,
    sent,
    limit,
    remaining: remaining - requestedCount,
  };
};

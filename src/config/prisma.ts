// src/config/prisma.ts
import { PrismaClient } from "@prisma/client";

/**
 * Defensive Prisma client initializer.
 *
 * - Augments NodeJS.Global to avoid implicit-any on __prismaClient.
 * - Lazy-init so importing this module doesn't create Prisma immediately.
 * - Logs whether DATABASE_URL was present when client is created.
 */

// Augment the NodeJS Global interface (TypeScript-friendly)
declare global {
  namespace NodeJS {
    interface Global {
      __prismaClient?: PrismaClient;
    }
  }
}

// Helper to create a new PrismaClient with sensible options
function createPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL) {
    console.error(
      "🔴 Prisma: process.env.DATABASE_URL is NOT set when creating PrismaClient. " +
        "If you rely on dotenv, ensure it is loaded before Prisma is used. " +
        "Continuing to create client (may fail on DB access)."
    );
  } else {
    console.log(
      "🟢 Prisma: creating PrismaClient — DATABASE_URL prefix:",
      String(process.env.DATABASE_URL).slice(0, 80)
    );
  }

  return new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["error"]
        : ["query", "error", "warn"],
    errorFormat: "minimal",
  });
}

// Exported getter that ensures a single shared Prisma client across reloads
export function getPrisma(): PrismaClient {
  const g = global as unknown as NodeJS.Global;
  if (!g.__prismaClient) {
    g.__prismaClient = createPrismaClient();
  }
  return g.__prismaClient!;
}

// Default export for convenience (so existing imports like `import prisma from "../config/prisma"` still work)
export default getPrisma();

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPrisma = getPrisma;
// src/config/prisma.ts
const client_1 = require("@prisma/client");
// Helper to create a new PrismaClient with sensible options
function createPrismaClient() {
    if (!process.env.DATABASE_URL) {
        console.error("🔴 Prisma: process.env.DATABASE_URL is NOT set when creating PrismaClient. " +
            "If you rely on dotenv, ensure it is loaded before Prisma is used. " +
            "Continuing to create client (may fail on DB access).");
    }
    else {
        console.log("🟢 Prisma: creating PrismaClient — DATABASE_URL prefix:", String(process.env.DATABASE_URL).slice(0, 80));
    }
    return new client_1.PrismaClient({
        log: process.env.NODE_ENV === "development"
            ? ["error"]
            : ["query", "error", "warn"],
        errorFormat: "minimal",
    });
}
// Exported getter that ensures a single shared Prisma client across reloads
function getPrisma() {
    const g = global;
    if (!g.__prismaClient) {
        g.__prismaClient = createPrismaClient();
    }
    return g.__prismaClient;
}
// Default export for convenience and to prevent early Prisma creation and no longer exports the client object directly (so existing imports like `import prisma from "../config/prisma"` still work)
exports.default = getPrisma();

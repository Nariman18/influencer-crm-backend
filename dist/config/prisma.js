"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient({
    log: process.env.NODE_ENV === "production"
        ? ["error"]
        : ["query", "error", "warn"],
    errorFormat: "minimal",
});
exports.default = prisma;

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  log:
    process.env.NODE_ENV === "development"
      ? ["error"]
      : ["query", "error", "warn"],
  errorFormat: "minimal",
});

export default prisma;

// scripts/delete-all-influencers.js
// Safely delete all influencers and dependent rows using Prisma.
// Usage (local dev):
//   DOTENV approach: node -r dotenv/config scripts/delete-all-influencers.js
//   or if you store env in .env.server: dotenv -e .env.server -- node scripts/delete-all-influencers.js

require("dotenv").config();
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
  console.log("Starting cleanup of influencers and dependent records...");

  try {
    // NOTE: we run deleteMany in a transaction to avoid partial cleanup.
    // Adjust ordering if you want different behavior. This deletes ALL rows in the listed tables.
    await prisma.$transaction([
      // Remove emails (these reference influencers)
      prisma.email.deleteMany({ where: {} }),

      // Remove join table entries that reference influencers
      prisma.campaignInfluencer.deleteMany({ where: {} }),

      // Remove contracts referencing influencers
      prisma.contract.deleteMany({ where: {} }),
    ]);

    // Now remove influencers themselves
    const result = await prisma.influencer.deleteMany({ where: {} });
    console.log("Deleted influencers count:", result.count);

    console.log("Cleanup completed successfully.");
  } catch (err) {
    console.error("Error while cleaning up influencers:", err);
    process.exitCode = 1;
  } finally {
    try {
      await prisma.$disconnect();
    } catch (e) {
      // ignore disconnect error
    }
  }
}

main();

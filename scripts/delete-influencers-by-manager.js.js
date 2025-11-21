import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TARGET_MANAGER_ID = "c23fa930-b7d4-4bb4-a254-b389efe5dc17";

async function main() {
  console.log("Starting cleanup for manager:", TARGET_MANAGER_ID);

  // Fetch influencers of that manager
  const influencers = await prisma.influencer.findMany({
    where: { managerId: TARGET_MANAGER_ID },
    select: { id: true },
  });

  if (influencers.length === 0) {
    console.log("No influencers found for this manager.");
    return;
  }

  const influencerIds = influencers.map((i) => i.id);
  console.log(`Found ${influencerIds.length} influencers.`);

  await prisma.$transaction([
    // Delete emails linked to these influencers
    prisma.email.deleteMany({
      where: { influencerId: { in: influencerIds } },
    }),

    // Delete campaign join rows linked to these influencers
    prisma.campaignInfluencer.deleteMany({
      where: { influencerId: { in: influencerIds } },
    }),

    // Delete contracts linked to these influencers
    prisma.contract.deleteMany({
      where: { influencerId: { in: influencerIds } },
    }),

    // Delete influencers
    prisma.influencer.deleteMany({
      where: { id: { in: influencerIds } },
    }),
  ]);

  console.log("Deletion completed successfully.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Script failed:", e);
  process.exit(1);
});

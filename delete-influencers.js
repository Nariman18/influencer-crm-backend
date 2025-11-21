// delete-influencers.js
/**
 * Usage:
 *  node delete-influencers.js --managerId=<USER_ID> [--status=PING_1] [--dryRun] --yes
 *  OR
 *  node delete-influencers.js --managerEmail=manager@company.com --status=PING_1 --yes
 *
 * Notes:
 *  - The script finds influencer IDs from the `email` table where sentById == managerId
 *    (this covers the "manager made initial bulk sends" scenario).
 *  - It then optionally filters those influencers by status (e.g. PING_1).
 *  - It deletes related emails first, then influencers.
 *  - Use --yes to actually run deletion; otherwise it's a dry run.
 */

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  args.forEach((a) => {
    const [k, v] = a.startsWith("--") ? a.slice(2).split("=") : [null, null];
    if (k) out[k] = v === undefined ? true : v;
  });
  return out;
}

(async () => {
  const argv = parseArgs();
  const managerId = argv.managerId;
  const managerEmail = argv.managerEmail;
  const statusFilter = argv.status; // e.g. "PING_1"
  const doYes = !!argv.yes; // must be present to actually delete
  const dryRunFlag = argv.dryRun || !doYes;

  try {
    let managerUserId = managerId;

    if (!managerUserId && !managerEmail) {
      console.error(
        "ERROR: must provide either --managerId=<USER_ID> or --managerEmail=<EMAIL>"
      );
      process.exit(2);
    }

    if (!managerUserId && managerEmail) {
      const user = await prisma.user.findUnique({
        where: { email: managerEmail },
        select: { id: true, email: true },
      });
      if (!user) {
        console.error(`ERROR: no user found with email ${managerEmail}`);
        process.exit(3);
      }
      managerUserId = user.id;
      console.log(
        `Found manager user id ${managerUserId} for email ${managerEmail}`
      );
    }

    console.log(
      "Gathering influencer IDs from emails sent by manager:",
      managerUserId
    );

    // find influencer ids referenced by emails sent by this manager
    const emailRows = await prisma.email.findMany({
      where: { sentById: managerUserId },
      select: { influencerId: true },
      distinct: ["influencerId"],
    });

    const influencerIdsFromEmails = Array.from(
      new Set(emailRows.map((r) => r.influencerId).filter(Boolean))
    );

    if (influencerIdsFromEmails.length === 0) {
      console.log(
        "No influencer IDs found in emails sent by this manager. Nothing to delete."
      );
      process.exit(0);
    }

    console.log(
      `Found ${influencerIdsFromEmails.length} influencerIds referenced in emails.`
    );

    // optionally restrict to influencers with a specific status
    const influencerWhere = {
      id: { in: influencerIdsFromEmails },
      ...(statusFilter ? { status: statusFilter } : {}),
    };

    const influencers = await prisma.influencer.findMany({
      where: influencerWhere,
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        lastContactDate: true,
      },
    });

    if (influencers.length === 0) {
      console.log(
        `No influencers matched the criteria (manager's emailed influencers${
          statusFilter ? ` + status=${statusFilter}` : ""
        }). Nothing to delete.`
      );
      process.exit(0);
    }

    console.log(
      `Would delete ${influencers.length} influencers (matching criteria):`
    );
    influencers.slice(0, 50).forEach((inf, idx) => {
      console.log(
        `${idx + 1}. id=${inf.id} name=${inf.name} email=${inf.email} status=${
          inf.status
        }`
      );
    });
    if (influencers.length > 50) {
      console.log(`... and ${influencers.length - 50} more`);
    }

    // show counts of related emails (for info)
    const emailsCount = await prisma.email.count({
      where: { influencerId: { in: influencers.map((i) => i.id) } },
    });

    console.log(`Related email records to be deleted: ${emailsCount}`);

    if (dryRunFlag) {
      console.log(
        "Dry run (no deletion). Re-run with --yes to perform deletion. Example:\n" +
          "  node delete-influencers.js --managerId=USER_ID --status=PING_1 --yes"
      );
      process.exit(0);
    }

    // Confirmation already required by --yes; proceed to delete
    console.log("Deleting related emails first...");

    const deleteEmailsResult = await prisma.email.deleteMany({
      where: { influencerId: { in: influencers.map((i) => i.id) } },
    });

    console.log(`Deleted ${deleteEmailsResult.count} email rows.`);

    console.log("Deleting influencers...");

    const deleteInfluencersResult = await prisma.influencer.deleteMany({
      where: { id: { in: influencers.map((i) => i.id) } },
    });

    console.log(`Deleted ${deleteInfluencersResult.count} influencer rows.`);

    console.log("Done. Consider vacuuming / optimizing DB if needed.");

    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Fatal error during deletion script:", err);
    try {
      await prisma.$disconnect();
    } catch (_) {}
    process.exit(1);
  }
})();

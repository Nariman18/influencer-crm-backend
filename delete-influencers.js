#!/usr/bin/env node
/**
 * delete-influencers.js
 *
 * Usage examples:
 *  # Dry run - show what would be deleted for a single manager:
 *  node delete-influencers.js --managerId=4b4fbe80-90c5-46d1-863f-95119cf29a16
 *
 *  # Actually delete ALL influencers for a single manager:
 *  node delete-influencers.js --managerId=4b4fbe80-90c5-46d1-863f-95119cf29a16 --all --yes
 *
 *  # Delete influencers (any status) for multiple managers (comma-separated):
 *  node delete-influencers.js --managerIds=ID1,ID2,ID3 --all --yes
 *
 *  # Use emails instead of ids:
 *  node delete-influencers.js --managerEmail=manager@company.com --all --yes
 *
 *  # Filter by status (only delete those with status):
 *  node delete-influencers.js --managerId=... --status=PING_1 --yes
 *
 * Notes:
 *  - By default script runs in dry-run mode. Add --yes to actually delete.
 *  - Use --all to delete all influencers belonging to the manager(s).
 *    If --all is not provided, the script will find influencers referenced by
 *    email records sent by the manager (same as your previous script).
 */

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

function parseArgs() {
  const argv = process.argv.slice(2);
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [rawKey, ...rest] = raw.slice(2).split("=");
    const key = rawKey;
    const value = rest.length ? rest.join("=") : true;

    // normalize: allow repeated keys and comma-separated lists
    if (key === "managerId" || key === "managerIds") {
      const ids = (Array.isArray(out.managerIds) ? out.managerIds : []).slice();
      const newIds = String(value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      out.managerIds = Array.from(new Set(ids.concat(newIds)));
      continue;
    }

    if (key === "managerEmail" || key === "managerEmails") {
      const emails = (
        Array.isArray(out.managerEmails) ? out.managerEmails : []
      ).slice();
      const newEmails = String(value)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      out.managerEmails = Array.from(new Set(emails.concat(newEmails)));
      continue;
    }

    out[key] = value === "true" ? true : value === "false" ? false : value;
  }
  return out;
}

(async () => {
  const argv = parseArgs();
  const doYes = !!argv.yes;
  const dryRun = !!argv.dryRun || !doYes;
  const statusFilter = argv.status || null;
  const deleteAllFlag = !!argv.all;

  let managerIds = Array.isArray(argv.managerIds) ? argv.managerIds : [];
  const managerEmails = Array.isArray(argv.managerEmails)
    ? argv.managerEmails
    : [];

  try {
    if (managerEmails.length === 0 && managerIds.length === 0) {
      console.error(
        "ERROR: Provide --managerId or --managerIds or --managerEmail(s)."
      );
      process.exit(2);
    }

    // Resolve manager emails to ids if provided
    if (managerEmails.length > 0) {
      const users = await prisma.user.findMany({
        where: { email: { in: managerEmails } },
        select: { id: true, email: true },
      });
      const found = users.map((u) => u.id);
      if (found.length !== managerEmails.length) {
        const foundEmails = new Set(users.map((u) => u.email));
        const missing = managerEmails.filter((e) => !foundEmails.has(e));
        console.warn("Warning: some manager emails not found:", missing);
      }
      managerIds = Array.from(new Set(managerIds.concat(found)));
    }

    if (managerIds.length === 0) {
      console.error("ERROR: No manager IDs resolved. Aborting.");
      process.exit(3);
    }

    console.log("Manager IDs to operate on:", managerIds);

    // Build influencer filter based on flags
    let influencerWhere;
    if (deleteAllFlag) {
      influencerWhere = { managerId: { in: managerIds } };
      if (statusFilter) influencerWhere.status = statusFilter;
    } else {
      // original behavior: only influencers referenced by emails sent by manager(s)
      const emailRows = await prisma.email.findMany({
        where: { sentById: { in: managerIds } },
        select: { influencerId: true },
        distinct: ["influencerId"],
      });
      const influencerIdsFromEmails = Array.from(
        new Set(emailRows.map((r) => r.influencerId).filter(Boolean))
      );
      if (influencerIdsFromEmails.length === 0) {
        console.log(
          "No influencer IDs found in emails sent by these manager(s). Nothing to delete."
        );
        process.exit(0);
      }
      influencerWhere = { id: { in: influencerIdsFromEmails } };
      if (statusFilter) influencerWhere.status = statusFilter;
    }

    // get influencers matching criteria
    const influencers = await prisma.influencer.findMany({
      where: influencerWhere,
      select: {
        id: true,
        name: true,
        email: true,
        status: true,
        managerId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!influencers || influencers.length === 0) {
      console.log("No influencers matched the criteria. Nothing to delete.");
      process.exit(0);
    }

    console.log(`Matched influencers: ${influencers.length}`);
    influencers.slice(0, 50).forEach((inf, i) => {
      console.log(
        `${i + 1}. id=${inf.id} name=${inf.name || "<no-name>"} email=${
          inf.email || "<no-email>"
        } status=${inf.status} managerId=${inf.managerId}`
      );
    });
    if (influencers.length > 50) {
      console.log(`... and ${influencers.length - 50} more`);
    }

    const influencerIds = influencers.map((i) => i.id);

    const emailCount = await prisma.email.count({
      where: { influencerId: { in: influencerIds } },
    });
    console.log(`Related email records that would be deleted: ${emailCount}`);

    if (dryRun) {
      console.log(
        "DRY RUN: No deletion performed. Re-run with --yes to execute the deletion."
      );
      console.log("Example (delete all influencers for managers):");
      console.log(
        "  node delete-influencers.js --managerIds=" +
          managerIds.join(",") +
          " --all --yes"
      );
      process.exit(0);
    }

    // Perform deletes inside transaction for consistency
    console.log("Performing deletion (emails first, then influencers)...");
    const results = await prisma.$transaction([
      prisma.email.deleteMany({
        where: { influencerId: { in: influencerIds } },
      }),
      prisma.influencer.deleteMany({ where: { id: { in: influencerIds } } }),
    ]);

    // results is an array with counts: [ { count: nEmailsDeleted }, { count: nInfluencersDeleted } ]
    const deletedEmails =
      results[0] && results[0].count != null ? results[0].count : results[0];
    const deletedInfluencers =
      results[1] && results[1].count != null ? results[1].count : results[1];

    console.log(`Deleted emails: ${deletedEmails}`);
    console.log(`Deleted influencers: ${deletedInfluencers}`);
    console.log("Deletion complete.");

    await prisma.$disconnect();
    process.exit(0);
  } catch (err) {
    console.error("Fatal error:", err && err.message ? err.message : err);
    try {
      await prisma.$disconnect();
    } catch (_) {}
    process.exit(1);
  }
})();

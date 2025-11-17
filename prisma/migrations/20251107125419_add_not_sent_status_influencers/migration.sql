/*
  Warnings:

  - The values [NEW] on the enum `InfluencerStatus` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "InfluencerStatus_new" AS ENUM ('NOT_SENT', 'PING_1', 'PING_2', 'PING_3', 'CONTRACT', 'REJECTED', 'COMPLETED');
ALTER TABLE "public"."influencers" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "influencers" ALTER COLUMN "status" TYPE "InfluencerStatus_new" USING ("status"::text::"InfluencerStatus_new");
ALTER TYPE "InfluencerStatus" RENAME TO "InfluencerStatus_old";
ALTER TYPE "InfluencerStatus_new" RENAME TO "InfluencerStatus";
DROP TYPE "public"."InfluencerStatus_old";
ALTER TABLE "influencers" ALTER COLUMN "status" SET DEFAULT 'PING_1';
COMMIT;

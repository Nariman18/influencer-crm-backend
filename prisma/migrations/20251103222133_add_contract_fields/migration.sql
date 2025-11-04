/*
  Warnings:

  - You are about to drop the column `averageViews` on the `influencers` table. All the data in the column will be lost.
  - You are about to drop the column `contactMethod` on the `influencers` table. All the data in the column will be lost.
  - You are about to drop the column `engagementCount` on the `influencers` table. All the data in the column will be lost.
  - You are about to drop the column `link` on the `influencers` table. All the data in the column will be lost.
  - You are about to drop the column `managerComment` on the `influencers` table. All the data in the column will be lost.
  - You are about to drop the column `nickname` on the `influencers` table. All the data in the column will be lost.
  - You are about to drop the column `paymentMethod` on the `influencers` table. All the data in the column will be lost.
  - You are about to drop the column `priceEUR` on the `influencers` table. All the data in the column will be lost.
  - You are about to drop the column `priceUSD` on the `influencers` table. All the data in the column will be lost.
  - You are about to drop the column `statistics` on the `influencers` table. All the data in the column will be lost.
  - You are about to drop the column `storyViews` on the `influencers` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "averageViews" TEXT,
ADD COLUMN     "contactMethod" TEXT,
ADD COLUMN     "engagementCount" TEXT,
ADD COLUMN     "link" TEXT,
ADD COLUMN     "managerComment" TEXT,
ADD COLUMN     "nickname" TEXT,
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "statistics" TEXT,
ADD COLUMN     "storyViews" TEXT;

-- AlterTable
ALTER TABLE "influencers" DROP COLUMN "averageViews",
DROP COLUMN "contactMethod",
DROP COLUMN "engagementCount",
DROP COLUMN "link",
DROP COLUMN "managerComment",
DROP COLUMN "nickname",
DROP COLUMN "paymentMethod",
DROP COLUMN "priceEUR",
DROP COLUMN "priceUSD",
DROP COLUMN "statistics",
DROP COLUMN "storyViews";

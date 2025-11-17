/*
  Warnings:

  - A unique constraint covering the columns `[messageId]` on the table `emails` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "emails" ADD COLUMN     "inReplyTo" TEXT,
ADD COLUMN     "isAutoResponse" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastReminderSent" TIMESTAMP(3),
ADD COLUMN     "messageId" TEXT,
ADD COLUMN     "reminderCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "threadId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "emails_messageId_key" ON "emails"("messageId");

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_inReplyTo_fkey" FOREIGN KEY ("inReplyTo") REFERENCES "emails"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "scheduled_transitions" (
    "id" TEXT NOT NULL,
    "influencerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetStatus" "InfluencerStatus" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "jobId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_transitions_jobId_key" ON "scheduled_transitions"("jobId");

-- AddForeignKey
ALTER TABLE "scheduled_transitions" ADD CONSTRAINT "scheduled_transitions_influencerId_fkey" FOREIGN KEY ("influencerId") REFERENCES "influencers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_transitions" ADD CONSTRAINT "scheduled_transitions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

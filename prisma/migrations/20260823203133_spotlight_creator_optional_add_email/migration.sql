-- CreateTable
CREATE TABLE "SpotlightCycle" (
    "id" TEXT NOT NULL,
    "monthLabel" TEXT NOT NULL,
    "heroImageUrl" TEXT,
    "heroHeadline" TEXT,
    "heroDescription" TEXT,
    "submissionOpensAt" TIMESTAMP(3) NOT NULL,
    "submissionDeadline" TIMESTAMP(3) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpotlightCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpotlightSubmission" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "creatorId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "projectLink" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "note" TEXT,
    "isShortlisted" BOOLEAN NOT NULL DEFAULT false,
    "rank" INTEGER,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpotlightSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpotlightCycle_isActive_idx" ON "SpotlightCycle"("isActive");

-- CreateIndex
CREATE INDEX "SpotlightSubmission_cycleId_idx" ON "SpotlightSubmission"("cycleId");

-- CreateIndex
CREATE INDEX "SpotlightSubmission_cycleId_rank_idx" ON "SpotlightSubmission"("cycleId", "rank");

-- AddForeignKey
ALTER TABLE "SpotlightSubmission" ADD CONSTRAINT "SpotlightSubmission_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "SpotlightCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpotlightSubmission" ADD CONSTRAINT "SpotlightSubmission_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

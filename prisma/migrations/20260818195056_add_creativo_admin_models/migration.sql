-- AlterTable
ALTER TABLE "PlatformSettings" ADD COLUMN     "creativoMemberCountLabel" TEXT;

-- CreateTable
CREATE TABLE "CreativoLeaderboardEntry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "profileImageUrl" TEXT,
    "category" TEXT NOT NULL,
    "whatTheyDo" TEXT,
    "contact" TEXT,
    "wonFor" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "periodDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativoLeaderboardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreativoWebinar" (
    "id" TEXT NOT NULL,
    "flyerImageUrl" TEXT,
    "topic" TEXT NOT NULL,
    "guests" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "venue" TEXT,
    "applyUrl" TEXT,
    "replayUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreativoWebinar_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreativoLeaderboardEntry_category_periodDate_idx" ON "CreativoLeaderboardEntry"("category", "periodDate");

-- CreateIndex
CREATE INDEX "CreativoWebinar_startsAt_idx" ON "CreativoWebinar"("startsAt");

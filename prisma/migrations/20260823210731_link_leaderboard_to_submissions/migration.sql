/*
  Warnings:

  - A unique constraint covering the columns `[sourceSubmissionId]` on the table `CreativoLeaderboardEntry` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "CreativoLeaderboardEntry" ADD COLUMN     "sourceSubmissionId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CreativoLeaderboardEntry_sourceSubmissionId_key" ON "CreativoLeaderboardEntry"("sourceSubmissionId");

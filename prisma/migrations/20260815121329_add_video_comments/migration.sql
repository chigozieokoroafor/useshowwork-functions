/*
  Warnings:

  - You are about to drop the column `videoTimestampSeconds` on the `MediaReview` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "MediaReview" DROP COLUMN "videoTimestampSeconds";

-- CreateTable
CREATE TABLE "VideoComment" (
    "id" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "reviewerName" TEXT,
    "reviewerEmail" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "videoTimestampSeconds" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VideoComment_mediaId_idx" ON "VideoComment"("mediaId");

-- AddForeignKey
ALTER TABLE "VideoComment" ADD CONSTRAINT "VideoComment_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

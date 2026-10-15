/*
  Warnings:

  - You are about to drop the column `fileKey` on the `CalendarPost` table. All the data in the column will be lost.
  - You are about to drop the column `mediaType` on the `CalendarPost` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "CalendarPost" DROP COLUMN "fileKey",
DROP COLUMN "mediaType";

-- CreateTable
CREATE TABLE "CalendarPostAsset" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "mediaType" "MediaType" NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarPostAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CalendarPostAsset_postId_idx" ON "CalendarPostAsset"("postId");

-- AddForeignKey
ALTER TABLE "CalendarPostAsset" ADD CONSTRAINT "CalendarPostAsset_postId_fkey" FOREIGN KEY ("postId") REFERENCES "CalendarPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

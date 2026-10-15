-- AlterTable
ALTER TABLE "ViewerEmail" ADD COLUMN     "name" TEXT;

-- CreateTable
CREATE TABLE "MediaReview" (
    "id" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "reviewerName" TEXT,
    "reviewerEmail" TEXT NOT NULL,
    "status" "ApprovalStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaReview_mediaId_idx" ON "MediaReview"("mediaId");

-- AddForeignKey
ALTER TABLE "MediaReview" ADD CONSTRAINT "MediaReview_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "Media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

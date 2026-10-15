-- Give the new required column a starting value for existing rows
ALTER TABLE "MediaReview" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Remove duplicate reviews from the same person on the same file,
-- keeping only their most recent actual verdict (by createdAt) —
-- this is what makes the unique constraint below possible to add
DELETE FROM "MediaReview" a
USING "MediaReview" b
WHERE a."mediaId" = b."mediaId"
  AND a."reviewerEmail" = b."reviewerEmail"
  AND a."createdAt" < b."createdAt";

-- CreateIndex
CREATE UNIQUE INDEX "MediaReview_mediaId_reviewerEmail_key" ON "MediaReview"("mediaId", "reviewerEmail");
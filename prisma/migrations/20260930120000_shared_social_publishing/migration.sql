ALTER TABLE "CalendarPost"
ADD COLUMN "publishStatus" "InstagramPublishStatus" NOT NULL DEFAULT 'NOT_SCHEDULED',
ADD COLUMN "publishedAt" TIMESTAMP(3),
ADD COLUMN "platformPostId" TEXT,
ADD COLUMN "publishPermalink" TEXT,
ADD COLUMN "publishError" TEXT;
CREATE INDEX "CalendarPost_publishStatus_postDate_idx" ON "CalendarPost"("publishStatus", "postDate");
ALTER TABLE "SocialConnection"
ADD COLUMN "messagingLastSyncAt" TIMESTAMP(3),
ADD COLUMN "messagingSyncError" TEXT;

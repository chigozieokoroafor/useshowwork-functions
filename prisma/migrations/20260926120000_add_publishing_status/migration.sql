ALTER TYPE "InstagramPublishStatus" ADD VALUE 'PUBLISHING';
ALTER TYPE "TikTokPublishStatus" ADD VALUE 'PUBLISHING';

ALTER TABLE "CalendarPost" ADD COLUMN "publishWorkerStartedAt" TIMESTAMP(3);

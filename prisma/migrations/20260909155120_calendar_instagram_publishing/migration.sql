-- CreateEnum
CREATE TYPE "InstagramPublishStatus" AS ENUM ('NOT_SCHEDULED', 'SCHEDULED', 'PUBLISHED', 'FAILED');

-- AlterTable
ALTER TABLE "CalendarPost" ADD COLUMN     "instagramMediaId" TEXT,
ADD COLUMN     "instagramPermalink" TEXT,
ADD COLUMN     "instagramPublishError" TEXT,
ADD COLUMN     "instagramPublishStatus" "InstagramPublishStatus" NOT NULL DEFAULT 'NOT_SCHEDULED',
ADD COLUMN     "instagramPublishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SocialCalendar" ADD COLUMN     "instagramAccessToken" TEXT,
ADD COLUMN     "instagramAccountId" TEXT,
ADD COLUMN     "instagramConnectedAt" TIMESTAMP(3),
ADD COLUMN     "instagramPageId" TEXT,
ADD COLUMN     "instagramTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "instagramUsername" TEXT;
